import { NextResponse } from "next/server";
import { getUniversities } from "../../lib/supabase";
import type { ExchangeProgram, University } from "../../lib/types";
import { createEvidencePacket } from "../../lib/chat/evidence-packet";
import { runSolarPlanner, type PlannerRun, type QueryPlan } from "../../lib/chat/query-plan";
import { runSolarReasoner } from "../../lib/chat/reasoner";
import { universityNamesFromAliases } from "../../lib/chat/university-aliases";
import {
  compareIsoDate,
  findCardsMissingFromAnswer,
  isPromptInjectionRequest,
  parseDeadlineDateConstraint,
  type DateComparator,
} from "../../lib/chat/chat-policy";
import {
  NUMBEO_SNAPSHOT_DATE,
  costIndexCountry,
  costIndexCountryLabel,
  costOfLivingIndex,
  loadCostOfLivingSnapshot,
} from "../../lib/cost-of-living";
import {
  presentConditionCheck,
  presentCost,
  presentDeadline,
  presentHousingGuarantee,
  presentHousingRow,
  presentLanguage,
} from "../../lib/display/present-fact";

export const runtime = "nodejs";

const MAX_MESSAGES = 8;
const MAX_MESSAGE_LENGTH = 2000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_REQUESTS = 10;

const requestBuckets = new Map<string, { count: number; resetAt: number }>();

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type ChatSource = {
  fact_id?: string;
  title: string;
  url: string;
  university_name?: string;
  source_type?: string;
  is_official?: boolean;
  field_key?: string;
  evidence_quote?: string;
};

type ResultCard = {
  university_id: string;
  university_name: string;
  country: string;
  city: string;
  summary: string;
  badges: string[];
  highlights: string[];
  action_label: string;
  action_url: string;
  source_url?: string;
  source_title?: string;
  source_type?: string;
  source_fact_id?: string;
  source_field_key?: string;
  evidence_quote?: string;
  fact_bundle?: FactEvidence[];
  match_status?: "matched" | "partial";
  condition_checks?: ConditionCheck[];
  unknown_fields?: string[];
};

type ConditionState = "met" | "unknown" | "failed";

type ConditionCheck = {
  key: string;
  label: string;
  state: ConditionState;
  detail: string;
};

type EvaluatedUniversity = {
  university: University;
  checks: ConditionCheck[];
  status: "matched" | "partial" | "excluded";
};

type Intent = "housing" | "language" | "cost" | "deadline" | "quota" | "restriction" | "source" | "general";

type QuotaMode = "minimum" | "exists" | "missing" | "sort_desc";
type DeadlineSemester = "autumn" | "spring";
type DeadlineType = "application" | "nomination";

type QueryConstraints = {
  intent: Intent;
  topN: number;
  requireEurope: boolean;
  requireAsia: boolean;
  requireAmericas: boolean;
  inScope: boolean;
  requireHousing: boolean;
  requireHousingGuaranteed: boolean;
  requireAll: boolean;
  requireOfficialSource: boolean;
  requireClearCost: boolean;
  countries: string[];
  excludedCountries: string[];
  excludeAsia: boolean;
  languageTest?: string;
  languageScore?: number;
  languageSubscore?: number;
  budgetKrwSemester?: number;
  gpa?: number;
  major?: string;
  quotaMin?: number;
  quotaMode?: QuotaMode;
  requireGpaKnown?: boolean;
  sortGpaLowest?: boolean;
  requireQuotaKnown?: boolean;
  requireHousingMissing?: boolean;
  sortDeadlineEarliest?: boolean;
  deadlineAcademicYear?: number;
  deadlineSemester?: DeadlineSemester;
  deadlineType?: DeadlineType;
  deadlineSpringOnly?: boolean;
  deadlineRequireClearYear?: boolean;
  deadlineComparator?: DateComparator;
  deadlineDate?: string;
  unsupportedReason?: "cost_of_living_index";
  requestedFields: string[];
};

type CostComponent = {
  category: "tuition" | "housing" | "living";
  krw: number;
  label: string;
  row: Record<string, unknown>;
  source?: ChatSource;
};

type CostEstimate = {
  normalizedKrw: number;
  label: string;
  sourceUrl?: string;
  sourceTitle?: string;
  sourceType?: string;
  evidenceQuote?: string;
  categoryCount: number;
  components: CostComponent[];
};

type RankedCandidate = {
  university: University;
  score: number;
  cost?: CostEstimate;
};

type FactEvidence = {
  fact_id?: string;
  table: string;
  field_key: string;
  label: string;
  value: string;
  source_url?: string;
  source_title?: string;
  source_type?: string;
  evidence_quote?: string;
  confidence?: unknown;
  review_status?: unknown;
};

type FactTableBundle = {
  costs: Record<string, unknown>[];
  housing: Record<string, unknown>[];
  languages: Record<string, unknown>[];
  deadlines: Record<string, unknown>[];
  quotas: Record<string, unknown>[];
};

const EUROPE_COUNTRIES = new Set(
  [
    "Austria",
    "Belgium",
    "Denmark",
    "Finland",
    "France",
    "Germany",
    "Italy",
    "Netherlands",
    "Norway",
    "Portugal",
    "Spain",
    "Sweden",
    "Switzerland",
    "United Kingdom",
    "UK",
    "England",
    "Scotland",
    "Ireland",
    "Czech Republic",
    "Poland",
    "Greece",
    "Hungary",
  ].map(normalizeSearchText),
);

const ASIA_COUNTRIES = new Set([
  "china", "hong kong", "india", "indonesia", "japan", "malaysia", "mongolia", "philippines",
  "singapore", "south korea", "korea", "taiwan", "thailand", "turkey", "vietnam",
]);

const AMERICAS_COUNTRIES = new Set([
  "argentina", "brazil", "canada", "chile", "colombia", "ecuador", "mexico", "peru",
  "united states", "usa", "united states of america",
]);

// No registered exchange partner is ever "South Korea" (this lists SKKU's
// outbound partners, not domestic universities), so matching "한국"/"Korea"
// here as an include/exclude country filter can only ever zero out results --
// e.g. "한국 학생이 지원하기 좋은 유럽 대학" would set countries: ["South Korea"]
// and, combined with requireEurope, guarantee 0 matches. "한국" in a question
// almost always means "compared to Korea" (the cost-of-living baseline) or
// "as a Korean student", never "a university located in Korea". Left out of
// this list entirely rather than filtered post hoc, so it can't leak into
// constraints.countries anywhere it's used.
const COUNTRY_ALIASES: Array<{ country: string; patterns: RegExp[] }> = [
  { country: "France", patterns: [/프랑스/, /france|french/] },
  { country: "Germany", patterns: [/독일/, /germany|german/] },
  { country: "Austria", patterns: [/오스트리아/, /austria/] },
  { country: "Finland", patterns: [/핀란드/, /finland|finnish/] },
  { country: "Belgium", patterns: [/벨기에/, /belgium|belgian/] },
  { country: "Italy", patterns: [/이탈리아/, /italy|italian/] },
  { country: "United Kingdom", patterns: [/영국/, /united kingdom|\buk\b|britain|england/] },
  { country: "Denmark", patterns: [/덴마크/, /denmark|danish/] },
  { country: "Canada", patterns: [/캐나다/, /canada|canadian/] },
  { country: "Singapore", patterns: [/싱가포르/, /singapore/] },
  { country: "Hong Kong", patterns: [/홍콩/, /hong kong/] },
  { country: "Taiwan", patterns: [/대만|타이완/, /taiwan/] },
  { country: "Brazil", patterns: [/브라질/, /brazil/] },
  { country: "Ecuador", patterns: [/에콰도르/, /ecuador/] },
  { country: "Japan", patterns: [/일본/, /japan/] },
  { country: "Netherlands", patterns: [/네덜란드/, /netherlands|dutch/] },
  { country: "Sweden", patterns: [/스웨덴/, /sweden|swedish/] },
  { country: "Switzerland", patterns: [/스위스/, /switzerland|swiss/] },
  { country: "Norway", patterns: [/노르웨이/, /norway|norwegian/] },
  { country: "Portugal", patterns: [/포르투갈/, /portugal|portuguese/] },
  { country: "Spain", patterns: [/스페인/, /spain|spanish/] },
  { country: "Turkey", patterns: [/튀르키예|터키/, /turkey|turkiye|türkiye/] },
  { country: "Thailand", patterns: [/태국/, /thailand|thai/] },
  { country: "Indonesia", patterns: [/인도네시아/, /indonesia|indonesian/] },
  { country: "Vietnam", patterns: [/베트남/, /vietnam|vietnamese/] },
  { country: "United States", patterns: [/미국/, /united states|usa|u\.s\.a\.?/] },
  { country: "Peru", patterns: [/페루/, /peru|peruvian/] },
];

// Seed values only -- refreshCurrencyRatesInBackground() below keeps these
// updated from the same live source app/api/exchange-rate/route.ts uses, so
// a chatbot cost comparison and the country detail page's displayed rate for
// the same currency don't quietly disagree. Cost comparison across
// universities is a synchronous scoring/sorting step used deep in
// passesStructuredFilters/selectCards/evaluateUniversity; threading a fetched
// rate through every one of those call sites for every request is a much
// larger, riskier change than keeping this map itself fresh in place.
const CURRENCY_TO_KRW: Record<string, number> = {
  EUR: 1600,
  GBP: 1900,
  DKK: 215,
  CHF: 1700,
  NOK: 140,
  SEK: 145,
  USD: 1380,
  CAD: 1010,
  SGD: 1070,
  HKD: 176,
  TWD: 43,
  BRL: 255,
  JPY: 9.4,
};

let currencyRatesRefreshedAt = 0;
const CURRENCY_RATE_REFRESH_MS = 60 * 60 * 1000;

// Fire-and-forget: called at the start of a request so it never adds latency
// to that request, but keeps CURRENCY_TO_KRW reasonably live for later ones.
// Falls back to whatever value is already in the map (the static seed, or the
// last successful live fetch) on any failure -- never removes a currency.
function refreshCurrencyRatesInBackground() {
  if (Date.now() - currencyRatesRefreshedAt < CURRENCY_RATE_REFRESH_MS) return;
  currencyRatesRefreshedAt = Date.now();
  for (const currency of Object.keys(CURRENCY_TO_KRW)) {
    void fetch(`https://api.frankfurter.dev/v2/rate/${currency}/KRW`, { next: { revalidate: 3600 } })
      .then((response) => (response.ok ? response.json() : undefined))
      .then((data: { rate?: number } | undefined) => {
        if (data && typeof data.rate === "number" && Number.isFinite(data.rate) && data.rate > 0) {
          CURRENCY_TO_KRW[currency] = data.rate;
        }
      })
      .catch(() => {});
  }
}

function cleanText(value: unknown, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text || text.includes("???") || text.includes("\uFFFD")) return fallback;
  return text;
}

function repairMojibake(value: string): string {
  if (!/[ÃÂêëìíîïðñòóôõö÷øùúûüýþÿ]/.test(value)) return value;
  try {
    const bytes = Uint8Array.from([...value].map((char) => char.charCodeAt(0) & 0xff));
    const repaired = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    return repaired.includes("\uFFFD") ? value : repaired;
  } catch {
    return value;
  }
}

function normalizeSearchText(value: unknown): string {
  const text = typeof value === "string" ? repairMojibake(value) : cleanText(value);
  return cleanText(text)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9\uac00-\ud7a3]+/g, " ")
    .trim();
}

function includesAny(text: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(text));
}

function supabaseServerRestBase() {
  const raw = (process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/+$/, "");
  return raw.endsWith("/rest/v1") ? raw : `${raw}/rest/v1`;
}

function supabaseServerKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_KEY;
}

