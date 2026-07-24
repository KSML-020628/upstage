import type { University } from "../types";
import { compareIsoDate } from "./chat-policy";
import {
  presentCost,
  presentDeadline,
  presentHousingGuarantee,
  presentHousingRow,
  presentLanguage,
} from "../display/present-fact";
import { firstSource, rowSource, universitySources } from "./sources";
import { CURRENCY_TO_KRW } from "./supabase-facts";
import { deadlineRowTime } from "./deadline-dates.ts";
import { LANGUAGE_TEST_ALIASES } from "./types";
import type {
  ConditionCheck,
  ConditionState,
  CostComponent,
  CostEstimate,
  DeadlineSemester,
  DeadlineType,
  EvaluatedUniversity,
  Intent,
  LanguageTestName,
  QueryConstraints,
} from "./types";
import {
  cleanText,
  isAmericasUniversity,
  isAsianUniversity,
  isClearlyNonOfficialUrl,
  isEuropeanUniversity,
  matchesCountry,
  normalizeSearchText,
  numericValue,
  programOf,
  rowAsText,
  rowText,
  rowsText,
} from "./utils";

export function relevantRows(university: University, intent: Intent) {
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

export function sectionText(university: University, intent: Intent) {
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

// Bounded, row-count-independent housing score: provided (any row not
// explicitly unavailable), guaranteed (any row explicitly true), and
// verified (any row reviewer-approved). Mirrors the exact fields
// evaluateUniversity's own housing_available/housing_guaranteed checks use,
// so two hydrations of the same real-world housing facts score identically
// regardless of how many rows either data source happens to have.
function housingQualitySignalScore(rows: Record<string, unknown>[]) {
  const provided = rows.some((row) => row.housing_available !== false);
  const guaranteed = rows.some((row) => row.housing_guaranteed === true || row.is_guaranteed === true);
  const verified = rows.some((row) => row.review_status === "approved");
  return (provided ? 4 : 0) + (guaranteed ? 4 : 0) + (verified ? 2 : 0);
}

export function scoreUniversity(university: University, intent: Intent, question: string) {
  const program = programOf(university);
  let score = 0;
  const q = normalizeSearchText(question);
  const corpus = normalizeSearchText(`${university.university_name} ${university.country} ${university.city} ${university.summary} ${sectionText(university, intent)}`);

  if (q.includes(normalizeSearchText(university.university_name))) score += 20;
  if (university.country && q.includes(normalizeSearchText(university.country))) score += 5;
  if (university.city && q.includes(normalizeSearchText(university.city))) score += 4;

  // Scored by qualitative signal (provided/guaranteed/verified), not row
  // count. Legacy's housing_options comes from the ui_profile_json blob
  // while the Targeted Query Builder's comes from the separate, structured
  // housing_facts table -- the two are independently extracted and can
  // disagree on row count for the same university even when they fully
  // agree on the actual housing_guaranteed/housing_available facts. A
  // `.length * 4` score let that row-count divergence alone flip a top-N
  // ranking tie between the two paths (confirmed live: a housing-guarantee
  // recommendation query classified the same 7 universities as "met"/
  // "unknown" identically on both sides, yet the final top-7 cut still
  // swapped one university for another purely because of row-count-driven
  // score differences).
  if (intent === "housing") score += housingQualitySignalScore(program?.housing_options ?? []);
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

function sourceForCost(university: University, row: Record<string, unknown>) {
  const direct = rowSource(university, row, "estimated_costs", "비용 출처");
  if (direct) return direct;
  return firstSource(university, "cost");
}

export function highlightFromRow(row: Record<string, unknown>, intent: Intent) {
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

export function estimateSemesterCost(university: University, options: { requireClear?: boolean } = {}): CostEstimate | undefined {
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

export function housingGuaranteeSummary(university: University) {
  const rows = programOf(university)?.housing_options ?? [];
  if (!rows.length) return "기숙사 정보 없음";
  const presented = rows.map(presentHousingGuarantee);
  const guaranteed = presented.find((field) => field.value === "보장");
  if (guaranteed) return `${guaranteed.label}: ${guaranteed.value}`;
  const notGuaranteed = presented.find((field) => field.value === "명시적으로 보장되지 않음");
  if (notGuaranteed) return `${notGuaranteed.label}: ${notGuaranteed.value}`;
  return "배정 보장: 확인 필요";
}

function matchesLanguageTest(stored: unknown, selected: LanguageTestName) {
  const value = normalizeSearchText(stored);
  return LANGUAGE_TEST_ALIASES[selected].some((alias) => value.includes(alias));
}

function validLanguageScore(test: LanguageTestName, value: unknown) {
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
  const languageTest = constraints.languageTest;
  if (!languageTest || constraints.languageScore === undefined) return undefined;
  const rows = programOf(university)?.language_requirements ?? [];
  const matching = rows.filter((row) => matchesLanguageTest(row.test_type, languageTest));
  const valid = matching
    .map((row) => ({ row, score: validLanguageScore(languageTest, row.minimum_score ?? row.overall_score) }))
    .filter((item): item is { row: Record<string, unknown>; score: number } => item.score !== undefined);
  if (!valid.length) return { key: "language", label: languageTest, state: "unknown", detail: `${languageTest} 유효 점수 미확인` };

  const distinctScores = [...new Set(valid.map((item) => item.score))];
  if (distinctScores.length > 1) {
    return { key: "language", label: languageTest, state: "unknown", detail: `프로그램별 요구 점수 충돌 (${distinctScores.join(" / ")})` };
  }
  const required = distinctScores[0];
  if (constraints.languageScore < required) {
    return { key: "language", label: languageTest, state: "failed", detail: `요구 ${required}, 입력 ${constraints.languageScore}` };
  }
  const subscore = Math.max(...valid.map((item) => languageSubscoreRequirement(item.row) ?? -1));
  if (subscore >= 0 && constraints.languageSubscore === undefined) {
    return { key: "language", label: languageTest, state: "unknown", detail: `전체 ${required} 충족, 각 영역 ${subscore} 확인 필요` };
  }
  if (subscore >= 0 && (constraints.languageSubscore ?? -1) < subscore) {
    return { key: "language", label: languageTest, state: "failed", detail: `각 영역 요구 ${subscore}, 입력 ${constraints.languageSubscore}` };
  }
  return { key: "language", label: languageTest, state: "met", detail: `요구 ${required}, 입력 ${constraints.languageScore}${subscore >= 0 ? ` · 각 영역 ${subscore} 충족` : ""}` };
}

function satisfiesLanguage(university: University, constraints: QueryConstraints) {
  const evaluation = languageEvaluation(university, constraints);
  return !evaluation || evaluation.state === "met";
}

export function minimumGpaRequirement(university: University) {
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

export function quotaValue(university: University) {
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

export { deadlineRowTime } from "./deadline-dates.ts"; // re-exported for cards.ts's existing import

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

export function earliestMatchingDeadlineTime(university: University, constraints: QueryConstraints) {
  const times = matchingDeadlineRows(university, constraints).map(deadlineRowTime).filter((value): value is number => value !== undefined);
  return times.length ? Math.min(...times) : Number.MAX_SAFE_INTEGER;
}

export function passesStructuredFilters(university: University, constraints: QueryConstraints) {
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

export function evaluateUniversity(university: University, constraints: QueryConstraints): EvaluatedUniversity {
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
