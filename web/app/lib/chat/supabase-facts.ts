import { getUniversities } from "../supabase";
import type { ExchangeProgram, University } from "../types";
import { cleanText } from "./utils";
import type { FactTableBundle } from "./types";

// Seed values only -- refreshCurrencyRatesInBackground() below keeps these
// updated from the same live source app/api/exchange-rate/route.ts uses, so
// a chatbot cost comparison and the country detail page's displayed rate for
// the same currency don't quietly disagree. Cost comparison across
// universities is a synchronous scoring/sorting step used deep in
// passesStructuredFilters/selectCards/evaluateUniversity; threading a fetched
// rate through every one of those call sites for every request is a much
// larger, riskier change than keeping this map itself fresh in place.
export const CURRENCY_TO_KRW: Record<string, number> = {
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
export function refreshCurrencyRatesInBackground() {
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

async function getFactTableBundles(universities: University[]): Promise<{ bundles: Map<string, FactTableBundle>; degraded: boolean }> {
  const key = supabaseServerKey();
  if (!key) {
    // Without this key, every answer silently falls back to the thinner
    // ui_profile_json rows on getUniversities() instead of the richer
    // cost_facts/housing_facts/language_requirements/application_deadlines
    // tables -- previously this returned an empty map with no log at all, so
    // a missing key in a deployment env was invisible until someone noticed
    // answers were thinner than expected.
    console.warn("SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_KEY/SUPABASE_KEY) is not set -- /api/chat is running on ui_profile_json only, without the structured fact tables");
    return { bundles: new Map<string, FactTableBundle>(), degraded: true };
  }
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
    return { bundles, degraded: false };
  } catch (error) {
    console.error("Supabase fact-table fetch failed; using ui_profile_json rows", error);
    return { bundles: new Map<string, FactTableBundle>(), degraded: true };
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

export async function getChatUniversities(): Promise<{ universities: University[]; factTablesDegraded: boolean }> {
  const universities = await getUniversities();
  const { bundles, degraded } = await getFactTableBundles(universities);
  return {
    universities: universities.map((university) => withFactTableRows(university, bundles.get(university.id))),
    factTablesDegraded: degraded,
  };
}