async function supabaseServerRequest<T>(path: string): Promise<T> {
  const key = supabaseServerKey();
  const base = supabaseServerRestBase();
  if (!key || !base || base === "/rest/v1") throw new Error("Supabase server environment is not configured");
  const response = await fetch(`${base}/${path}`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
    next: { revalidate: 300 },
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Supabase fact-table request failed: ${response.status} ${detail.slice(0, 300)}`);
  }
  return response.json() as Promise<T>;
}

async function requestFactRows(table: string, ids: string[], select: string) {
  if (!ids.length) return [] as Record<string, unknown>[];
  const chunks: Record<string, unknown>[] = [];
  for (let index = 0; index < ids.length; index += 80) {
    const group = ids.slice(index, index + 80).map(encodeURIComponent).join(",");
    const path = `${table}?select=${select}&review_status=neq.rejected&university_id=in.(${group})&limit=1000`;
    chunks.push(...(await supabaseServerRequest<Record<string, unknown>[]>(path)));
  }
  return chunks;
}

async function requestOptionalFactRows(table: string, ids: string[], select: string) {
  try {
    return await requestFactRows(table, ids, select);
  } catch (error) {
    console.warn(`Optional Supabase fact-table fetch skipped: ${table}`, error);
    return [] as Record<string, unknown>[];
  }
}

function groupFactRows(rows: Record<string, unknown>[]) {
  const grouped = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const universityId = cleanText(row.university_id);
    if (!universityId) continue;
    grouped.set(universityId, [...(grouped.get(universityId) ?? []), row]);
  }
  return grouped;
}

function factRowSourceTitle(row: Record<string, unknown>, fallback: string) {
  const type = cleanText(row.source_type, fallback).replace(/_/g, " ");
  return type === fallback ? fallback : type;
}

function normalizeCostFact(row: Record<string, unknown>) {
  return {
    fact_id: row.id,
    cost_type: row.cost_type,
    amount_min: row.amount_min,
    amount_max: row.amount_max,
    currency: row.currency,
    billing_period: row.billing_period,
    reference_period: row.reference_period,
    normalized_krw_min: row.normalized_krw_min,
    normalized_krw_max: row.normalized_krw_max,
    source_url: row.source_url,
    source_type: row.source_type,
    source_title: factRowSourceTitle(row, "cost_facts"),
    evidence_quote: row.evidence_quote,
    confidence: row.confidence,
    review_status: row.review_status,
    issue_notes: row.issue_notes,
  };
}

function normalizeHousingFact(row: Record<string, unknown>) {
  return {
    fact_id: row.id,
    housing_available: row.housing_available,
    housing_guaranteed: row.housing_guaranteed,
    housing_type: row.housing_type,
    housing_category: row.housing_type,
    room_type: row.room_type,
    meal_type: row.meal_type,
    cost_min: row.cost_min,
    cost_max: row.cost_max,
    currency: row.currency,
    billing_period: row.billing_period,
    application_required: row.application_required,
    deadline: row.deadline,
    source_url: row.source_url,
    source_type: row.source_type,
    source_title: factRowSourceTitle(row, "housing_facts"),
    evidence_quote: row.evidence_quote,
    confidence: row.confidence,
    review_status: row.review_status,
    issue_notes: row.issue_notes,
  };
}

function normalizeLanguageFact(row: Record<string, unknown>) {
  return {
    fact_id: row.id,
    language: row.language,
    test_type: row.test_type,
    minimum_score: row.minimum_score,
    overall_score: row.minimum_score,
    minimum_subscores: row.minimum_subscores,
    cefr_level: row.cefr_level,
    level: row.cefr_level,
    is_required: row.is_required,
    notes: row.notes,
    source_url: row.source_url,
    source_type: row.source_type,
    source_title: factRowSourceTitle(row, "language_requirements"),
    evidence_quote: row.evidence_quote,
    confidence: row.confidence,
    review_status: row.review_status,
    issue_notes: row.issue_notes,
  };
}

function normalizeDeadlineFact(row: Record<string, unknown>) {
  return {
    fact_id: row.id,
    semester: row.semester,
    deadline_type: row.deadline_type,
    deadline_date: row.deadline_date,
    date: row.deadline_date,
    deadline_text: row.deadline_text,
    source_url: row.source_url,
    source_type: row.source_type,
    source_title: factRowSourceTitle(row, "application_deadlines"),
    evidence_quote: row.evidence_quote,
    confidence: row.confidence,
    review_status: row.review_status,
    issue_notes: row.issue_notes,
  };
}

function normalizeQuotaFact(row: Record<string, unknown>) {
  const valueJson = row.value_json && typeof row.value_json === "object" ? (row.value_json as Record<string, unknown>) : {};
  return {
    fact_id: row.id,
    topic: row.topic,
    field_key: row.field_key,
    quota: valueJson.quota ?? valueJson.value ?? valueJson.amount ?? row.value_text,
    value_text: row.value_text,
    source_url: row.source_url ?? row.evidence_url,
    source_type: row.source_type ?? "extracted_facts",
    source_title: factRowSourceTitle(row, "quota_facts"),
    evidence_quote: row.evidence_quote,
    confidence: row.confidence,
    review_status: row.review_status,
    issue_notes: row.issue_notes,
  };
}

async function getFactTableBundles(universities: University[]) {
  const key = supabaseServerKey();
  if (!key) return new Map<string, FactTableBundle>();
  const ids = universities.map((university) => university.id);
  try {
    const [costRows, housingRows, languageRows, deadlineRows] = await Promise.all([
      requestFactRows(
        "cost_facts",
        ids,
        "id,university_id,cost_type,amount_min,amount_max,currency,billing_period,reference_period,normalized_krw_min,normalized_krw_max,source_url,source_type,evidence_quote,confidence,review_status,issue_notes",
      ),
      requestFactRows(
        "housing_facts",
        ids,
        "id,university_id,housing_available,housing_guaranteed,housing_type,room_type,meal_type,cost_min,cost_max,currency,billing_period,application_required,deadline,source_url,source_type,evidence_quote,confidence,review_status,issue_notes",
      ),
      requestFactRows(
        "language_requirements",
        ids,
        "id,university_id,language,test_type,minimum_score,minimum_subscores,cefr_level,is_required,notes,source_url,source_type,evidence_quote,confidence,review_status,issue_notes",
      ),
      requestFactRows(
        "application_deadlines",
        ids,
        "id,university_id,semester,deadline_type,deadline_date,deadline_text,source_url,source_type,evidence_quote,confidence,review_status,issue_notes",
      ),
    ]);

    const quotaRows = (
      await requestOptionalFactRows(
        "extracted_facts",
        ids,
        "id,university_id,topic,field_key,value_json,value_text,evidence_url,evidence_quote,confidence,review_status,issue_notes",
      )
    ).filter((row) => /quota|정원|파견|선발|모집/i.test(`${row.topic ?? ""} ${row.field_key ?? ""} ${row.value_text ?? ""} ${row.evidence_quote ?? ""}`));

    const costs = groupFactRows(costRows);
    const housing = groupFactRows(housingRows);
    const languages = groupFactRows(languageRows);
    const deadlines = groupFactRows(deadlineRows);
    const quotas = groupFactRows(quotaRows);
    const bundles = new Map<string, FactTableBundle>();
    for (const university of universities) {
      bundles.set(university.id, {
        costs: (costs.get(university.id) ?? []).map(normalizeCostFact),
        housing: (housing.get(university.id) ?? []).map(normalizeHousingFact),
        languages: (languages.get(university.id) ?? []).map(normalizeLanguageFact),
        deadlines: (deadlines.get(university.id) ?? []).map(normalizeDeadlineFact),
        quotas: (quotas.get(university.id) ?? []).map(normalizeQuotaFact),
      });
    }
    return bundles;
  } catch (error) {
    console.error("Supabase fact-table fetch failed; using ui_profile_json rows", error);
    return new Map<string, FactTableBundle>();
  }
}

function withFactTableRows(university: University, bundle?: FactTableBundle): University {
  if (!bundle) return university;
  const program = university.exchange_programs?.[0];
  if (!program) return university;
  const nextProgram: ExchangeProgram = {
    ...program,
    estimated_costs: bundle.costs.length ? bundle.costs : program.estimated_costs,
    housing_options: bundle.housing.length ? bundle.housing : program.housing_options,
    language_requirements: bundle.languages.length ? bundle.languages : program.language_requirements,
    application_deadlines: bundle.deadlines.length ? bundle.deadlines : program.application_deadlines,
    quota_facts: bundle.quotas,
  };
  return {
    ...university,
    exchange_programs: [nextProgram, ...(university.exchange_programs ?? []).slice(1)],
  };
}

async function getChatUniversities() {
  const universities = await getUniversities();
  const bundles = await getFactTableBundles(universities);
  return universities.map((university) => withFactTableRows(university, bundles.get(university.id)));
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    (item.role === "user" || item.role === "assistant") &&
    typeof item.content === "string" &&
    item.content.trim().length > 0 &&
    item.content.length <= MAX_MESSAGE_LENGTH
  );
}

function isRateLimited(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const clientId = forwarded || "anonymous";
  const now = Date.now();
  const bucket = requestBuckets.get(clientId);

  if (!bucket || bucket.resetAt <= now) {
    requestBuckets.set(clientId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }

  bucket.count += 1;
  if (requestBuckets.size > 500) {
    for (const [key, value] of requestBuckets) {
      if (value.resetAt <= now) requestBuckets.delete(key);
    }
  }
  return bucket.count > RATE_LIMIT_REQUESTS;
}

function isValidHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isClearlyNonOfficialUrl(value: string) {
  return /blog|naver|youtube|tistory|brunch|drive\.google|docs\.google|notion\.site|medium\.com/i.test(value);
}

function rowText(row: Record<string, unknown>) {
  return Object.values(row)
    .filter((value) => value !== null && value !== undefined && value !== "")
    .map((value) => String(value))
    .join(" · ");
}

function rowsText(rows: Record<string, unknown>[] | undefined) {
  return (rows ?? []).map(rowText).join("\n");
}

function detectIntent(question: string): Intent {
  const rawText = question.normalize("NFKC").toLowerCase();
  if (/수강\s*제한|전공\s*제한|선수\s*과목|제한됨|restricted|restriction|prerequisite|approval required|not available/i.test(rawText)) return "restriction";
  if (/비용|생활비|예산|학비|등록금|기숙사비|주거비|저렴|가장\s*싼|cost|fee|budget|tuition|living\s*cost|cheap|cheapest|least expensive/i.test(rawText)) return "cost";
  if (/기숙사|숙소|주거|housing|accommodation|dorm|residence/i.test(rawText)) return "housing";
  if (/ielts|toefl|어학|영어|언어|language|english/i.test(rawText)) return "language";
  if (/마감|지원\s*일정|지원\s*마감|노미네이션|nomination|deadline|application deadline/i.test(rawText)) return "deadline";
  if (/정원|쿼터|인원|quota|몇\s*명/i.test(rawText)) return "quota";
  if (/출처|공식|링크|근거|source/i.test(rawText)) return "source";
  const text = normalizeSearchText(question);
  if (includesAny(text, [/수강\s*제한/, /전공\s*제한/, /선수\s*과목/, /제한된/, /restricted/, /restriction/, /prerequisite/, /approval required/, /not available/])) return "restriction";
  if (includesAny(text, [/비용/, /생활비/, /예산/, /학비/, /등록금/, /기숙사비/, /저렴/, /최저/, /싼/, /싸/, /낮은/, /적게/, /cost/, /fee/, /budget/, /tuition/, /living/, /cheap/, /cheapest/, /lowest/, /least expensive/])) return "cost";
  if (includesAny(text, [/기숙/, /숙소/, /주거/, /housing/, /accommodation/, /dorm/, /residence/])) return "housing";
  if (includesAny(text, [/ielts/, /toefl/, /어학/, /영어/, /언어/, /language/, /english/])) return "language";
  if (includesAny(text, [/마감/, /지원\s*일정/, /지원\s*마감/, /노미네이션/, /nomination/, /deadline/, /application deadline/])) return "deadline";
  if (includesAny(text, [/정원/, /인원/, /quota/, /몇 명/, /몇명/])) return "quota";
  if (includesAny(text, [/출처/, /공식/, /링크/, /근거/, /source/])) return "source";
  return "general";
}

function isExchangeQuestion(question: string) {
  const text = normalizeSearchText(question);
  if (includesAny(text, [/맛집|식당|주식|코딩|게임|영화|날씨|부동산 투자|movie|restaurant|weather|stock/])) return false;
  return includesAny(text, [
    /교환|교환학생|대학|학교|지원|마감|어학|영어|기숙|숙소|주거|비용|생활비|학비|등록금|학점|평점|정원|전공|수강|학기|출처|랭킹|비자/,
    /exchange|university|college|application|deadline|ielts|toefl|gpa|grade point|housing|accommodation|cost|tuition|quota|major|semester|visa/,
  ]);
}

function isCostOfLivingIndexQuestion(question: string) {
  const text = normalizeSearchText(question);
  const raw = question.normalize("NFKC").toLowerCase();
  return /물가\s*지수|numbeo|cost of living index|한국.*물가|물가.*비슷|생활\s*수준.*비슷/.test(text)
    || /물가\s*지수|numbeo|cost of living index|한국.*물가|물가.*비슷|생활\s*수준.*비슷/.test(raw);
}

// This runs before any university-name resolution, so it never had a real
// target count to check -- the caller always passed 0, permanently disabling
// the "targetCount === 1" exemption this was written for. Dropped the
// parameter rather than leave a branch that can't fire.
function isRemovedCostRecommendation(question: string) {
  const text = question.normalize("NFKC").toLowerCase();
  if (/예산|상한|budget/.test(text)) return true;
  if (/총\s*비용|전체\s*비용|종합\s*비용|total\s*cost/.test(text)) return true;
  return /비용[^\n]{0,30}(?:비교|순위|랭킹|가장|최저|저렴|싼|낮은\s*순|적게|추천)|(?:compare|rank|ranking|cheapest|lowest|recommend)[^\n]{0,30}(?:cost|fee)/i.test(text);
}

function detectLanguageRequirement(question: string) {
  const text = question
    .normalize("NFKC")
    .toLowerCase()
    .replace(/아이엘츠/g, "ielts")
    .replace(/토플/g, "toefl");
  const testMatch = text.match(/(ielts|toefl(?:\s*ibt)?|duolingo|pte|cambridge|cae|cpe|ellt|oxford)[^\d]{0,20}(\d+(?:[.,]\d+)?)/i);
  const score = testMatch ? Number(testMatch[2].replace(",", ".")) : undefined;
  const subscoreMatch = text.match(/(?:각\s*(?:영역|항목)|each\s*(?:band|component|section)|no\s*(?:band|component)\s*below)[^\d]{0,20}(\d+(?:[.,]\d+)?)/i);
  const subscore = subscoreMatch ? Number(subscoreMatch[1].replace(",", ".")) : undefined;
  if (/ielts/.test(text) && score !== undefined) return { test: "IELTS Academic", score, subscore };
  if (/toefl/.test(text) && score !== undefined) return { test: "TOEFL iBT", score, subscore };
  if (/duolingo/.test(text) && score !== undefined) return { test: "Duolingo English Test", score, subscore };
  if (/pte/.test(text) && score !== undefined) return { test: "PTE Academic", score, subscore };
  if (/cambridge|cae|cpe/.test(text) && score !== undefined) return { test: "Cambridge CAE/CPE", score, subscore };
  if (/ellt|oxford/.test(text) && score !== undefined) return { test: "Oxford ELLT", score, subscore };
  return undefined;
}

function detectBudgetKrwSemester(question: string) {
  const text = normalizeSearchText(question);
  const raw = text.match(/(\d+(?:\.\d+)?)\s*(만원|만 원|krw|원)/i);
  if (!raw || raw.index === undefined) return undefined;
  const number = Number(raw[1]);
  if (!Number.isFinite(number)) return undefined;
  const krw = /만원|만 원/.test(raw[2]) ? number * 10_000 : number;
  // Only look for "monthly" near the amount itself -- checking the whole
  // question turned "5월 마감이고 예산은 300만원이야" into a monthly budget (the
  // "월" in "5월", a date, had nothing to do with the money) and multiplied a
  // 3,000,000 KRW budget by 5.
  const vicinity = text.slice(Math.max(0, raw.index - 12), raw.index + raw[0].length + 12);
  const isMonthly = /월|한달|1달|monthly|per month/.test(vicinity);
  return isMonthly ? krw * 5 : krw;
}

function detectGpa(question: string) {
  const text = question.normalize("NFKC").toLowerCase();
  const match = text.match(/(?:gpa|학점|평점)\s*(?:이|은|는|:)?\s*(\d+(?:[.,]\d+)?)(?:\s*\/\s*(\d+(?:[.,]\d+)?))?/i)
    ?? text.match(/(\d+(?:[.,]\d+)?)\s*\/\s*4[.,]5/);
  if (!match) return undefined;
  const gpa = Number(match[1].replace(",", "."));
  return Number.isFinite(gpa) ? gpa : undefined;
}

function detectQuotaMode(question: string, quotaMin?: number): QuotaMode | undefined {
  const raw = question.normalize("NFKC").toLowerCase();
  if (quotaMin !== undefined) return "minimum";
  if (!/quota|정원|파견\s*인원|선발\s*인원/.test(raw)) return undefined;
  if (/미확인|없는|없고|알\s*수\s*없는/.test(raw)) return "missing";
  if (/내림차순|많은\s*순|높은\s*순|가장\s*많/.test(raw)) return "sort_desc";
  return "exists";
}

function detectMajor(question: string) {
  const text = normalizeSearchText(question);
  if (/컴퓨터|소프트웨어|software|computer|cs|공학|engineering|it/.test(text)) return "engineering";
  if (/경영|경제|business|management|economics/.test(text)) return "business";
  if (/인문|사회|humanities|social/.test(text)) return "humanities";
  if (/자연과학|과학|science|biology|chemistry|physics/.test(text)) return "science";
  if (/예술|디자인|건축|art|design|architecture/.test(text)) return "arts";
  return undefined;
}

function countryMentionIsExcluded(rawText: string, matchIndex: number, matchLength: number) {
  const before = rawText.slice(Math.max(0, matchIndex - 14), matchIndex);
  const after = rawText.slice(matchIndex + matchLength, Math.min(rawText.length, matchIndex + matchLength + 14));
  const exclusion = "(?:제외(?:하고)?|빼고|말고|아닌|except|exclude|without)";
  return new RegExp(`${exclusion}\\s*$`, "i").test(before)
    || new RegExp(`^\\s*(?:은|는|을|를|도|과|와|,)?\\s*${exclusion}`, "i").test(after);
}

function detectCountries(question: string) {
  const rawText = question.normalize("NFKC").toLowerCase();
  return COUNTRY_ALIASES.filter(({ patterns }) => patterns.some((pattern) => {
    const match = rawText.match(pattern);
    return Boolean(match && !countryMentionIsExcluded(rawText, match.index ?? 0, match[0].length));
  })).map(({ country }) => country);
}

function detectExcludedCountries(question: string) {
  const rawText = question.normalize("NFKC").toLowerCase();
  return COUNTRY_ALIASES.filter(({ patterns }) => patterns.some((pattern) => {
    const match = rawText.match(pattern);
    return Boolean(match && countryMentionIsExcluded(rawText, match.index ?? 0, match[0].length));
  })).map(({ country }) => country);
}

function detectQuotaMin(question: string) {
  const raw = question.normalize("NFKC").toLowerCase();
  const rawMatch = raw.match(/(\d+)\s*명\s*이상/);
  if (rawMatch && /quota|정원|파견|선발|모집/.test(raw)) {
    const rawValue = Number(rawMatch[1]);
    if (Number.isFinite(rawValue)) return rawValue;
  }
  const text = normalizeSearchText(question);
  const match = text.match(/(?:quota|정원|인원)?\s*(\d+)\s*(?:명|명 이상|이상|or more|plus)/i);
  if (!match || !/quota|정원|인원|명/.test(text)) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

function detectConstraints(question: string): QueryConstraints {
  const text = normalizeSearchText(question);
  const rawQuestion = question.toLowerCase();
  const intent = detectIntent(question);
  const costOfLivingIndexQuestion = isCostOfLivingIndexQuestion(question);
  // "명" is a counter for people, not institutions -- keeping it here matched
  // "파견 정원 10명 이상인 대학 추천해줘" as "10 requested results" (topN capped at
  // 8) instead of a quota threshold, which detectQuotaMin already parses
  // separately from the same "10명 이상" text.
  const topMatch = question.match(
    /(\d+)\s*(개|곳|schools?|universities?)|(\d+)\s*(cheapest|lowest|best|recommended|추천)|(?:recommend|show|pick|select|top)\s*(?:the\s*)?(\d+)/i,
  );
  const koreanTop = question.match(/(\d+)\s*(?:개|곳|군데|학교|대학)/)?.[1];
  const topValue = topMatch?.[1] ?? topMatch?.[3] ?? topMatch?.[5] ?? koreanTop;
  const language = detectLanguageRequirement(question);
  const quotaMin = detectQuotaMin(question);
  const quotaMode = detectQuotaMode(question, quotaMin);
  const koreanClearCost = /명확|숫자|공식 출처|출처가 있는|확인된|구체적인|비용 정보가 있는/.test(rawQuestion);
  const koreanOfficial = /공식|공식자료|공식 자료/.test(rawQuestion);
  const koreanHousing = /기숙사|숙소|주거/.test(rawQuestion);
  const requestedFields = requestedFieldsFromQuestion(question);
  const deadlineDateConstraint = parseDeadlineDateConstraint(rawQuestion);

  const constraints = {
    intent,
    requireAsia:
      /아시아|asia/i.test(question) &&
      !/(?:아시아|asia)[^\n]{0,18}(?:제외|빼고|빼줘|exclude|without)|(?:제외|빼고|빼줘|exclude|without)[^\n]{0,18}(?:아시아|asia)/i.test(question),
    requireAmericas: /미주|북미|남미|아메리카|americas?|north america|south america/i.test(rawQuestion),
    sortGpaLowest: /(?:학점|gpa)[^\n]{0,30}(?:가장\s*낮|낮은\s*순|최저|lowest|ascending)|(?:가장\s*낮|낮은\s*순|최저|lowest)[^\n]{0,30}(?:학점|gpa)/i.test(question),
    topN: Math.max(1, Math.min(8, topValue ? Number(topValue) : 4)),
    requireEurope: /유럽|europe|european/.test(text) || /유럽|europe|european/.test(rawQuestion),
    inScope: isExchangeQuestion(question) && !costOfLivingIndexQuestion,
    requireHousing: /기숙|숙소|주거|housing|accommodation|dorm|residence/.test(text) || /기숙|숙소|주거|housing|accommodation|dorm|residence/.test(rawQuestion),
    requireHousingGuaranteed: /기숙사?\s*(?:배정\s*)?(?:보장|확약)|housing[^\n]{0,24}guaranteed|guaranteed[^\n]{0,24}(?:housing|accommodation)/i.test(rawQuestion),
    requireAll: /모든 조건|전부|only|만 추천|만 골라|제외|exclude|명확|공식 출처|숫자 비교/.test(text) || /모든 조건|전부|only|만 추천|만 골라|제외|exclude|명확|공식 출처|숫자 비교/.test(rawQuestion),
    requireOfficialSource: /공식|official/.test(text) || /공식|official/.test(rawQuestion),
    requireClearCost: /명확|숫자 비교|비용 정보가 부족|공식 출처|출처가 있는|정확/.test(text) || /명확|숫자 비교|비용 정보가 부족|공식 출처|출처가 있는|정확/.test(rawQuestion),
    countries: detectCountries(question),
    excludedCountries: detectExcludedCountries(question),
    excludeAsia: /(?:아시아|asia)[^\n]{0,18}(?:제외|빼고|빼줘|exclude|without)/i.test(question) || /(?:제외|빼고|빼줘|exclude|without)[^\n]{0,18}(?:아시아|asia)/i.test(question),
    languageTest: language?.test,
    languageScore: language?.score,
    languageSubscore: language?.subscore,
    budgetKrwSemester: detectBudgetKrwSemester(question),
    gpa: detectGpa(question),
    major: detectMajor(question),
    quotaMin,
    quotaMode,
    requireGpaKnown: /gpa.*(?:확인|공식)|(?:확인|공식).*gpa/i.test(rawQuestion),
    requireQuotaKnown: /quota.*(?:확인|공식)|(?:확인|공식).*quota/i.test(rawQuestion),
    requireHousingMissing: /기숙사\s*(?:정보가\s*)?(?:없는|없고|미확인)|housing[^\n]{0,20}(?:missing|unknown|without)/i.test(rawQuestion),
    sortDeadlineEarliest: /빠른|가장\s*먼저|이른|earliest|soonest/.test(text) || /빠른|가장\s*먼저|이른|earliest|soonest/.test(rawQuestion),
    // When an explicit ISO-date comparator was already parsed (e.g.
    // "2026-05-01 이후"), don't also pull an academic year out of that same
    // date and use it as a second, stricter filter -- "이후" should include
    // 2027, 2028, ... deadlines too, and requiring the year to equal exactly
    // the one in the comparator date silently excludes those.
    deadlineAcademicYear: deadlineDateConstraint
      ? undefined
      : Number(rawQuestion.match(/\b(20\d{2})(?:\s*\/\s*\d{2,4})?/)?.[1]) || undefined,
    deadlineSemester: /가을|autumn|fall/.test(rawQuestion) ? "autumn" as const : /봄|spring/.test(rawQuestion) ? "spring" as const : undefined,
    deadlineType: /nomination|노미네이션|지명/.test(rawQuestion) && !/application|지원\s*마감/.test(rawQuestion)
      ? "nomination" as const
      : /application|지원\s*마감/.test(rawQuestion) && !/nomination|노미네이션|지명/.test(rawQuestion)
        ? "application" as const
        : undefined,
    deadlineSpringOnly: /봄[^\n]{0,30}(?:있|등록)[^\n]{0,30}가을[^\n]{0,20}(?:없|미확인)|spring[^\n]{0,30}(?:only|but)[^\n]{0,30}(?:no|without)[^\n]{0,10}(?:autumn|fall)/i.test(rawQuestion),
    deadlineRequireClearYear: /학년도.*(?:명확|불분명)|적용\s*학기.*(?:명확|불분명)|연도.*(?:명확|불분명)|과거\s*자료.*제외/.test(rawQuestion),
    deadlineComparator: deadlineDateConstraint?.comparator,
    deadlineDate: deadlineDateConstraint?.date,
    unsupportedReason: costOfLivingIndexQuestion ? "cost_of_living_index" as const : undefined,
    requestedFields,
  };

  return {
    ...constraints,
    requireGpaKnown: constraints.requireGpaKnown || constraints.sortGpaLowest,
    deadlineSemester: constraints.deadlineSpringOnly ? undefined : constraints.deadlineSemester,
    requireHousing: constraints.requireHousingMissing ? false : koreanHousing || constraints.requireHousing,
    requireOfficialSource: koreanOfficial || constraints.requireOfficialSource,
    requireClearCost: koreanClearCost || constraints.requireClearCost,
  };
}

// A real conversation shouldn't need "IELTS 6.0" repeated in every turn just
// to keep filtering by it -- carry a turn's conditions forward the way a
// human would remember them, until the client starts a new conversation
// (a fresh sessionId / an empty message history resets this naturally, since
// there's nothing to fold in).
//
// Geographic scope (requireEurope/requireAsia/requireAmericas/countries/
// excludedCountries/excludeAsia) is deliberately NOT carried forward here.
// selectCards still applies those to an exact-name match even when the
// question names one specific university (e.g. "그 대학의 IELTS는?"), and if
// an earlier unrelated turn had said "유럽 대학만", that scope would wrongly
// hide a later, explicitly-named non-European university. The existing
// contextUniversityIds + isFollowupReference mechanism already carries
// forward *which universities* a "그중" follow-up should stay inside; this
// only restores conditions like score/GPA/major/housing/deadline that
// otherwise silently reset every turn.
function mergeConversationConstraints(base: QueryConstraints, current: QueryConstraints): QueryConstraints {
  return {
    ...current,
    languageTest: current.languageTest ?? base.languageTest,
    languageScore: current.languageScore ?? base.languageScore,
    languageSubscore: current.languageSubscore ?? base.languageSubscore,
    gpa: current.gpa ?? base.gpa,
    major: current.major ?? base.major,
    budgetKrwSemester: current.budgetKrwSemester ?? base.budgetKrwSemester,
    quotaMin: current.quotaMin ?? base.quotaMin,
    quotaMode: current.quotaMode ?? base.quotaMode,
    deadlineAcademicYear: current.deadlineAcademicYear ?? base.deadlineAcademicYear,
    deadlineSemester: current.deadlineSemester ?? base.deadlineSemester,
    deadlineType: current.deadlineType ?? base.deadlineType,
    deadlineComparator: current.deadlineComparator ?? base.deadlineComparator,
    deadlineDate: current.deadlineDate ?? base.deadlineDate,
    requireHousing: current.requireHousing || base.requireHousing,
    requireHousingGuaranteed: current.requireHousingGuaranteed || base.requireHousingGuaranteed,
    requireHousingMissing: current.requireHousingMissing || base.requireHousingMissing,
  };
}

function detectConversationConstraints(messages: ChatMessage[]): QueryConstraints {
  const userTurns = messages.filter((message) => message.role === "user").map((message) => message.content);
  return userTurns.reduce<QueryConstraints | undefined>(
    (accumulated, text) => {
      const detected = detectConstraints(text);
      return accumulated ? mergeConversationConstraints(accumulated, detected) : detected;
    },
    undefined,
  )!;
}

const REQUEST_FIELD_TO_INTENT: Record<string, Intent> = {
  universities: "general",
  language_requirements: "language",
  housing_options: "housing",
  estimated_costs: "cost",
  application_deadlines: "deadline",
  quota_facts: "quota",
  course_restrictions: "restriction",
  source_links: "source",
};

function requestedFieldsFromQuestion(question: string) {
  const text = question.normalize("NFKC").toLowerCase();
  const fields: string[] = [];
  if (/ielts|아이엘츠|toefl|토플|어학|영어\s*성적|언어\s*조건/.test(text)) fields.push("language_requirements");
  if (/기숙사|숙소|주거|housing|accommodation|dorm|residence/.test(text)) fields.push("housing_options");
  if (/비용|생활비|학비|등록금|기숙사비|주거비|cost|fee|tuition/.test(text)) fields.push("estimated_costs");
  if (/마감|일정|지원\s*기간|학기|nomination|deadline|application|semester/.test(text)) fields.push("application_deadlines");
  if (/정원|쿼터|quota|몇\s*명/.test(text)) fields.push("quota_facts");
  if (/수강\s*제한|전공\s*제한|선수\s*과목|course\s*restriction|prerequisite/.test(text)) fields.push("course_restrictions");
  if (/출처|공식\s*(?:자료|링크)|근거|source/.test(text)) fields.push("source_links");
  if (!fields.length) fields.push("universities");
  return [...new Set(fields)];
}

function isEuropeanUniversity(university: University) {
  const country = normalizeSearchText(university.country);
  const city = normalizeSearchText(university.city);
  const name = normalizeSearchText(university.university_name);
  return (
    EUROPE_COUNTRIES.has(country) ||
    /united kingdom|\buk\b|england|scotland/.test(country) ||
    /paris|rennes|lyon|bristol|sheffield|venice|rostock|kiel|dornbirn|brussels|copenhagen|helsinki|joensuu|kuopio|toulouse|osnabruck/.test(`${city} ${name}`)
  );
}

function isAsianUniversity(university: University) {
  return ASIA_COUNTRIES.has(normalizeSearchText(university.country));
}

function isAmericasUniversity(university: University) {
  return AMERICAS_COUNTRIES.has(normalizeSearchText(university.country));
}

function matchesCountry(university: University, countries: string[]) {
  if (!countries.length) return true;
  const country = normalizeSearchText(university.country);
  return countries.some((item) => country === normalizeSearchText(item));
}

function programOf(university: University) {
  return university.exchange_programs?.[0];
}

function relevantRows(university: University, intent: Intent) {
  const program = programOf(university);
  if (intent === "housing") return program?.housing_options ?? [];
  if (intent === "language") return program?.language_requirements ?? [];
  if (intent === "cost") return [...(program?.estimated_costs ?? []), ...(program?.housing_options ?? [])];
  if (intent === "deadline") return program?.application_deadlines ?? [];
  if (intent === "quota") {
    const quota = quotaValue(university);
    if (quota !== undefined) return [{ quota, summary: `Quota: ${quota}` }];
    const text = `${university.summary}\n${university.profile_sections?.map((section) => section.summary).join("\n") ?? ""}\n${program ? JSON.stringify(program) : ""}`;
    return /quota|정원|파견 가능 인원/i.test(text) ? [{ summary: text.slice(0, 600) }] : [];
  }
  if (intent === "restriction") return program?.course_restrictions ?? [];
  return [];
}

function sectionText(university: University, intent: Intent) {
  const keywords: Record<Intent, RegExp> = {
    housing: /기숙|숙소|주거|housing|accommodation|residence/i,
    language: /어학|영어|언어|ielts|toefl|language/i,
    cost: /비용|생활비|예산|학비|등록금|cost|fee|housing/i,
    deadline: /마감|일정|deadline|application|nomination/i,
    quota: /quota|정원|파견 가능 인원/i,
    restriction: /수강 제한|전공 제한|선수 과목|restricted|restriction|prerequisite|approval required|not available|limited/i,
    source: /공식|출처|source|link/i,
    general: /./i,
  };
  return (university.profile_sections ?? [])
    .filter((section) => keywords[intent].test(`${section.section_title}\n${section.summary}`))
    .map((section) => `${section.section_title}: ${section.summary}`)
    .join("\n");
}

function scoreUniversity(university: University, intent: Intent, question: string) {
  const program = programOf(university);
  let score = 0;
  const q = normalizeSearchText(question);
  const corpus = normalizeSearchText(`${university.university_name} ${university.country} ${university.city} ${university.summary} ${sectionText(university, intent)}`);

  if (q.includes(normalizeSearchText(university.university_name))) score += 20;
  if (university.country && q.includes(normalizeSearchText(university.country))) score += 5;
  if (university.city && q.includes(normalizeSearchText(university.city))) score += 4;

  if (intent === "housing") score += (program?.housing_options?.length ?? 0) * 4;
  if (intent === "language") score += (program?.language_requirements?.length ?? 0) * 4;
  if (intent === "cost") score += ((program?.estimated_costs?.length ?? 0) + (program?.housing_options?.length ?? 0)) * 3;
  if (intent === "deadline") score += (program?.application_deadlines?.length ?? 0) * 4;
  if (intent === "source") score += (program?.source_links?.length ?? 0) * 2;
  if (intent === "quota" && /quota|정원|파견 가능 인원/i.test(corpus)) score += 6;
  if (intent === "restriction" && /restricted|not available|approval required|prerequisite|limited|수강 제한|전공 제한|선수 과목/i.test(corpus)) score += 6;

  for (const token of q.split(/\s+/).filter((item) => item.length >= 2)) {
    if (corpus.includes(token)) score += 1;
  }

  return score;
}

function numericValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  if (!normalized) return undefined;
  const parsed = Number(normalized[0]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function rowAsText(row: Record<string, unknown>) {
  return Object.entries(row)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(" | ");
}

function detectCurrency(row: Record<string, unknown>): string | undefined {
  const explicit = cleanText(row.currency).toUpperCase();
  if (explicit && CURRENCY_TO_KRW[explicit]) return explicit;

  const text = rowAsText(row).toUpperCase();
  const rawText = rowAsText(row);
  if (rawText.includes("€") || /EUR/.test(text)) return "EUR";
  if (rawText.includes("£") || /GBP/.test(text)) return "GBP";
  if (/€|EUR/.test(text)) return "EUR";
  if (/£|GBP/.test(text)) return "GBP";
  if (/DKK/.test(text)) return "DKK";
  if (/CHF/.test(text)) return "CHF";
  if (/NOK/.test(text)) return "NOK";
  if (/SEK/.test(text)) return "SEK";
  if (/SGD/.test(text)) return "SGD";
  if (/HKD/.test(text)) return "HKD";
  if (/TWD/.test(text)) return "TWD";
  if (/CAD/.test(text)) return "CAD";
  if (/BRL/.test(text)) return "BRL";
  if (/JPY|¥/.test(text)) return "JPY";
  if (/USD|\$/.test(text)) return "USD";
  return undefined;
}

function comparableCostText(row: Record<string, unknown>) {
  return [
    row.billing_period,
    row.reference_period,
    row.period,
    row.duration,
    row.original_text,
    row.evidence_quote,
    row.notes,
    row.source_title,
    row.raw_json ? JSON.stringify(row.raw_json) : "",
  ]
    .filter((value) => value !== null && value !== undefined && value !== "")
    .map(String)
    .join(" | ");
}

function hasExplicitCostPeriod(row: Record<string, unknown>) {
  const text = normalizeSearchText(comparableCostText(row));
  return /month|monthly|per month|\/month|week|weekly|per week|\/week|semester|per semester|term|year|annual|annually|academic year|full year|월|주|학기|연간|1년/.test(text);
}

function isReviewOrUnofficialRow(row: Record<string, unknown>) {
  const text = normalizeSearchText(`${row.source_type ?? ""} ${row.source_url ?? ""} ${row.source_title ?? ""}`);
  return /student review|student_review|blog|naver|youtube|tistory|medium|other/.test(text);
}

function parseCurrencyAmount(text: string) {
  const source = text.replace(/,/g, "");
  const prefixed = source.match(/(?:EUR|GBP|USD|CAD|SGD|HKD|TWD|DKK|CHF|NOK|SEK|BRL|JPY|€|£|\$|¥)\s*(\d+(?:\.\d+)?)/i);
  if (prefixed) return Number(prefixed[1]);
  const suffixed = source.match(/(\d+(?:\.\d+)?)\s*(?:EUR|GBP|USD|CAD|SGD|HKD|TWD|DKK|CHF|NOK|SEK|BRL|JPY|€|£|\$|¥)/i);
  if (suffixed) return Number(suffixed[1]);
  return undefined;
}

function semesterMultiplier(row: Record<string, unknown>) {
  const text = normalizeSearchText(comparableCostText(row));
  if (/month|monthly|per month|월/.test(text)) return 5;
  if (/week|weekly|per week|주/.test(text)) return 20;
  if (/year|annual|annually|academic year|full year|연간|1년/.test(text)) return 0.5;
  if (/semester|term|학기/.test(text)) return 1;
  return 1;
}

function costCategory(row: Record<string, unknown>): "tuition" | "housing" | "living" | "other" {
  const text = normalizeSearchText(
    Object.entries(row)
      .filter(([key]) => !/url|source|evidence|title/i.test(key))
      .map(([key, value]) => `${key}: ${String(value ?? "")}`)
      .join(" | "),
  );
  if (/tuition|registration|등록금|학비/.test(text)) return "tuition";
  if (/housing|accommodation|dorm|residence|hall|lodging|기숙|숙소|주거/.test(text)) return "housing";
  if (/living|meal|food|transport|book|insurance|incidentals|생활비|식비|교통|보험/.test(text)) return "living";
  return "other";
}

function structuredCostAmount(row: Record<string, unknown>): number | undefined {
  for (const key of ["amount_min", "cost_min", "price_min", "amount", "cost", "fee", "price"]) {
    const value = numericValue(row[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function costAmount(row: Record<string, unknown>): number | undefined {
  const normalizedText = normalizeSearchText(
    Object.entries(row)
      .filter(([key]) => !/url|source|evidence|title/i.test(key))
      .map(([key, value]) => `${key}: ${String(value ?? "")}`)
      .join(" | "),
  );
  if (
    /semester fee|course fee|language course|student fee|administrative fee/.test(normalizedText) &&
    !/housing|accommodation|dorm|residence|기숙|숙소|주거|living|생활비/.test(normalizedText)
  ) {
    return undefined;
  }

  const structuredAmount = structuredCostAmount(row);
  if (structuredAmount !== undefined) return structuredAmount;

  const text = normalizeSearchText(rowAsText(row));
  if (/waived|exempt|free|면제|없음/.test(text) && /tuition|registration|등록금|학비/.test(text)) return 0;

  const parsed = parseCurrencyAmount(comparableCostText(row));
  if (parsed !== undefined && Number.isFinite(parsed)) return parsed;

  const original = rowAsText(row).replace(/,/g, "");
  const currencyAmount = original.match(/(?:EUR|GBP|USD|CAD|SGD|HKD|TWD|DKK|CHF|NOK|SEK|BRL|JPY|€|£|\$|¥)\s*(\d+(?:\.\d+)?)/i);
  if (currencyAmount) return Number(currencyAmount[1]);

  return undefined;
}

function isNonComparableCostRow(row: Record<string, unknown>, category: "tuition" | "housing" | "living" | "other", amount: number, currency: string) {
  const text = normalizeSearchText(rowAsText(row));
  if (category === "other") return true;
  if (category === "housing") {
    const looksLikePlatformIntro = /studapart|housinganywhere|platform|listings|housing aid|relocation services|discounts|secure messaging|home insurance|보험|할인|플랫폼/.test(text);
    const hasActualRentSignal = /rent|rental|housing cost|accommodation cost|room fee|monthly housing|per month|monthly|월|기숙사 비용|숙소 비용/.test(text);
    if (looksLikePlatformIntro && !hasActualRentSignal) return true;
    if (/optional home insurance|home insurance|insurance|보험/.test(text) && !/rent|housing cost|accommodation cost|기숙사 비용|숙소 비용/.test(text)) return true;
    if (["EUR", "GBP", "USD", "CAD", "SGD", "CHF"].includes(currency) && amount > 0 && amount < 100) return true;
  }
  if (category === "living" && ["EUR", "GBP", "USD", "CAD", "SGD", "CHF"].includes(currency) && amount > 0 && amount < 100) {
    return true;
  }
  return false;
}

function rowSource(university: University, row: Record<string, unknown>, fieldKey: string, fallbackTitle: string): ChatSource | undefined {
  const url = cleanText(row.source_url, cleanText(row.url, cleanText(row.evidence_url)));
  if (!isValidHttpUrl(url)) return undefined;
  return {
    fact_id: cleanText(row.fact_id, cleanText(row.id)),
    title: cleanText(row.source_title, cleanText(row.title, fallbackTitle)),
    url,
    university_name: university.university_name,
    source_type: cleanText(row.source_type, fieldKey),
    is_official: !isClearlyNonOfficialUrl(url),
    field_key: fieldKey,
    evidence_quote: cleanText(row.evidence_quote, cleanText(row.original_text, "")).slice(0, 220),
  };
}

function sourceForCost(university: University, row: Record<string, unknown>) {
  const direct = rowSource(university, row, "estimated_costs", "비용 출처");
  if (direct) return direct;
  return firstSource(university, "cost");
}

function highlightFromRow(row: Record<string, unknown>, intent: Intent) {
  if (intent === "housing") {
    const fields = presentHousingRow(row).filter((field) => field.status !== "unknown" && field.value);
    return fields.length ? fields.map((field) => `${field.label}: ${field.value}`).join(" · ") : "기숙사 정보 확인 필요";
  }
  if (intent === "language") {
    const field = presentLanguage(row);
    return `${field.label}: ${field.value ?? "확인 필요"}`;
  }
  if (intent === "cost") {
    const field = presentCost(row);
    return `${field.label}: ${field.value ?? "확인된 금액 없음"}`;
  }
  if (intent === "deadline") {
    const field = presentDeadline(row);
    return `${field.label}: ${field.value ?? "확인 필요"}`;
  }
  return rowText(row);
}

function estimateSemesterCost(university: University, options: { requireClear?: boolean } = {}): CostEstimate | undefined {
  const program = programOf(university);
  const rows = [...(program?.estimated_costs ?? []), ...(program?.housing_options ?? [])];
  const byCategory = new Map<string, CostComponent>();

  for (const row of rows) {
    const normalizedKrw = numericValue(row.normalized_krw_min);
    const structuredAmount = structuredCostAmount(row);
    const amount = costAmount(row);
    const currency = detectCurrency(row) ?? (amount === 0 ? "EUR" : undefined);
    const category = costCategory(row);
    if (category === "other") continue;
    if (isReviewOrUnofficialRow(row)) continue;
    if (category !== "tuition" && structuredAmount === undefined) continue;
    const directSource = rowSource(university, row, "estimated_costs", "비용 출처");
    const hasRawComparableAmount = amount !== undefined && Boolean(currency) && Boolean(CURRENCY_TO_KRW[currency ?? ""]);
    const hasComparablePeriod = category === "tuition" || amount === 0 || hasExplicitCostPeriod(row);
    if (!hasComparablePeriod) continue;
    if (!hasRawComparableAmount && normalizedKrw === undefined) continue;
    if (options.requireClear && (!directSource?.url || !hasRawComparableAmount || structuredAmount === undefined)) continue;
    if (amount !== undefined && currency && isNonComparableCostRow(row, category, amount, currency)) continue;

    const krw = hasRawComparableAmount ? (amount ?? 0) * semesterMultiplier(row) * CURRENCY_TO_KRW[currency ?? "EUR"] : normalizedKrw ?? 0;
    const directLabel = highlightFromRow(row, "cost");
    const categoryLabel = category === "housing" ? "기숙사/주거비" : category === "living" ? "생활비" : "등록금";
    const label =
      directLabel && !directLabel.includes("확인 필요")
        ? directLabel
        : `${categoryLabel}: 약 ${Math.round(krw / 10_000).toLocaleString("ko-KR")}만원 (학기 환산)`;
    const source = directSource ?? sourceForCost(university, row);
    const existing = byCategory.get(category);
    if (!existing || krw < existing.krw) {
      byCategory.set(category, { category, krw, label, row, source });
    }
  }

  if (!byCategory.size) return undefined;
  if (![...byCategory.keys()].some((category) => category === "housing" || category === "living")) return undefined;

  const components = [...byCategory.values()];
  const total = components.reduce((sum, item) => sum + item.krw, 0);
  const source = components.find((item) => item.source)?.source;
  const label = components
    .map((item) => item.label)
    .slice(0, 3)
    .join(" / ");

  return {
    normalizedKrw: total,
    label: `학기 기준 비교 비용: 약 ${Math.round(total / 10_000).toLocaleString("ko-KR")}만원 (${label})`,
    sourceUrl: source?.url,
    sourceTitle: source?.title,
    sourceType: source?.source_type,
    evidenceQuote: source?.evidence_quote,
    categoryCount: components.length,
    components,
  };
}

function housingGuaranteeSummary(university: University) {
  const rows = programOf(university)?.housing_options ?? [];
  if (!rows.length) return "기숙사 정보 없음";
  const presented = rows.map(presentHousingGuarantee);
  const guaranteed = presented.find((field) => field.value === "보장");
  if (guaranteed) return `${guaranteed.label}: ${guaranteed.value}`;
  const notGuaranteed = presented.find((field) => field.value === "명시적으로 보장되지 않음");
  if (notGuaranteed) return `${notGuaranteed.label}: ${notGuaranteed.value}`;
  return "배정 보장: 확인 필요";
}

function matchesLanguageTest(stored: unknown, selected: string) {
  const value = normalizeSearchText(stored);
  const aliases: Record<string, string[]> = {
    "IELTS Academic": ["ielts"],
    "TOEFL iBT": ["toefl"],
    "Cambridge CAE/CPE": ["cambridge", "cae", "cpe"],
    "PTE Academic": ["pte", "pearson"],
    "Duolingo English Test": ["duolingo"],
    "Oxford ELLT": ["oxford", "ellt"],
  };
  return (aliases[selected] ?? []).some((alias) => value.includes(alias));
}

function validLanguageScore(test: string, value: unknown) {
  const score = numericValue(value);
  if (score === undefined) return undefined;
  if (test === "IELTS Academic") return score >= 4 && score <= 9 ? score : undefined;
  if (test === "TOEFL iBT") return score >= 40 && score <= 120 ? score : undefined;
  return score;
}

function languageSubscoreRequirement(row: Record<string, unknown>) {
  const structured = row.minimum_subscores;
  if (structured && typeof structured === "object") {
    const values = Object.values(structured).map(numericValue).filter((value): value is number => value !== undefined);
    if (values.length) return Math.max(...values);
  }
  const text = [row.notes, row.evidence_quote, row.requirement_text].map((value) => cleanText(value)).join(" ");
  const match = text.match(/(?:each\s*(?:band|component|section)|no\s*(?:band|component)\s*below|각\s*(?:영역|항목))[^\d]{0,20}(\d+(?:\.\d+)?)/i);
  return match ? Number(match[1]) : undefined;
}

function languageEvaluation(university: University, constraints: QueryConstraints): ConditionCheck | undefined {
  if (!constraints.languageTest || constraints.languageScore === undefined) return undefined;
  const rows = programOf(university)?.language_requirements ?? [];
  const matching = rows.filter((row) => matchesLanguageTest(row.test_type, constraints.languageTest ?? ""));
  const valid = matching
    .map((row) => ({ row, score: validLanguageScore(constraints.languageTest ?? "", row.minimum_score ?? row.overall_score) }))
    .filter((item): item is { row: Record<string, unknown>; score: number } => item.score !== undefined);
  if (!valid.length) return { key: "language", label: constraints.languageTest, state: "unknown", detail: `${constraints.languageTest} 유효 점수 미확인` };

  const distinctScores = [...new Set(valid.map((item) => item.score))];
  if (distinctScores.length > 1) {
    return { key: "language", label: constraints.languageTest, state: "unknown", detail: `프로그램별 요구 점수 충돌 (${distinctScores.join(" / ")})` };
  }
  const required = distinctScores[0];
  if (constraints.languageScore < required) {
    return { key: "language", label: constraints.languageTest, state: "failed", detail: `요구 ${required}, 입력 ${constraints.languageScore}` };
  }
  const subscore = Math.max(...valid.map((item) => languageSubscoreRequirement(item.row) ?? -1));
  if (subscore >= 0 && constraints.languageSubscore === undefined) {
    return { key: "language", label: constraints.languageTest, state: "unknown", detail: `전체 ${required} 충족, 각 영역 ${subscore} 확인 필요` };
  }
  if (subscore >= 0 && (constraints.languageSubscore ?? -1) < subscore) {
    return { key: "language", label: constraints.languageTest, state: "failed", detail: `각 영역 요구 ${subscore}, 입력 ${constraints.languageSubscore}` };
  }
  return { key: "language", label: constraints.languageTest, state: "met", detail: `요구 ${required}, 입력 ${constraints.languageScore}${subscore >= 0 ? ` · 각 영역 ${subscore} 충족` : ""}` };
}

function satisfiesLanguage(university: University, constraints: QueryConstraints) {
  const evaluation = languageEvaluation(university, constraints);
  return !evaluation || evaluation.state === "met";
}

function minimumGpaRequirement(university: University) {
  const rawCorpus = [
    university.summary,
    university.profile_sections?.map((section) => section.summary).join(" "),
    rowsText(programOf(university)?.application_deadlines),
    rowsText(programOf(university)?.source_links),
  ].join(" ");
  const scaleMatch =
    rawCorpus.match(/(?:gpa|grade point average|학점|평점)[^\d]{0,40}(\d+(?:\.\d+)?)[^\d]{0,24}(?:out of|\/|on a|scale|만점)[^\d]{0,12}(4(?:\.0|\.3|\.5)?|5(?:\.0)?|100)/i) ??
    rawCorpus.match(/(\d+(?:\.\d+)?)\s*(?:\/|out of)\s*(4(?:\.0|\.3|\.5)?|5(?:\.0)?|100)[^\n]{0,60}(?:gpa|grade point average|학점|평점)/i);
  if (scaleMatch) {
    const value = Number(scaleMatch[1]);
    const scale = Number(scaleMatch[2]);
    if (Number.isFinite(value) && Number.isFinite(scale)) return { value, scale };
  }

  const corpus = normalizeSearchText(
    [
      university.summary,
      university.profile_sections?.map((section) => section.summary).join(" "),
      rowsText(programOf(university)?.application_deadlines),
      rowsText(programOf(university)?.source_links),
    ].join(" "),
  );
  const match = corpus.match(/(?:gpa|grade point average|평점|학점)\s*(?:of|out of|기준|:)?\s*(\d+(?:\.\d+)?)/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return undefined;
  const inferredScale = value > 5 ? 100 : value > 4.5 ? 5 : 4.5;
  return { value, scale: inferredScale };
}

function convertSkkuGpa(userGpaFourPointFive: number, targetScale: number) {
  if (targetScale === 100) return (userGpaFourPointFive / 4.5) * 100;
  return (userGpaFourPointFive / 4.5) * targetScale;
}

function satisfiesGpa(university: University, constraints: QueryConstraints) {
  if (constraints.gpa === undefined) return true;
  const required = minimumGpaRequirement(university);
  if (required === undefined) return false;
  return convertSkkuGpa(constraints.gpa, required.scale) >= required.value;
}

function satisfiesMajor(university: University, constraints: QueryConstraints) {
  if (!constraints.major) return true;
  const corpus = normalizeSearchText(
    [
      university.university_name,
      university.summary,
      programOf(university)?.course_registration_notes,
      university.profile_sections?.map((section) => `${section.section_title} ${section.summary}`).join(" "),
    ].join(" "),
  );
  const keywords: Record<string, RegExp> = {
    engineering: /engineering|computer|software|information|공학|컴퓨터|소프트웨어|it/,
    business: /business|management|economics|경영|경제/,
    humanities: /humanities|social|language|인문|사회/,
    science: /science|biology|chemistry|physics|자연과학|생명|화학|물리/,
    arts: /art|design|architecture|예술|디자인|건축/,
  };
  return keywords[constraints.major]?.test(corpus) ?? !constraints.requireAll;
}

function quotaValue(university: University) {
  const program = programOf(university);
  for (const row of program?.quota_facts ?? []) {
    const value = numericValue(row.quota ?? row.value ?? row.amount ?? row.value_text);
    if (value !== undefined && value >= 0 && value <= 999) return value;
  }
  const corpus = normalizeSearchText(
    [
      university.summary,
      university.profile_sections?.map((section) => `${section.section_title} ${section.summary}`).join(" "),
      program ? JSON.stringify(program) : "",
    ].join(" "),
  );
  const match = corpus.match(/(?:quota|정원|파견 가능 인원|파견가능인원|파견 인원|선발 인원|모집 인원)\D{0,40}(\d{1,2})/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

function deadlineRowTime(row: Record<string, unknown>) {
  const text = cleanText(row.deadline_date, cleanText(row.date, cleanText(row.deadline_text)));
  const iso = text.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  if (iso) return Date.parse(iso);
  return undefined;
}

function deadlineSemesterOf(row: Record<string, unknown>): DeadlineSemester | undefined {
  const text = normalizeSearchText(`${cleanText(row.semester)} ${cleanText(row.deadline_text)}`);
  if (/autumn|fall|가을/.test(text)) return "autumn";
  if (/spring|봄/.test(text)) return "spring";
  return undefined;
}

function deadlineTypeOf(row: Record<string, unknown>): DeadlineType | undefined {
  const text = normalizeSearchText(`${cleanText(row.deadline_type)} ${cleanText(row.deadline_text)}`);
  if (/nomination|노미네이션|지명/.test(text)) return "nomination";
  if (/application|지원/.test(text)) return "application";
  return undefined;
}

function matchingDeadlineRows(university: University, constraints: QueryConstraints) {
  const rows = programOf(university)?.application_deadlines ?? [];
  return rows.filter((row) => {
    const time = deadlineRowTime(row);
    const year = time === undefined ? undefined : new Date(time).getUTCFullYear();
    if (constraints.deadlineAcademicYear !== undefined && year !== constraints.deadlineAcademicYear) return false;
    if (constraints.deadlineRequireClearYear && year === undefined) return false;
    if (constraints.deadlineSemester && deadlineSemesterOf(row) !== constraints.deadlineSemester) return false;
    if (constraints.deadlineType && deadlineTypeOf(row) !== constraints.deadlineType) return false;
    if (constraints.deadlineDate && constraints.deadlineComparator) {
      const actualDate = cleanText(row.deadline_date, cleanText(row.date)).match(/\d{4}-\d{2}-\d{2}/)?.[0];
      if (!actualDate || !compareIsoDate(actualDate, constraints.deadlineComparator, constraints.deadlineDate)) return false;
    }
    return true;
  });
}

function semesterEvidenceRows(university: University) {
  const program = programOf(university);
  return [...(program?.application_deadlines ?? []), ...(program?.academic_periods ?? [])];
}

function semesterEvaluation(university: University, semester: DeadlineSemester): ConditionCheck {
  const rows = semesterEvidenceRows(university);
  const recognized = rows.map(deadlineSemesterOf).filter((value): value is DeadlineSemester => value !== undefined);
  const label = "파견 학기";
  const requested = semester === "spring" ? "봄학기" : "가을학기";
  if (recognized.includes(semester)) return { key: "semester", label, state: "met", detail: `${requested} 일정 확인` };
  if (!recognized.length) return { key: "semester", label, state: "unknown", detail: `${requested} 일정 미확인` };
  return { key: "semester", label, state: "failed", detail: `${requested} 일정 없음` };
}

function earliestMatchingDeadlineTime(university: University, constraints: QueryConstraints) {
  const times = matchingDeadlineRows(university, constraints).map(deadlineRowTime).filter((value): value is number => value !== undefined);
  return times.length ? Math.min(...times) : Number.MAX_SAFE_INTEGER;
}

function passesStructuredFilters(university: University, constraints: QueryConstraints) {
  if (constraints.requireEurope && !isEuropeanUniversity(university)) return false;
  if (constraints.requireAsia && !isAsianUniversity(university)) return false;
  if (constraints.requireAmericas && !isAmericasUniversity(university)) return false;
  if (!matchesCountry(university, constraints.countries)) return false;
  if (constraints.excludedCountries.length && matchesCountry(university, constraints.excludedCountries)) return false;
  if (constraints.excludeAsia && isAsianUniversity(university)) return false;
  if (constraints.requireHousing) {
    const housingRows = programOf(university)?.housing_options ?? [];
    // Must match evaluateUniversity's three-state read of the same rows: no
    // rows at all is unconfirmed, and a row explicitly saying
    // housing_available: false is a confirmed "no" -- neither should pass a
    // "has housing" filter. Previously this only checked "does any row
    // exist", so a university whose only housing row said unavailable still
    // passed here while evaluateUniversity correctly marked it "failed",
    // making the two selection paths disagree about the same university.
    if (!housingRows.length || housingRows.every((row) => row.housing_available === false)) return false;
  }
  if (constraints.requireHousingGuaranteed) {
    const rows = programOf(university)?.housing_options ?? [];
    if (!rows.some((row) => row.housing_guaranteed === true || row.is_guaranteed === true)) return false;
  }
  if (constraints.requireHousingMissing && (programOf(university)?.housing_options?.length ?? 0) > 0) return false;
  if (constraints.intent === "restriction") {
    const rows = programOf(university)?.course_restrictions ?? [];
    const evidence = rows.map(rowText).join(" ");
    if (!/restricted|not available|approval required|prerequisite|limited|closed|수강 제한|전공 제한|선수 과목/i.test(evidence)) return false;
  }
  if (!satisfiesLanguage(university, constraints)) return false;
  if (!satisfiesGpa(university, constraints)) return false;
  if (!satisfiesMajor(university, constraints)) return false;
  if (constraints.quotaMin !== undefined) {
    const quota = quotaValue(university);
    if (quota === undefined || quota < constraints.quotaMin) return false;
  }
  if (constraints.quotaMode === "exists" || constraints.quotaMode === "sort_desc" || constraints.requireQuotaKnown) {
    if (quotaValue(university) === undefined) return false;
  }
  if (constraints.quotaMode === "missing" && quotaValue(university) !== undefined) return false;
  if (constraints.requireGpaKnown && minimumGpaRequirement(university) === undefined) return false;
  if (constraints.intent === "deadline") {
    const deadlines = matchingDeadlineRows(university, constraints);
    if (!deadlines.length) return false;
    if (constraints.deadlineSpringOnly) {
      const all = programOf(university)?.application_deadlines ?? [];
      if (!all.some((row) => deadlineSemesterOf(row) === "spring") || all.some((row) => deadlineSemesterOf(row) === "autumn")) return false;
    }
  }
  if (constraints.budgetKrwSemester !== undefined) {
    const cost = estimateSemesterCost(university, { requireClear: true });
    if (!cost || cost.normalizedKrw > constraints.budgetKrwSemester) return false;
  }
  if (constraints.requireClearCost && constraints.intent === "cost") {
    const cost = estimateSemesterCost(university, { requireClear: true });
    if (!cost || !cost.sourceUrl) return false;
  }
  if (constraints.requireOfficialSource) {
    if (constraints.intent === "cost") {
      const cost = estimateSemesterCost(university, { requireClear: true });
      if (!cost?.sourceUrl || isClearlyNonOfficialUrl(cost.sourceUrl)) return false;
    } else {
      const sources = universitySources(university);
      if (!sources.some((source) => source.is_official !== false && !isClearlyNonOfficialUrl(source.url))) return false;
    }
  }
  return true;
}

function evaluateUniversity(university: University, constraints: QueryConstraints): EvaluatedUniversity {
  const checks: ConditionCheck[] = [];
  const add = (key: string, label: string, state: ConditionState, detail: string) => checks.push({ key, label, state, detail });

  if (constraints.requireEurope) {
    add("region", "관심 대륙", isEuropeanUniversity(university) ? "met" : "failed", isEuropeanUniversity(university) ? "유럽 대학" : "유럽 외 대학");
  }
  if (constraints.requireAsia) {
    add("region", "관심 대륙", isAsianUniversity(university) ? "met" : "failed", isAsianUniversity(university) ? "아시아 대학" : "아시아 외 대학");
  }
  if (constraints.requireAmericas) {
    add("region", "관심 대륙", isAmericasUniversity(university) ? "met" : "failed", isAmericasUniversity(university) ? "미주 대학" : "미주 외 대학");
  }
  if (constraints.countries.length) {
    add("country", "국가", matchesCountry(university, constraints.countries) ? "met" : "failed", university.country);
  }
  if (constraints.excludedCountries.length && matchesCountry(university, constraints.excludedCountries)) {
    add("excluded_country", "제외 국가", "failed", `${university.country}은(는) 제외 조건에 해당`);
  }
  if (constraints.excludeAsia && isAsianUniversity(university)) {
    add("excluded_region", "제외 대륙", "failed", "아시아 대학은 제외 조건에 해당");
  }

  if (constraints.requireHousing) {
    const rows = programOf(university)?.housing_options ?? [];
    if (!rows.length) add("housing_available", "기숙사 제공", "unknown", "제공 여부 미확인");
    else if (rows.every((row) => row.housing_available === false)) add("housing_available", "기숙사 제공", "failed", "없음");
    else add("housing_available", "기숙사 제공", "met", "있음");
  }

  if (constraints.requireHousingGuaranteed) {
    const rows = programOf(university)?.housing_options ?? [];
    const guaranteed = rows.some((row) => row.housing_guaranteed === true || row.is_guaranteed === true);
    const notGuaranteed = rows.some((row) => row.housing_guaranteed === false || row.is_guaranteed === false);
    if (guaranteed) add("housing_guaranteed", "배정 보장", "met", "보장");
    else if (notGuaranteed) add("housing_guaranteed", "배정 보장", "failed", "명시적으로 보장되지 않음");
    else add("housing_guaranteed", "배정 보장", "unknown", "확인 필요");
  }

  if (constraints.deadlineSemester) {
    checks.push(semesterEvaluation(university, constraints.deadlineSemester));
  }

  if (constraints.languageTest && constraints.languageScore !== undefined) {
    const languageCheck = languageEvaluation(university, constraints);
    if (languageCheck) checks.push(languageCheck);
  }

  if (constraints.gpa !== undefined) {
    const required = minimumGpaRequirement(university);
    if (!required) add("gpa", "최소 GPA", "unknown", "최소 GPA 미확인");
    else {
      const converted = convertSkkuGpa(constraints.gpa, required.scale);
      add("gpa", "최소 GPA", converted >= required.value ? "met" : "failed", `성균관대 ${constraints.gpa}/4.5 → 약 ${converted.toFixed(2)}/${required.scale}, 요구 ${required.value}`);
    }
  }

  if (constraints.major) {
    add("major", "전공", satisfiesMajor(university, constraints) ? "met" : "unknown", satisfiesMajor(university, constraints) ? "관련 전공 정보 확인" : "전공 개설·수강 제한 미확인");
  }
  if (constraints.intent === "restriction") {
    const rows = programOf(university)?.course_restrictions ?? [];
    const evidence = rows.map(rowText).join(" ");
    const hasRestriction = /restricted|not available|approval required|prerequisite|limited|closed|수강 제한|전공 제한|선수 과목/i.test(evidence);
    add("restriction", "수강 제한", hasRestriction ? "met" : "unknown", hasRestriction ? cleanText(evidence).slice(0, 240) : "명시적 제한 근거 미확인");
  }
  if (constraints.requireGpaKnown && constraints.gpa === undefined) {
    const required = minimumGpaRequirement(university);
    add("gpa_exists", "GPA 근거", required ? "met" : "unknown", required ? `최소 GPA ${required.value}/${required.scale}` : "최소 GPA 미확인");
  }
  if (constraints.requireQuotaKnown && constraints.quotaMin === undefined && !constraints.quotaMode) {
    const quota = quotaValue(university);
    add("quota_exists", "Quota 근거", quota !== undefined ? "met" : "unknown", quota !== undefined ? `Quota ${quota}명` : "Quota 미확인");
  }

  if (constraints.quotaMin !== undefined) {
    const quota = quotaValue(university);
    if (quota === undefined) add("quota", "파견 정원", "unknown", "Quota 미확인");
    else add("quota", "파견 정원", quota >= constraints.quotaMin ? "met" : "failed", `확인된 Quota ${quota}명`);
  }
  if (constraints.quotaMin === undefined && constraints.quotaMode) {
    const quota = quotaValue(university);
    if (constraints.quotaMode === "missing") {
      add("quota", "파견 정원", quota === undefined ? "met" : "failed", quota === undefined ? "Quota 미확인" : `Quota ${quota}명 확인됨`);
    } else {
      add("quota", "파견 정원", quota === undefined ? "unknown" : "met", quota === undefined ? "Quota 미확인" : `Quota ${quota}명`);
    }
  }
  if (constraints.requireHousingMissing) {
    const hasHousing = (programOf(university)?.housing_options?.length ?? 0) > 0;
    add("housing_missing", "기숙사 정보 없음", hasHousing ? "failed" : "met", hasHousing ? "기숙사 정보가 등록됨" : "기숙사 정보 미확인");
  }

  if (constraints.requireOfficialSource) {
    const hasOfficial = universitySources(university).some((source) => source.is_official !== false && !isClearlyNonOfficialUrl(source.url));
    add("official_source", "공식 출처", hasOfficial ? "met" : "unknown", hasOfficial ? "공식 출처 확인" : "공식 출처 미확인");
  }

  const status = checks.some((check) => check.state === "failed")
    ? "excluded"
    : checks.some((check) => check.state === "unknown")
      ? "partial"
      : "matched";
  return { university, checks, status };
}

function sourceTypeLabel(value: unknown) {
  const text = cleanText(value, "source");
  return text.replace(/_/g, " ");
}

function universitySources(university: University): ChatSource[] {
  const sources: ChatSource[] = [];
  const program = programOf(university);

  for (const row of program?.source_links ?? []) {
    const url = cleanText(row.url);
    if (!isValidHttpUrl(url)) continue;
    sources.push({
      title: cleanText(row.title, sourceTypeLabel(row.source_type)),
      url,
      university_name: university.university_name,
      source_type: cleanText(row.source_type),
      is_official: row.is_official !== false,
      field_key: "source_links",
      evidence_quote: cleanText(row.evidence_quote, ""),
    });
  }

  for (const section of university.profile_sections ?? []) {
    const url = cleanText(section.evidence_url);
    if (!isValidHttpUrl(url)) continue;
    sources.push({
      title: section.section_title || `Section ${section.section_number}`,
      url,
      university_name: university.university_name,
      source_type: "profile_section",
      is_official: !url.includes("blog.naver.com"),
      field_key: `section_${section.section_number}`,
      evidence_quote: cleanText(section.summary, "").slice(0, 220),
    });
  }

  for (const [title, url] of [
    ["Incoming Exchange Page", university.incoming_exchange_url],
    ["Official Website", university.official_website_url],
  ] as const) {
    if (url && isValidHttpUrl(url)) {
      sources.push({
        title,
        url,
        university_name: university.university_name,
        source_type: title,
        is_official: true,
      });
    }
  }

  return sources;
}

function urlHost(value: string | undefined) {
  if (!value) return "";
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function looksLikeOtherUniversitySource(university: University, source: ChatSource) {
  const title = normalizeSearchText(source.title);
  const ownName = normalizeSearchText(university.university_name);
  if (!/(university|school|college|institut|universite)/.test(title)) return false;
  const ownTokens = ownName.split(/\s+/).filter((token) => token.length >= 4);
  return ownTokens.length > 0 && !ownTokens.some((token) => title.includes(token));
}

function sourceScore(university: University, source: ChatSource, intent: Intent) {
  const text = normalizeSearchText(`${source.title} ${source.source_type} ${source.url}`);
  const officialHost = urlHost(university.official_website_url);
  const incomingHost = urlHost(university.incoming_exchange_url);
  const sourceHost = urlHost(source.url);
  const isOwnDomain = Boolean(
    sourceHost &&
      ((officialHost && (sourceHost === officialHost || sourceHost.endsWith(`.${officialHost}`))) ||
        (incomingHost && (sourceHost === incomingHost || sourceHost.endsWith(`.${incomingHost}`)))),
  );
  const keyword: Record<Intent, RegExp> = {
    housing: /housing|accommodation|residence|dorm|기숙|숙소/,
    language: /language|ielts|toefl|english|어학|영어/,
    cost: /cost|fee|tuition|housing|accommodation|living|비용|학비|등록금|기숙/,
    deadline: /application|deadline|nomination|calendar|마감|일정|지원/,
    quota: /fact|exchange|application|quota|정원/,
    restriction: /restricted|restriction|prerequisite|approval|required|limited|course|subject/,
    source: /./,
    general: /exchange|incoming|fact|official/,
  };

  let score = 0;
  if (isOwnDomain) score += 20;
  if (source.is_official !== false) score += 8;
  if (keyword[intent].test(text)) score += 6;
  if (/incoming|exchange|fact|official/.test(text)) score += 4;
  if (looksLikeOtherUniversitySource(university, source)) score -= 18;
  if (/blog|naver|youtube|drive\.google|docs\.google/.test(text)) score -= 8;
  return score;
}

function firstSource(university: University, intent: Intent) {
  const sources = universitySources(university);
  return sources
    .map((source) => ({ source, score: sourceScore(university, source, intent) }))
    .sort((a, b) => b.score - a.score)[0]?.source;
}

function sourceFromIntentRows(university: University, intent: Intent) {
  const rows = relevantRows(university, intent);
  for (const row of rows) {
    const source = rowSource(university, row, intent === "cost" ? "estimated_costs" : `${intent}_facts`, actionLabel(intent));
    if (source) return source;
  }
  return firstSource(university, intent);
}

function actionLabel(intent: Intent) {
  if (intent === "housing") return "기숙사 정보 보기";
  if (intent === "language") return "어학 조건 보기";
  if (intent === "cost") return "비용 정보 보기";
  if (intent === "deadline") return "지원 일정 보기";
  if (intent === "quota") return "정원 정보 보기";
  if (intent === "restriction") return "수강 제한 보기";
  if (intent === "source") return "출처 확인하기";
  return "상세 정보 보기";
}

function sourceFieldForIntent(intent: Intent) {
  if (intent === "cost") return "cost_facts";
  if (intent === "housing") return "housing_facts";
  if (intent === "language") return "language_requirements";
  if (intent === "deadline") return "application_deadlines";
  return `${intent}_facts`;
}

function factEvidenceFromRow(university: University, row: Record<string, unknown>, intent: Intent, table: string): FactEvidence {
  const source = rowSource(university, row, table, actionLabel(intent));
  return {
    fact_id: cleanText(row.fact_id, cleanText(row.id)),
    table,
    field_key: table,
    label: actionLabel(intent),
    value: highlightFromRow(row, intent),
    source_url: source?.url,
    source_title: source?.title,
    source_type: source?.source_type,
    evidence_quote: source?.evidence_quote,
    confidence: row.confidence,
    review_status: row.review_status,
  };
}

function factBundleForCard(university: University, intent: Intent, cost?: CostEstimate): FactEvidence[] {
  if (intent === "cost" && cost) {
    return cost.components
      .map((component) => ({
        ...factEvidenceFromRow(university, component.row, "cost", component.category === "housing" ? "housing_facts" : "cost_facts"),
        label: component.category,
        value: component.label,
        source_url: component.source?.url,
        source_title: component.source?.title,
        source_type: component.source?.source_type,
        evidence_quote: component.source?.evidence_quote,
      }))
      .filter((item) => item.fact_id || item.source_url || item.evidence_quote)
      .slice(0, 5);
  }

  const rows = relevantRows(university, intent);
  const sortedRows = intent === "deadline" ? [...rows].sort((a, b) => (deadlineRowTime(a) ?? Number.MAX_SAFE_INTEGER) - (deadlineRowTime(b) ?? Number.MAX_SAFE_INTEGER)) : rows;

  return sortedRows
    .slice(0, 5)
    .map((row) => factEvidenceFromRow(university, row, intent, sourceFieldForIntent(intent)))
    .filter((item) => item.fact_id || item.source_url || item.evidence_quote);
}

function requestedFactBundle(
  university: University,
  primaryIntent: Intent,
  requestedFields: string[],
  primaryCost?: CostEstimate,
) {
  const intents = [
    primaryIntent,
    ...requestedFields.map((field) => REQUEST_FIELD_TO_INTENT[field]).filter((intent): intent is Intent => Boolean(intent)),
  ].filter((intent, index, items) => items.indexOf(intent) === index);
  const seen = new Set<string>();
  return intents.flatMap((intent) => {
    const cost = intent === "cost" ? (primaryCost ?? estimateSemesterCost(university, { requireClear: false })) : undefined;
    return factBundleForCard(university, intent, cost);
  }).filter((fact) => {
    const key = fact.fact_id || `${fact.table}:${fact.value}:${fact.source_url ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 16);
}

function makeCard(candidate: RankedCandidate, intent: Intent, requestedFields: string[] = []): ResultCard {
  const { university, cost } = candidate;
  const rows = relevantRows(university, intent);
  const section = sectionText(university, intent);
  const factBundle = requestedFactBundle(university, intent, requestedFields, cost);
  const source = cost?.sourceUrl
    ? {
        fact_id: factBundle.find((fact) => fact.source_url === cost.sourceUrl)?.fact_id,
        url: cost.sourceUrl,
        title: cost.sourceTitle ?? "비용 출처",
        source_type: cost.sourceType,
        evidence_quote: cost.evidenceQuote,
      }
    : sourceFromIntentRows(university, intent);
  const highlights = [
    ...(intent === "cost" && cost ? [cost.label] : []),
    ...(intent === "cost" ? [housingGuaranteeSummary(university)] : []),
    ...rows.slice(0, 3).map((row) => highlightFromRow(row, intent)),
    ...(!rows.length && section ? section.split(/[.\n]/).map((item) => item.trim()).filter(Boolean).slice(0, 2) : []),
  ].filter(Boolean).slice(0, 3);

  return {
    university_id: university.id,
    university_name: university.university_name,
    country: university.country,
    city: university.city,
    summary: cleanText(university.summary, "등록된 대학 정보는 공식 출처를 기반으로 확인이 필요합니다.").slice(0, 180),
    badges: [university.country, university.city, programOf(university)?.academic_year ?? "2026/27"].filter(Boolean).slice(0, 3),
    highlights: highlights.length ? highlights : ["등록된 Supabase 데이터에서 상세 정보를 확인할 수 있습니다."],
    action_label: actionLabel(intent),
    action_url: `/universities/${university.id}`,
    source_url: source?.url,
    source_title: source?.title,
    source_type: source?.source_type,
    source_fact_id: source?.fact_id,
    source_field_key: source?.field_key,
    evidence_quote: source?.evidence_quote,
    fact_bundle: factBundle,
  };
}

function significantNameTokens(value: string) {
  return normalizeSearchText(value)
    .split(/\s+/)
    .filter((token) => token.length >= 4 && !["university", "school", "college", "institute", "national"].includes(token));
}

function targetUniversityScore(university: University, question: string) {
  const q = normalizeSearchText(question);
  const name = normalizeSearchText(university.university_name);
  const city = normalizeSearchText(university.city);
  if (!q || !name) return 0;
  if (q.includes(name)) return 100;

  const tokens = significantNameTokens(university.university_name);
  if (tokens.length >= 2 && tokens.every((token) => q.includes(token))) return 92;
  if (tokens.length >= 1 && tokens.some((token) => q.includes(token)) && /university|school|college|대학|학교/.test(q)) return 72;
  if (city && city.length >= 5 && q.includes(city) && tokens.some((token) => q.includes(token))) return 68;
  return 0;
}

function findTargetUniversities(universities: University[], question: string) {
  const ranked = universities
    .map((university) => ({ university, score: targetUniversityScore(university, question) }))
    .filter((item) => item.score >= 70)
    .sort((a, b) => b.score - a.score);
  const exact = ranked.filter((item) => item.score >= 90);
  return (exact.length ? exact : ranked)
    .map((item) => item.university)
    .slice(0, 3);
}

function isFollowupReference(question: string) {
  return /방금\s*(?:추천한|말한)|이\s*(?:학교|대학)들?|그\s*(?:학교|대학)들?|위\s*(?:학교|대학)들?|앞서\s*(?:추천한|언급한)|추천한\s*(?:학교|대학)들?|(?:둘|셋|넷|그|이)\s*중(?:에|에서)?|(?:첫|두|세)\s*번째\s*(?:학교|대학)|거기|그곳|그\s*(?:학교|대학)|어디가\s*더|어느\s*(?:곳|학교|대학)이?\s*더|조건이\s*더\s*(?:적|낮|쉬)|라고\s*했는데|왜\s+.+(?:추천|나와)|those\s*(?:universities|schools)|these\s*(?:universities|schools)|which\s+one/i.test(question.normalize("NFKC"));
}

function followupComparisonLimit(question: string) {
  const normalized = question.normalize("NFKC").toLowerCase();
  if (/둘\s*중/.test(normalized)) return 2;
  if (/셋\s*중/.test(normalized)) return 3;
  if (/넷\s*중/.test(normalized)) return 4;
  return undefined;
}

function previousContextUniversities(universities: University[], messages: ChatMessage[]) {
  const previousAssistant = [...messages].reverse().find((message) => message.role === "assistant")?.content ?? "";
  if (!previousAssistant) return [];
  return universities.filter((university) => {
    const normalizedAnswer = normalizeSearchText(previousAssistant);
    const normalizedName = normalizeSearchText(university.university_name);
    return normalizedName.length > 4 && normalizedAnswer.includes(normalizedName);
  });
}

function explicitUnknownInstitution(question: string, exactTargets: University[]) {
  if (exactTargets.length) return undefined;
  const normalized = question.normalize("NFKC");
  const match = normalized.match(/\b([A-Z][A-Za-z'&.-]*(?:\s+[A-Z][A-Za-z'&.-]*){0,6}\s+(?:University|College|School|Institute))\b/);
  return match?.[1];
}

function unknownInstitutionResponse(name: string, universityCount: number) {
  const answer = `현재 등록된 ${universityCount}개 교환대학에서 **${name}**을(를) 찾지 못했습니다. 비슷한 이름의 다른 대학을 대신 추천하지 않았습니다.`;
  return NextResponse.json({
    answer,
    shortAnswer: answer,
    detailedAnswer: ["### 등록 대학 검색 결과", "", answer].join("\n"),
    cards: [],
    sources: [],
    matched: [],
    partially_matched: [],
    excluded_count: 0,
    unknown_fields: ["university"],
    searchMode: "등록 대학명 정확 일치 검사 결과 없음",
  });
}

function selectCards(universities: University[], constraints: QueryConstraints, question: string) {
  const exactTargets = findTargetUniversities(universities, question);
  if (exactTargets.length) {
    return exactTargets
      .filter((university) => {
        if (constraints.requireEurope && !isEuropeanUniversity(university)) return false;
        if (constraints.requireAsia && !isAsianUniversity(university)) return false;
        if (constraints.requireAmericas && !isAmericasUniversity(university)) return false;
        if (!matchesCountry(university, constraints.countries)) return false;
        if (constraints.excludedCountries.length && matchesCountry(university, constraints.excludedCountries)) return false;
        if (constraints.excludeAsia && isAsianUniversity(university)) return false;
        return true;
      })
      .slice(0, constraints.topN)
      .map((university) => {
        return makeCard({ university, score: 100 }, constraints.intent, constraints.requestedFields);
      });
  }

  const pool = universities.filter((university) => passesStructuredFilters(university, constraints));

  if (constraints.intent === "cost" || constraints.budgetKrwSemester !== undefined) {
    const ranked = pool
      .map((university) => ({
        university,
        score: scoreUniversity(university, constraints.intent, question),
        cost: estimateSemesterCost(university, { requireClear: constraints.requireClearCost || constraints.requireOfficialSource || constraints.budgetKrwSemester !== undefined }),
      }))
      .filter((candidate): candidate is RankedCandidate & { cost: CostEstimate } => Boolean(candidate.cost))
      .sort((a, b) => {
        const costDiff = a.cost.normalizedKrw - b.cost.normalizedKrw;
        if (costDiff !== 0) return costDiff;
        return b.cost.categoryCount - a.cost.categoryCount;
      })
      .slice(0, constraints.topN);

    if (ranked.length) return ranked.map((candidate) => makeCard(candidate, constraints.intent, constraints.requestedFields));
  }

  const ranked = pool
    .map((university) => ({ university, score: scoreUniversity(university, constraints.intent, question) }))
    .filter(({ score }, index) => score > 0 || (constraints.intent === "general" && index < constraints.topN))
    .sort((a, b) => {
      if (constraints.quotaMode === "sort_desc") return (quotaValue(b.university) ?? -1) - (quotaValue(a.university) ?? -1);
      if (constraints.sortGpaLowest) {
        const aGpa = minimumGpaRequirement(a.university);
        const bGpa = minimumGpaRequirement(b.university);
        const aNormalized = aGpa ? (aGpa.value / aGpa.scale) * 4.5 : Number.MAX_SAFE_INTEGER;
        const bNormalized = bGpa ? (bGpa.value / bGpa.scale) * 4.5 : Number.MAX_SAFE_INTEGER;
        return aNormalized - bNormalized;
      }
      if (constraints.sortDeadlineEarliest) return earliestMatchingDeadlineTime(a.university, constraints) - earliestMatchingDeadlineTime(b.university, constraints);
      return b.score - a.score;
    })
    .slice(0, constraints.topN);

  return ranked.map((candidate) => makeCard(candidate, constraints.intent, constraints.requestedFields));
}

function hasRecommendationConditions(constraints: QueryConstraints) {
  return Boolean(
      constraints.requireEurope ||
      constraints.requireAsia ||
      constraints.requireAmericas ||
      constraints.countries.length ||
      constraints.excludedCountries.length ||
      constraints.excludeAsia ||
      constraints.requireHousing ||
      constraints.requireHousingGuaranteed ||
      constraints.deadlineSemester !== undefined ||
      constraints.languageScore !== undefined ||
      constraints.gpa !== undefined ||
      constraints.major ||
      constraints.quotaMin !== undefined ||
      constraints.quotaMode !== undefined ||
      constraints.requireGpaKnown ||
      constraints.sortGpaLowest ||
      constraints.requireQuotaKnown ||
      constraints.requireHousingMissing ||
      constraints.requireOfficialSource,
  );
}

function selectClassifiedCards(universities: University[], constraints: QueryConstraints, question: string) {
  const evaluated = universities.map((university) => evaluateUniversity(university, constraints));
  const rank = (items: EvaluatedUniversity[], limit: number) =>
    items
      .map((item) => ({ item, score: scoreUniversity(item.university, constraints.intent, question) }))
      .sort((a, b) => {
        if (constraints.quotaMode === "sort_desc") return (quotaValue(b.item.university) ?? -1) - (quotaValue(a.item.university) ?? -1);
        if (constraints.sortGpaLowest) {
          const aGpa = minimumGpaRequirement(a.item.university);
          const bGpa = minimumGpaRequirement(b.item.university);
          const aNormalized = aGpa ? (aGpa.value / aGpa.scale) * 4.5 : Number.MAX_SAFE_INTEGER;
          const bNormalized = bGpa ? (bGpa.value / bGpa.scale) * 4.5 : Number.MAX_SAFE_INTEGER;
          return aNormalized - bNormalized;
        }
        if (constraints.sortDeadlineEarliest) return earliestMatchingDeadlineTime(a.item.university, constraints) - earliestMatchingDeadlineTime(b.item.university, constraints);
        return b.score - a.score;
      })
      .slice(0, limit)
      .map(({ item, score }) => {
        const card = makeCard({ university: item.university, score }, constraints.intent, constraints.requestedFields);
        card.match_status = item.status === "matched" ? "matched" : "partial";
        card.condition_checks = item.checks.map((check) => ({
          ...check,
          detail: presentConditionCheck(check).value ?? "확인 필요",
        }));
        card.unknown_fields = item.checks.filter((check) => check.state === "unknown").map((check) => check.label);
        return card;
      });

  const matched = rank(evaluated.filter((item) => item.status === "matched"), Math.min(constraints.topN, 5));
  const partiallyMatched = rank(evaluated.filter((item) => item.status === "partial"), 3);
  const excluded = evaluated.filter((item) => item.status === "excluded");
  return { matched, partiallyMatched, excluded };
}

function deterministicClassifiedAnswer(matched: ResultCard[], partiallyMatched: ResultCard[]) {
  const lines: string[] = [];
  const cell = (value: string) => cleanText(value).replace(/\|/g, "/").replace(/\s+/g, " ").trim();
  const allCards = [...matched, ...partiallyMatched];
  const columnCandidates = [
    { key: "housing_available", label: "기숙사 제공" },
    { key: "housing_guaranteed", label: "배정 보장" },
    { key: "semester", label: "파견 학기" },
    { key: "language", label: "어학" },
    { key: "gpa", label: "GPA" },
    { key: "gpa_exists", label: "최소 GPA" },
    { key: "major", label: "전공" },
    { key: "quota", label: "Quota" },
    { key: "official_source", label: "공식 출처" },
  ];
  const columns = columnCandidates.filter((column) => allCards.some((card) => card.condition_checks?.some((check) => check.key === column.key)));
  const checkCell = (card: ResultCard, key: string) => {
    const check = card.condition_checks?.find((item) => item.key === key);
    if (!check) return "-";
    const presented = presentConditionCheck(check);
    if (check.state === "unknown") return presented.value ?? "확인 필요";
    if (check.state === "failed") return `미충족 · ${presented.value ?? "조건 미충족"}`;
    return presented.value ?? "조건 충족";
  };
  const header = ["순위", "대학", "위치", ...columns.map((column) => column.label)];
  const separator = header.map((_, index) => index === 0 ? "---:" : "---");
  if (matched.length) {
    lines.push(`### 조건 충족 대학 (${matched.length}개)`, "", `| ${header.join(" | ")} |`, `|${separator.join("|")}|`);
    matched.forEach((card, index) => {
      const values = columns.map((column) => cell(checkCell(card, column.key)));
      lines.push(`| ${index + 1} | **${cell(card.university_name)}** | ${cell(`${card.country} · ${card.city}`)} | ${values.join(" | ")} |`);
    });
  } else {
    lines.push("### 검색 결과", "", "모든 조건이 확인된 대학은 찾지 못했습니다.");
  }
  if (partiallyMatched.length) {
    const partialHeader = ["대학", ...columns.map((column) => column.label), "판정"];
    lines.push("", `### 추가 확인이 필요한 후보 (${partiallyMatched.length}개)`, "", `| ${partialHeader.join(" | ")} |`, `|${partialHeader.map(() => "---").join("|")}|`);
    partiallyMatched.forEach((card) => {
      const values = columns.map((column) => cell(checkCell(card, column.key)));
      lines.push(`| **${cell(card.university_name)}** | ${values.join(" | ")} | ${cell(card.unknown_fields?.join(", ") || "추가 확인 필요")} |`);
    });
    lines.push("", "> 위 후보는 일부 조건의 데이터가 없어 모든 조건을 충족한다고 확정할 수 없습니다.");
  }
  return lines.join("\n");
}

function restrictionEvidence(card: ResultCard[]) {
  return card.flatMap((item) => [
    ...(item.fact_bundle ?? []).map((fact) => `${fact.value} ${fact.evidence_quote ?? ""}`),
    ...item.highlights,
  ]).filter((text) => /restricted|not available|approval required|prerequisite|limited|closed|수강 제한|전공 제한|선수 과목/i.test(text));
}

function deterministicRestrictionAnswer(cards: ResultCard[]) {
  const lines: string[] = ["### 확인된 수강 제한", ""];
  let found = false;
  for (const card of cards) {
    const evidence = restrictionEvidence([card]);
    if (!evidence.length) continue;
    found = true;
    lines.push(`- **${card.university_name}**`, ...evidence.slice(0, 3).map((text) => `  - ${cleanText(text).slice(0, 500)}`));
  }
  if (!found) {
    return ["### 확인 결과", "", "명시적인 수강 제한 근거를 확인하지 못했습니다.", "", "- 전공명이 등장한다는 이유만으로 제한이 있다고 판단하지 않았습니다.", "- 지원 전 해당 대학의 최신 Course Catalog를 확인해 주세요."].join("\n");
  }
  lines.push("", "> 위 내용은 DB에 저장된 제한 문구만 정리했으며, 확인되지 않은 조건은 추가하지 않았습니다.");
  return lines.join("\n");
}

function collectSources(cards: ResultCard[]): ChatSource[] {
  const seen = new Set<string>();
  const sources: ChatSource[] = [];

  for (const card of cards) {
    for (const fact of card.fact_bundle ?? []) {
      if (!fact.source_url || !isValidHttpUrl(fact.source_url)) continue;
      const key = `${card.university_id}:${fact.source_url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      seen.add(fact.source_url);
      sources.push({
        fact_id: fact.fact_id,
        title: fact.source_title || fact.label || "근거 출처",
        url: fact.source_url,
        university_name: card.university_name,
        source_type: fact.source_type || fact.table,
        is_official: !isClearlyNonOfficialUrl(fact.source_url),
        field_key: fact.field_key,
        evidence_quote: fact.evidence_quote,
      });
    }
    if (!card.source_url || !isValidHttpUrl(card.source_url) || seen.has(card.source_url)) continue;
    seen.add(card.source_url);
    seen.add(`${card.university_id}:${card.source_url}`);
    sources.push({
      title: card.source_title || "근거 출처",
      url: card.source_url,
      university_name: card.university_name,
      source_type: card.source_type || "row_source",
      is_official: !isClearlyNonOfficialUrl(card.source_url),
      field_key: card.source_field_key,
      evidence_quote: card.evidence_quote,
    });
  }

  return sources.slice(0, Math.max(3, cards.length));
}

function searchMode(intent: Intent) {
  if (intent === "general") return "Supabase 대학 데이터 필터링 + Solar Pro 3 요약";
  if (intent === "cost") return "Supabase 구조화 비용 필드 필터링/정렬 + row 단위 출처";
  return "Supabase 구조화 필드 1차 후보 추림 + Solar Pro 3 설명";
}

function deterministicDirectCostAnswer(cards: ResultCard[]) {
  const cell = (value: string) => cleanText(value).replace(/\|/g, "/").replace(/\s+/g, " ").trim();
  const rows = cards.flatMap((card) => {
    const facts = (card.fact_bundle ?? [])
      .filter((fact) => fact.table === "cost_facts" || fact.table === "housing_facts")
      .map((fact) => fact.value)
      .filter(Boolean)
      .slice(0, 4);
    return facts.map((fact) => `| **${cell(card.university_name)}** | ${cell(fact)} |`);
  });

  return [
    "### 확인된 비용 정보",
    "",
    ...(rows.length ? ["| 대학 | 비용과 과금 기간 |", "|---|---|", ...rows] : ["공식 비용 금액을 확인하기 어렵습니다."]),
    "",
    "### 확인사항",
    "- 금액은 원래 통화와 과금 기간을 그대로 표시했습니다.",
    "- 개인 지출을 포함한 총비용으로 합산하지 않았습니다.",
  ].join("\n");
}

function deterministicFactAnswer(cards: ResultCard[], intent: "housing" | "language") {
  const cell = (value: string) => cleanText(value).replace(/\|/g, "/").replace(/\s+/g, " ").trim();
  const title = intent === "housing" ? "기숙사 정보" : "어학 조건";
  const rows = cards.flatMap((card) => {
    const facts = (card.fact_bundle ?? []).filter((fact) =>
      intent === "housing" ? fact.table === "housing_facts" : fact.table === "language_requirements",
    );
    const values = facts.length
      ? facts.map((fact) => fact.value)
      : card.highlights.filter((value) =>
          intent === "housing" ? /기숙|주거|housing|accommodation|residence/i.test(value) : /IELTS|TOEFL|CEFR|어학|English/i.test(value),
        );
    return values.filter(Boolean).slice(0, 5).map((value) => `| **${cell(card.university_name)}** | ${cell(value)} |`);
  });

  return [
    `### ${title}`,
    "",
    ...(rows.length ? ["| 대학 | 확인된 내용 |", "|---|---|", ...rows] : ["현재 등록된 자료에서 확인할 수 있는 정보가 없습니다."]),
    "",
    "### 확인사항",
    intent === "housing"
      ? "- 금액·보장 여부·신청 일정이 저장되지 않은 경우 임의로 추정하지 않습니다."
      : "- 시험별 최소 점수와 세부 영역 점수는 확인된 값만 표시합니다.",
    "- 최신 정보는 아래 공식 근거에서 다시 확인해 주세요.",
  ].join("\n");
}

function sanitizeGeneratedAnswer(value: string) {
  return value
    .split(/\r?\n/)
    .filter((line) => !/(?:€|EUR|USD|GBP|KRW|원|달러|파운드)?\s*(?:XXX|TBD|미정)(?:\s*(?:€|EUR|USD|GBP|KRW|원|달러|파운드))?/i.test(line))
    .filter((line) => !/^현재 Supabase(?:의|에)\b/.test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function plainTextSummary(value: string, maxLength = 320) {
  const text = value
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*]\s+/gm, "")
    .replace(/\|/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength).trim()}...` : text;
}

function shortAnswerFor(cards: ResultCard[], detailedAnswer: string) {
  if (cards.length === 1) {
    const card = cards[0];
    const points = card.highlights.filter(Boolean).slice(0, 3).map((item) => `- ${plainTextSummary(item, 90)}`);
    return [`**${card.university_name}**의 확인된 정보를 정리했습니다.`, ...points].join("\n");
  }

  if (cards.length > 1) {
    const names = cards.slice(0, 3).map((card) => `- ${card.university_name}`);
    const suffix = cards.length > 3 ? `\n- 그 외 ${cards.length - 3}개 대학` : "";
    return [`조건과 관련된 대학 ${cards.length}개를 찾았습니다.`, ...names].join("\n") + suffix;
  }

  return plainTextSummary(detailedAnswer);
}

function responsePresentation(detailedAnswer: string, cards: ResultCard[]) {
  return {
    answer: detailedAnswer,
    shortAnswer: shortAnswerFor(cards, detailedAnswer),
    detailedAnswer,
  };
}

function authoritativeShortAnswer(cards: ResultCard[], fallback: string) {
  const classified = cards.filter((card) => card.match_status === "matched" || card.match_status === "partial");
  if (!classified.length) return fallback;

  const matched = classified.filter((card) => card.match_status === "matched");
  const partial = classified.filter((card) => card.match_status === "partial");
  const lines: string[] = [];

  if (matched.length) {
    lines.push(`조건을 모두 충족한 대학은 **${matched.length}곳**입니다.`);
    lines.push(...matched.map((card) => `- ${card.university_name}`));
  } else {
    lines.push("현재 등록된 자료에서 모든 조건을 확인하고 충족한 대학은 없습니다.");
  }

  if (partial.length) {
    lines.push("", `추가로 **${partial.length}곳**은 일부 조건 확인이 필요합니다. 상세 결과에서 확인해 주세요.`);
  }

  return lines.join("\n");
}

function plannerIntent(intent: QueryPlan["intent"]): Intent | undefined {
  const map: Partial<Record<QueryPlan["intent"], Intent>> = {
    university_lookup: "general",
    university_recommendation: "general",
    language_requirement: "language",
    housing: "housing",
    cost: "cost",
    deadline: "deadline",
    quota: "quota",
    course_restriction: "restriction",
    source_request: "source",
    followup: "general",
  };
  return map[intent];
}

function applyValidatedPlannerPlan(legacy: QueryConstraints, plan: QueryPlan | null): QueryConstraints {
  if (!plan) return legacy;
  const hard = plan.hardFilters;
  const plannedIntent = plannerIntent(plan.intent);
  const regions = (hard.regions ?? []).map(normalizeSearchText);
  const excludedRegions = (hard.excludedRegions ?? []).map(normalizeSearchText);
  const languageTest = hard.ieltsMax !== undefined ? "IELTS" : hard.toeflMax !== undefined ? "TOEFL" : legacy.languageTest;
  const languageScore = hard.ieltsMax ?? hard.toeflMax ?? legacy.languageScore;
  const resolvedIntent = legacy.intent !== "general" ? legacy.intent : (plannedIntent ?? legacy.intent);
  const requestedFields = [...new Set([...legacy.requestedFields, ...plan.requestedFields])];
  return {
    ...legacy,
    intent: resolvedIntent,
    topN: legacy.topN !== 4 ? legacy.topN : plan.limit,
    requireEurope: regions.some((item) => item === "europe") || legacy.requireEurope,
    requireAsia: regions.some((item) => item === "asia") || legacy.requireAsia,
    requireAmericas: regions.some((item) => /americas?|north america|south america/.test(item)) || legacy.requireAmericas,
    countries: legacy.countries.length ? legacy.countries : (hard.countries ?? []),
    excludedCountries: legacy.excludedCountries.length ? legacy.excludedCountries : (hard.excludedCountries ?? []),
    excludeAsia: excludedRegions.some((item) => item === "asia") || legacy.excludeAsia,
    requireHousing: hard.housingAvailable ?? hard.housingGuaranteed ?? legacy.requireHousing,
    requireHousingGuaranteed: hard.housingGuaranteed ?? legacy.requireHousingGuaranteed,
    deadlineSemester: (hard.semesters ?? []).some((item) => /spring|봄/i.test(item))
      ? "spring"
      : (hard.semesters ?? []).some((item) => /autumn|fall|가을/i.test(item))
        ? "autumn"
        : legacy.deadlineSemester,
    languageTest,
    languageScore,
    languageSubscore: hard.ieltsMinimumSubscore ?? legacy.languageSubscore,
    gpa: hard.gpaValue ?? legacy.gpa,
    quotaMin: hard.quotaMin ?? legacy.quotaMin,
    quotaMode: hard.quotaMin !== undefined ? "minimum" : legacy.quotaMode,
    major: hard.majors?.[0] ?? legacy.major,
    requireOfficialSource: hard.officialSourceRequired ?? legacy.requireOfficialSource,
    requireClearCost: hard.numericCostRequired ?? legacy.requireClearCost,
    requestedFields,
  };
}

function plannerDifferences(legacy: QueryConstraints, plan: QueryPlan | null) {
  if (!plan) return ["planner_unavailable"];
  const differences: string[] = [];
  const plannedIntent = plannerIntent(plan.intent);
  if (plannedIntent && plannedIntent !== legacy.intent) differences.push(`intent:${legacy.intent}->${plannedIntent}`);
  if (plan.limit !== legacy.topN) differences.push(`limit:${legacy.topN}->${plan.limit}`);
  if (Boolean(plan.hardFilters.housingAvailable) !== legacy.requireHousing) differences.push("housing_filter");
  const plannedScore = plan.hardFilters.ieltsMax ?? plan.hardFilters.toeflMax;
  if (plannedScore !== undefined && plannedScore !== legacy.languageScore) differences.push("language_score");
  if (plan.hardFilters.quotaMin !== undefined && plan.hardFilters.quotaMin !== legacy.quotaMin) differences.push("quota_min");
  if (plan.followupReference.enabled !== false && !legacy.inScope) differences.push("followup_reference");
  return differences;
}

function followupOrdinal(question: string) {
  const normalized = question.normalize("NFKC").toLowerCase();
  const match = normalized.match(/(?:^|\s)(\d+)\s*(?:번째|번|위)/);
  if (match) return Math.max(1, Number(match[1]));
  if (/첫\s*번째|첫째|first/.test(normalized)) return 1;
  if (/두\s*번째|둘째|second/.test(normalized)) return 2;
  if (/세\s*번째|셋째|third/.test(normalized)) return 3;
  return undefined;
}

const REASONING_EFFORT_VALUES = new Set(["minimal", "low", "medium", "high"]);
function resolveReasoningEffort(): "minimal" | "low" | "medium" | "high" {
  const raw = process.env.SOLAR_REASONING_EFFORT;
  return raw && REASONING_EFFORT_VALUES.has(raw) ? raw as "minimal" | "low" | "medium" | "high" : "minimal";
}

async function v2Response(args: {
  question: string;
  cards: ResultCard[];
  detailedAnswer: string;
  planner: PlannerRun;
  shortAnswerOverride?: string;
  extra?: Record<string, unknown>;
}) {
  const apiKey = process.env.UPSTAGE_API_KEY;
  const model = process.env.UPSTAGE_CHAT_MODEL || "solar-pro3";
  const evidenceCards = args.cards.map((card) => ({ ...card, match_status: card.match_status ?? "matched" as const }));
  const packet = createEvidencePacket(args.question, args.planner.validatedPlan, evidenceCards);
  const reasoner = apiKey
    ? await runSolarReasoner({ apiKey, model, packet, reasoningEffort: resolveReasoningEffort() })
    : { output: null, usedSolar: false, issues: ["missing_api_key"] };
  const presentation = responsePresentation(args.detailedAnswer, args.cards);
  // Only the reasoner's own text needs this pass -- presentation.shortAnswer
  // is always a deterministic template and never contains a placeholder like
  // "XXX"/"TBD" to begin with.
  const modelShortAnswer = reasoner.output?.shortAnswer
    ? sanitizeGeneratedAnswer(reasoner.output.shortAnswer) || presentation.shortAnswer
    : presentation.shortAnswer;
  const shortAnswer = args.shortAnswerOverride ?? authoritativeShortAnswer(args.cards, modelShortAnswer);

  console.info("[chat-v2] pipeline", {
    planner: args.planner.usedSolar,
    plannerMode: process.env.SOLAR_PLANNER_MODE || "shadow",
    plannerIssues: args.planner.issues,
    evidenceUniversities: packet.universities.length,
    evidenceFacts: packet.universities.reduce((sum, item) => sum + item.facts.length, 0),
    reasoner: reasoner.usedSolar,
    reasonerIssues: reasoner.issues,
  });

  return NextResponse.json({
    ...presentation,
    shortAnswer,
    cards: args.cards,
    sources: collectSources(args.cards),
    unknown_fields: packet.unknownFields,
    suggestedDetailTab: reasoner.output?.suggestedDetailTab,
    solarUsed: { planner: args.planner.usedSolar, reasoner: reasoner.usedSolar },
    plannerMode: (process.env.SOLAR_PLANNER_MODE || "shadow") === "active" ? "active" : "shadow",
    fallbackUsed: !reasoner.usedSolar,
    pipelineStages: ["planning", "searching", "validating", "reasoning"],
    ...args.extra,
  });
}

function deterministicDeadlineAnswer(cards: ResultCard[]) {
  const rows = cards.map((card, index) => {
    const deadlineFacts = (card.fact_bundle ?? [])
      .filter((fact) => fact.table === "application_deadlines" || fact.field_key === "application_deadlines")
      .map((fact) => fact.value)
      .filter(Boolean);
    const primary = deadlineFacts[0] ?? card.highlights.find((item) => /deadline|마감|application|nomination/i.test(item)) ?? "확인 필요";
    const otherDeadlines = deadlineFacts.slice(1, 3).join(" / ") || "추가 일정은 상세 페이지와 출처에서 확인";
    return `| ${index + 1} | ${card.university_name} | ${card.country} · ${card.city} | ${primary.replace(/\|/g, "/")} | ${otherDeadlines.replace(/\|/g, "/")} |`;
  });

  return [
    "### 지원 마감일 비교",
    "",
    "| 순위 | 대학 | 위치 | 가장 빠른 등록 마감일 | 함께 확인할 일정 |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    "### 확인사항",
    "- 성균관대학교 내부 접수 일정과 상대교 일정은 다를 수 있습니다.",
    "- 실제 지원 전 아래 공식 출처에서 최신 일정을 확인해 주세요.",
  ].join("\n");
}

function deterministicRequestedFieldsAnswer(cards: ResultCard[], requestedFields: string[]) {
  const labels: Record<string, string> = {
    language_requirements: "어학 조건",
    housing_options: "기숙사·주거",
    estimated_costs: "비용",
    application_deadlines: "지원 마감일",
    quota_facts: "파견 정원",
    course_restrictions: "수강 제한",
    source_links: "공식 출처",
    universities: "대학 기본 정보",
  };
  const lines = ["### 요청 항목 비교", ""];
  for (const card of cards) {
    lines.push(`#### ${card.university_name}`, "", "| 항목 | 확인된 내용 |", "|---|---|");
    for (const field of requestedFields) {
      const values = (card.fact_bundle ?? [])
        .filter((fact) => fact.field_key === field || fact.table === field)
        .map((fact) => cleanText(fact.value).replace(/\|/g, "/"))
        .filter(Boolean)
        .filter((value, index, items) => items.indexOf(value) === index)
        .slice(0, 3);
      lines.push(`| ${labels[field] ?? field} | ${values.length ? values.join(" / ") : "확인 필요"} |`);
    }
    lines.push("");
  }
  lines.push("### 확인사항", "", "- 확인 필요로 표시된 항목은 조건 충족으로 간주하지 않았습니다.", "- 숫자와 날짜는 아래 공식 근거에서 최신 값을 다시 확인해 주세요.");
  return lines.join("\n");
}

function deterministicGeneralAnswer(cards: ResultCard[]) {
  const lines = ["### 확인된 교환대학 정보", ""];
  for (const card of cards) {
    lines.push(`#### ${card.university_name}`, "");
    lines.push(`- 위치: ${card.country} · ${card.city}`);
    for (const highlight of card.highlights.filter(Boolean).slice(0, 3)) {
      lines.push(`- ${plainTextSummary(highlight, 160)}`);
    }
    lines.push("");
  }
  lines.push("### 확인 안내", "", "- 상세 조건과 최신 일정은 연결된 공식 출처에서 다시 확인해 주세요.");
  return lines.join("\n");
}

function outOfScopeResponse() {
  return NextResponse.json({
    answer: "교환대학의 지원 조건, 어학 성적, 일정, 기숙사, 비용처럼 등록된 교환학생 정보에 대해서만 답할 수 있습니다.",
    cards: [],
    sources: [],
    searchMode: "범위 밖 질문 거절",
  });
}

function clarificationResponse(question: string) {
  const prompt = cleanText(question, "어느 대학의 어떤 정보를 확인할까요? 대학명이나 검색 조건을 알려주세요.");
  return NextResponse.json({
    answer: prompt,
    shortAnswer: prompt,
    detailedAnswer: ["### 질문을 조금만 구체화해 주세요", "", prompt].join("\n"),
    cards: [],
    sources: [],
    matched: [],
    partially_matched: [],
    excluded_count: 0,
    unknown_fields: [],
    searchMode: "명확화 질문",
  });
}

// A question with no "그중"/"거기" marker but that still reads as its own
// complete recommendation request (its own region/score/major/housing/
// deadline condition) is genuinely ambiguous right after a turn that set up
// different conditions: does it replace them, or layer on top? Silently
// picking one either drops the earlier conditions the user may still want,
// or leaks them into a question that never asked for them (the bug this was
// added to prevent). Asking once is cheaper than guessing wrong either way.
const SCOPE_RESET_MARKERS = /처음부터|새로\s*(?:검색|찾아|추천)|전체\s*(?:대학)?(?:에서|를 대상으로)|이전\s*조건\s*(?:무시|빼고|없이)|조건\s*(?:다시|리셋)/i;

function describeConditionsForClarification(constraints: QueryConstraints): string {
  const parts: string[] = [];
  if (constraints.requireEurope) parts.push("유럽");
  if (constraints.requireAsia) parts.push("아시아");
  if (constraints.requireAmericas) parts.push("아메리카");
  if (constraints.countries.length) parts.push(constraints.countries.join("/"));
  if (constraints.languageTest && constraints.languageScore !== undefined) parts.push(`${constraints.languageTest} ${constraints.languageScore}`);
  if (constraints.gpa !== undefined) parts.push(`GPA ${constraints.gpa}`);
  if (constraints.major) parts.push(constraints.major);
  if (constraints.requireHousing) parts.push("기숙사 정보 있음");
  if (constraints.requireHousingGuaranteed) parts.push("기숙사 배정 보장");
  if (constraints.deadlineSemester) parts.push(constraints.deadlineSemester === "spring" ? "봄학기" : "가을학기");
  return parts.join(" · ");
}

function hasGeographicScope(constraints: QueryConstraints) {
  return Boolean(
    constraints.requireEurope || constraints.requireAsia || constraints.requireAmericas || constraints.countries.length,
  );
}

// Narrowly scoped to the one condition mergeConversationConstraints refuses to
// carry forward on its own (geographic scope -- see its comment for why).
// Any client that has ever gotten a successful recommendation will keep
// sending that turn's contextUniversityIds on every later message, including
// a fully self-contained next question, so "there is a previous turn" alone
// is not a useful ambiguity signal (an earlier, broader version of this check
// asked on every back-to-back recommendation question, including ones that
// restate their own complete region -- a real false positive found via
// qa-runner's group B, where each question is independent but happens to
// share the word "유럽"). Only ask when the *current* question omits any
// region/country of its own right after a turn that had one -- that specific
// gap is where "should this stay scoped to before, or search everywhere?" is
// actually unclear.
function needsFollowupScopeClarification(
  question: string,
  hasContext: boolean,
  priorConstraints: QueryConstraints | undefined,
  currentConstraints: QueryConstraints,
): boolean {
  if (!hasContext || !priorConstraints) return false;
  if (SCOPE_RESET_MARKERS.test(question.normalize("NFKC"))) return false;
  if (!hasGeographicScope(priorConstraints) || hasGeographicScope(currentConstraints)) return false;
  return hasRecommendationConditions(priorConstraints) && hasRecommendationConditions(currentConstraints);
}

function needsTargetClarification(
  intent: Intent,
  exactTargetCount: number,
  plannerTargetCount: number,
  question: string,
) {
  const directFactIntent = new Set<Intent>(["deadline", "language", "housing", "quota", "source", "restriction"]);
  if (!directFactIntent.has(intent) || exactTargetCount > 0 || plannerTargetCount > 0) return false;

  const normalized = question.normalize("NFKC").toLowerCase();
  const asksForCollection = /추천|비교|순위|가장|빠른|이른|낮은|높은|어디|어느\s*(?:대학|학교)|대학.{0,12}(?:찾|보여|알려|추천)|학교.{0,12}(?:찾|보여|알려|추천)|있는\s*(?:대학|학교)|가능한\s*(?:대학|학교)|몇\s*곳|top\s*\d+|recommend|compare|rank|which\s*(?:universities|schools)/i.test(normalized);
  const hasScopedDeadlinePeriod = intent === "deadline"
    && /\b20\d{2}\b/.test(normalized)
    && /가을|봄|autumn|fall|spring/.test(normalized);
  return !asksForCollection && !hasScopedDeadlinePeriod;
}

function unsupportedDataResponse(reason?: QueryConstraints["unsupportedReason"]) {
  if (reason === "cost_of_living_index") {
    return NextResponse.json({
      answer:
        "현재 웹페이지 내 데이터베이스 정보로 말씀드릴 수 없는 정보입니다.\n\n- 지금 DB에는 대학별 교환학생 지원 조건, 어학 성적, 일정, 기숙사, 일부 비용 정보가 중심으로 저장되어 있습니다.\n- 한국과의 국가별 물가 지수 비교는 별도 지표 데이터가 필요합니다.\n- 이 기능을 정확히 제공하려면 Numbeo 같은 외부 물가 지표를 별도 테이블로 저장하고, 기준일과 출처를 함께 표시해야 합니다.",
      cards: [],
      sources: [],
      searchMode: "DB 미보유 데이터 요청",
    });
  }
  return outOfScopeResponse();
}

function safePromptInjectionResponse() {
  const message = "시스템 지침, 환경변수, API 키, 원본 데이터베이스 전체 내용은 제공할 수 없습니다. 교환대학의 지원 조건이나 공식 근거를 질문해 주세요.";
  return NextResponse.json({
    answer: message,
    shortAnswer: message,
    detailedAnswer: message,
    cards: [],
    sources: [],
    unknown_fields: [],
    searchMode: "안전 정책 응답",
  });
}

async function costOfLivingResponse(question: string) {
  const mentioned = detectCountries(question).filter((country, index, items) => items.indexOf(country) === index);
  const countries = mentioned.filter((country) => country !== "South Korea");
  if (!countries.length) {
    return clarificationResponse("비교할 국가를 알려주세요. 예: `영국과 핀란드 중 한국 대비 생활 물가가 더 낮은 나라는 어디야?`");
  }
  const snapshot = await loadCostOfLivingSnapshot();
  const rows = countries.flatMap((country) => {
    const item = costIndexCountry(country);
    const index = costOfLivingIndex(country, snapshot.indices);
    return item && index !== undefined ? [{ country, item, index }] : [];
  }).sort((a, b) => a.index - b.index);
  if (!rows.length) {
    return NextResponse.json({
      answer: "요청한 국가의 생활 물가 지수를 현재 공통 물가 데이터에서 확인하지 못했습니다.",
      shortAnswer: "요청한 국가의 생활 물가 지수를 확인하지 못했습니다.",
      detailedAnswer: "### 생활 물가 비교\n\n현재 공통 물가 데이터에 해당 국가 값이 없습니다.",
      cards: [], sources: [], matched: [], partially_matched: [], excluded_count: 0, unknown_fields: countries,
      searchMode: "공통 국가별 물가지수 조회 결과 없음",
    });
  }
  const comparison = rows.length > 1
    ? `비교한 국가 중 **${costIndexCountryLabel(rows[0].country)}**의 생활 물가 지수가 더 낮습니다.`
    : `**${costIndexCountryLabel(rows[0].country)}**의 생활 물가 지수는 한국=100 기준 **${rows[0].index.toFixed(1)}**입니다.`;
  const tableRows = rows.map(({ country, item, index }) => {
    const difference = index - 100;
    return `| ${costIndexCountryLabel(country)} | ${index.toFixed(1)} | 한국보다 ${Math.abs(difference).toFixed(1)}% ${difference >= 0 ? "높음" : "낮음"} | ${item.source} |`;
  });
  const detailedAnswer = [
    "### 생활 물가 비교", "", comparison, "",
    "| 국가 | 한국=100 지수 | 한국 대비 | 출처 |", "|---|---:|---|---|", ...tableRows, "",
    `- OECD 기준월: ${snapshot.period}${snapshot.fallback ? " (저장된 최신 확인값)" : ""}`,
    `- Numbeo 비OECD 국가 스냅샷: ${NUMBEO_SNAPSHOT_DATE}`,
    "- 국가 평균 지표이므로 도시·주거 형태에 따른 실제 지출 차이는 별도로 확인해야 합니다.",
  ].join("\n");
  return NextResponse.json({
    answer: comparison,
    shortAnswer: comparison,
    detailedAnswer,
    cards: [], matched: [], partially_matched: [], excluded_count: 0, unknown_fields: [],
    sources: [
      { title: "OECD 월별 비교물가수준", url: "https://data-explorer.oecd.org/vis?df%5Bag%5D=OECD.SDD.TPS&df%5Bid%5D=DSD_PPP_M%40DF_PP_CPL_M", source_type: "OECD", is_official: true },
      { title: "Numbeo 국가별 생활비 지수", url: "https://www.numbeo.com/cost-of-living/rankings_by_country.jsp", source_type: "Numbeo", is_official: false },
    ],
    searchMode: "웹 화면과 동일한 공통 국가별 물가지수 함수",
  });
}

function removedCostFeatureResponse() {
  return NextResponse.json({
    answer:
      "비용 데이터의 기준이 대학마다 달라 현재 챗봇에서는 대학 간 총비용 순위, 예산 이하 추천, 한 학기 예상 비용 계산을 제공하지 않습니다.\n\n- 특정 대학의 공식 기숙사비·생활비처럼 DB에 명시된 개별 비용은 확인할 수 있습니다.\n- 금액은 원래 통화와 원래 기간(월·학기·연간) 그대로 안내합니다.\n- 예: `University of Helsinki의 공식 기숙사 비용을 알려줘.`",
    cards: [],
    sources: [],
    searchMode: "회의 결정에 따라 비용 비교·예산 추천 제외",
  });
}

async function handleChatRequest(request: Request) {
  if (isRateLimited(request)) {
    return NextResponse.json({ error: "질문이 너무 빠르게 반복되고 있습니다. 잠시 뒤 다시 시도해 주세요." }, { status: 429 });
  }
  refreshCurrencyRatesInBackground();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "올바른 요청 형식이 아닙니다." }, { status: 400 });
  }

  const rawMessages = (body as { messages?: unknown })?.messages;
  if (!Array.isArray(rawMessages)) {
    return NextResponse.json({ error: "대화 내용이 필요합니다." }, { status: 400 });
  }

  const messages = rawMessages.filter(isChatMessage).slice(-MAX_MESSAGES);
  const contextUniversityIds = Array.isArray((body as { contextUniversityIds?: unknown })?.contextUniversityIds)
    ? ((body as { contextUniversityIds: unknown[] }).contextUniversityIds)
        .filter((value): value is string => typeof value === "string")
        .slice(0, 8)
    : [];
  const sessionId = typeof (body as { sessionId?: unknown })?.sessionId === "string"
    ? String((body as { sessionId: string }).sessionId).slice(0, 80)
    : "unknown";
  if (!messages.length || messages.at(-1)?.role !== "user") {
    return NextResponse.json({ error: "질문을 입력해 주세요." }, { status: 400 });
  }
  const question = messages.at(-1)?.content ?? "";
  if (isPromptInjectionRequest(question)) return safePromptInjectionResponse();

  try {
    const universities = await getChatUniversities();
    const requestId = crypto.randomUUID().slice(0, 8);
    if (isCostOfLivingIndexQuestion(question)) return costOfLivingResponse(question);
    // Product policy must win even when the active planner classifies the
    // question as out of scope or changes its intent.
    if (isRemovedCostRecommendation(question)) {
      return removedCostFeatureResponse();
    }
    const explicitFollowup = contextUniversityIds.length > 0 && isFollowupReference(question);
    // Only fold prior turns' conditions in when this turn explicitly signals
    // it's a continuation ("그중", "거기", ...). A plain new question with no
    // such marker is a topic change and must be evaluated on its own -- carrying
    // an earlier turn's requirements into it would silently narrow an
    // unrelated question (e.g. an earlier "기숙사 있는 곳만" leaking into a later,
    // unrelated "아이엘츠 6.0 대학 알려줘" that never mentioned housing).
    const detectedConstraints = explicitFollowup ? detectConversationConstraints(messages) : detectConstraints(question);
    const legacyConstraints: QueryConstraints = explicitFollowup
      ? { ...detectedConstraints, inScope: true }
      : detectedConstraints;
    const apiKey = process.env.UPSTAGE_API_KEY;
    const planner: PlannerRun = apiKey && legacyConstraints.inScope
      ? await runSolarPlanner({
          apiKey,
          model: process.env.UPSTAGE_CHAT_MODEL || "solar-pro3",
          question,
          knownUniversityNames: universities.map((university) => university.university_name),
          reasoningEffort: resolveReasoningEffort(),
        })
      : { rawPlan: null, validatedPlan: null, issues: [apiKey ? "out_of_scope" : "missing_api_key"], usedSolar: false };
    const constraints = (process.env.SOLAR_PLANNER_MODE || "shadow") === "active"
      ? applyValidatedPlannerPlan(legacyConstraints, planner.validatedPlan)
      : legacyConstraints;
    console.info("[chat-v2] planner-plan", {
      requestId,
      sessionId,
      mode: process.env.SOLAR_PLANNER_MODE || "shadow",
      usedSolar: planner.usedSolar,
      issues: planner.issues,
      differences: plannerDifferences(legacyConstraints, planner.validatedPlan),
      filters: {
        europe: constraints.requireEurope,
        asia: constraints.requireAsia,
        americas: constraints.requireAmericas,
        countries: constraints.countries,
        excludedCountries: constraints.excludedCountries,
      },
      contextUniversityIds,
      explicitFollowup,
    });
    const earlyAliasTargets = universityNamesFromAliases(question)
      .map((name) => universities.find((university) => university.university_name === name))
      .filter((university): university is University => Boolean(university));
    const earlyLegacyTargets = findTargetUniversities(universities, question);
    const earlyKnownTargets = earlyAliasTargets.length ? earlyAliasTargets : earlyLegacyTargets;
    const earlyUnknownInstitution = explicitUnknownInstitution(question, earlyKnownTargets);
    if (earlyUnknownInstitution) return unknownInstitutionResponse(earlyUnknownInstitution, universities.length);

    if (planner.validatedPlan?.clarificationNeeded) {
      console.info("[chat-v2] clarification", { requestId, source: "solar_planner" });
      return clarificationResponse(
        planner.validatedPlan.clarificationQuestion || "어느 대학의 어떤 정보를 확인할까요? 대학명이나 검색 조건을 알려주세요.",
      );
    }
    if (!constraints.inScope) return unsupportedDataResponse(constraints.unsupportedReason);

    const intent = constraints.intent;
    const aliasNames = universityNamesFromAliases(question);
    const aliasTargets = aliasNames
      .map((name) => universities.find((university) => university.university_name === name))
      .filter((university): university is University => Boolean(university));
    const plannerCanResolveTargets = planner.validatedPlan
      && planner.validatedPlan.intent !== "university_recommendation"
      && planner.validatedPlan.intent !== "out_of_scope";
    const plannerTargets = plannerCanResolveTargets
      ? planner.validatedPlan!.universityNames
          .map((name) => universities.find((university) => university.university_name === name))
          .filter((university): university is University => Boolean(university))
      : [];
    const legacyTargets = findTargetUniversities(universities, question);
    const exactTargets = aliasTargets.length ? aliasTargets : plannerTargets.length ? plannerTargets : legacyTargets;
    if (!explicitFollowup && needsTargetClarification(intent, exactTargets.length, planner.validatedPlan?.universityNames.length ?? 0, question)) {
      console.info("[chat-v2] clarification", { requestId, source: "server_rule", intent });
      const labels: Partial<Record<Intent, string>> = {
        deadline: "어느 대학의 지원 마감일을 확인할까요? 대학명을 알려주세요.",
        language: "어느 대학의 어학 조건을 확인할까요? 대학명을 알려주세요.",
        housing: "어느 대학의 기숙사 정보를 확인할까요? 대학명을 알려주세요.",
        quota: "어느 대학의 파견 정원을 확인할까요? 대학명을 알려주세요.",
        source: "어느 대학의 공식 출처를 확인할까요? 대학명을 알려주세요.",
        restriction: "어느 대학의 수강 제한을 확인할까요? 대학명을 알려주세요.",
      };
      return clarificationResponse(labels[intent] || "어느 대학의 어떤 정보를 확인할까요? 대학명을 알려주세요.");
    }
    const unknownInstitution = explicitUnknownInstitution(question, exactTargets);
    if (unknownInstitution) return unknownInstitutionResponse(unknownInstitution, universities.length);
    if (!explicitFollowup && !exactTargets.length) {
      const priorUserTurns = messages.slice(0, -1).filter((message) => message.role === "user");
      const priorConstraints = priorUserTurns.length
        ? detectConversationConstraints(messages.slice(0, -1))
        : undefined;
      if (needsFollowupScopeClarification(question, contextUniversityIds.length > 0, priorConstraints, detectedConstraints)) {
        console.info("[chat-v2] clarification", { requestId, source: "followup_scope_ambiguous" });
        const priorSummary = describeConditionsForClarification(priorConstraints!);
        return clarificationResponse(
          `방금 말씀하신 조건${priorSummary ? `("${priorSummary}")` : ""}을 유지한 채 좁혀서 찾을까요, 아니면 새 조건으로 전체 대학에서 다시 찾을까요?\n` +
            `예: "그중 ...만 알려줘" (조건 유지) 또는 "처음부터 ... 대학 알려줘" (새로 검색)`,
        );
      }
    }
    const explicitContextTargets = contextUniversityIds
      .map((id) => universities.find((university) => university.id === id))
      .filter((university): university is University => Boolean(university));
    const previousTargets = explicitContextTargets.length
      ? explicitContextTargets
      : previousContextUniversities(universities, messages.slice(0, -1));
    const ordinal = planner.validatedPlan?.followupReference.ordinal ?? followupOrdinal(question);
    const comparisonLimit = followupComparisonLimit(question);
    const hasExplicitGeography = constraints.requireEurope || constraints.requireAsia || constraints.requireAmericas || constraints.countries.length > 0;
    const usePreviousResults = (explicitFollowup || planner.validatedPlan?.followupReference.enabled) && !hasExplicitGeography;
    const followupTargets = usePreviousResults
      ? ordinal && previousTargets[ordinal - 1]
        ? [previousTargets[ordinal - 1]]
        : comparisonLimit
          ? previousTargets.slice(0, comparisonLimit)
          : previousTargets
      : [];
    const candidateUniversities = followupTargets.length
      ? followupTargets
      : exactTargets.length
        ? exactTargets
        : universities;
    const useClassification = !exactTargets.length && hasRecommendationConditions(constraints) && intent !== "cost" && intent !== "deadline";
    const classified = useClassification ? selectClassifiedCards(candidateUniversities, constraints, question) : undefined;
    const cards = classified ? [...classified.matched, ...classified.partiallyMatched] : selectCards(candidateUniversities, constraints, question);
    console.info("[chat-v2] selection", {
      requestId,
      candidateScope: followupTargets.length ? "previous_results" : exactTargets.length ? "resolved_targets" : "all_universities",
      targetResolution: aliasTargets.length ? "korean_alias" : plannerTargets.length ? "solar_planner" : legacyTargets.length ? "legacy_name_match" : "none",
      resolvedTargetIds: exactTargets.map((university) => university.id),
      candidateCount: candidateUniversities.length,
      contextCandidateIds: followupTargets.map((university) => university.id),
      finalCardIds: cards.map((card) => card.university_id),
      matchedIds: classified?.matched.map((card) => card.university_id) ?? [],
      partialIds: classified?.partiallyMatched.map((card) => card.university_id) ?? [],
    });
    if (!cards.length) {
      return NextResponse.json({
        answer: "### 검색 결과\n\n질문 조건을 모두 확인할 수 있는 대학을 찾지 못했습니다.\n\n- 미확인 값을 조건 충족으로 간주하지 않았습니다.\n- 조건을 줄이거나 특정 대학을 지정하면 확인된 정보부터 안내할 수 있습니다.",
        cards: [],
        sources: [],
        searchMode: "Supabase 구조화 필드 필터링 결과 없음",
      });
    }

    if (classified) {
      const detailedAnswer = constraints.requestedFields.length > 1
        ? [
            deterministicClassifiedAnswer(classified.matched, classified.partiallyMatched),
            deterministicRequestedFieldsAnswer(cards, constraints.requestedFields),
          ].join("\n\n")
        : deterministicClassifiedAnswer(classified.matched, classified.partiallyMatched);
      // deterministicClassifiedAnswer always names every matched/partial card,
      // so this should never find anything -- it exists to catch a future
      // change to that template silently dropping a card's name, which would
      // otherwise ship unnoticed (chat-policy.ts warns against unused
      // safeguards; this is the same check kept from becoming one).
      const missingFromAnswer = findCardsMissingFromAnswer(cards, detailedAnswer);
      if (missingFromAnswer.length) {
        console.warn("[chat-v2] card missing from classified answer text", missingFromAnswer.map((card) => card.university_id));
      }
      return v2Response({
        question,
        cards,
        detailedAnswer,
        planner,
        extra: {
          matched: classified.matched,
          partially_matched: classified.partiallyMatched,
          excluded_count: classified.excluded.length,
          searchMode: "Supabase 구조화 조건 판정(충족/부분 확인/미충족)",
        },
      });
    }

    if (intent === "source") {
      const sources = collectSources(cards);
      const detailedAnswer = sources.length
        ? [
            "### 공식 출처",
            "",
            ...sources.map((source) => `- **${source.university_name || "대학"}**: [${source.title}](${source.url})`),
          ].join("\n")
        : ["### 공식 출처", "", "현재 등록된 자료에서 연결 가능한 공식 출처를 찾지 못했습니다."].join("\n");
      const shortAnswer = sources.length
        ? sources.slice(0, 3).map((source) => `- [${source.university_name || source.title} 공식 출처](${source.url})`).join("\n")
        : "현재 등록된 자료에서 연결 가능한 공식 출처를 찾지 못했습니다.";
      return v2Response({
        question,
        cards,
        detailedAnswer,
        shortAnswerOverride: shortAnswer,
        planner,
        extra: { searchMode: "Supabase 저장 공식 출처 직접 조회" },
      });
    }

    if (constraints.requestedFields.length > 1) {
      const detailedAnswer = deterministicRequestedFieldsAnswer(cards, constraints.requestedFields);
      return v2Response({
        question, cards, detailedAnswer, planner,
        extra: { searchMode: "Supabase requestedFields 복합 근거 조회" },
      });
    }

    if (intent === "cost") {
      const detailedAnswer = deterministicDirectCostAnswer(cards);
      return v2Response({
        question, cards, detailedAnswer, planner,
        extra: { searchMode: "Supabase 비용 fact 직접 조회(비교·추정 없음)" },
      });
    }

    if (intent === "deadline") {
      const detailedAnswer = deterministicDeadlineAnswer(cards);
      return v2Response({
        question, cards, detailedAnswer, planner,
        extra: { searchMode: "Supabase application_deadlines 필드 정렬 + 서버 검증 답변" },
      });
    }


    if (intent === "restriction") {
      const supportedCards = cards.filter((card) => restrictionEvidence([card]).length > 0);
      const detailedAnswer = deterministicRestrictionAnswer(supportedCards);
      return v2Response({
        question, cards: supportedCards, detailedAnswer, planner,
        extra: { searchMode: "Supabase 수강 제한 근거 직접 조회" },
      });
    }

    if (intent === "housing" || intent === "language") {
      const detailedAnswer = deterministicFactAnswer(cards, intent);
      return v2Response({
        question, cards, detailedAnswer, planner,
        extra: { searchMode: searchMode(intent) },
      });
    }
    const detailedAnswer = deterministicGeneralAnswer(cards);
    return v2Response({
      question, cards, detailedAnswer, planner,
      extra: { searchMode: searchMode(intent) },
    });
  } catch (error) {
    console.error("Chat route error", error);
    return NextResponse.json({ error: "챗봇 요청 처리 중 오류가 발생했습니다." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!request.headers.get("accept")?.includes("application/x-ndjson")) {
    return handleChatRequest(request);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (value: unknown) => {
        if (!closed) controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
      };
      send({ type: "status", stage: "planning", message: "질문의 조건을 분석하고 있습니다." });
      const timers = [
        setTimeout(() => send({ type: "status", stage: "searching", message: "등록된 대학 데이터를 검색하고 있습니다." }), 700),
        setTimeout(() => send({ type: "status", stage: "validating", message: "후보 대학의 조건과 출처를 확인하고 있습니다." }), 1700),
        setTimeout(() => send({ type: "status", stage: "reasoning", message: "검증된 결과를 정리하고 있습니다." }), 2800),
      ];
      void handleChatRequest(request)
        .then(async (response) => {
          const data = await response.json();
          send({ type: "result", status: response.status, data });
        })
        .catch((error) => {
          console.error("[chat-v2] stream failed", error);
          send({ type: "error", message: "챗봇 요청 처리 중 오류가 발생했습니다." });
        })
        .finally(() => {
          timers.forEach(clearTimeout);
          closed = true;
          controller.close();
        });
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}
