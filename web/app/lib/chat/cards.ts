import { REQUEST_FIELD_TO_INTENT } from "./constraints";
import { deadlineRowTime, estimateSemesterCost, highlightFromRow, housingGuaranteeSummary, relevantRows, sectionText } from "./filters";
import { actionLabel, firstSource, rowSource, sourceFieldForIntent } from "./sources";
import type { CostEstimate, FactEvidence, Intent, RankedCandidate, ResultCard } from "./types";
import { cleanText, programOf } from "./utils";

function sourceFromIntentRows(university: RankedCandidate["university"], intent: Intent) {
  const rows = relevantRows(university, intent);
  for (const row of rows) {
    const source = rowSource(university, row, intent === "cost" ? "estimated_costs" : `${intent}_facts`, actionLabel(intent));
    if (source) return source;
  }
  return firstSource(university, intent);
}

function factEvidenceFromRow(university: RankedCandidate["university"], row: Record<string, unknown>, intent: Intent, table: string): FactEvidence {
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

function factBundleForCard(university: RankedCandidate["university"], intent: Intent, cost?: CostEstimate): FactEvidence[] {
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
  university: RankedCandidate["university"],
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

export function makeCard(candidate: RankedCandidate, intent: Intent, requestedFields: string[] = []): ResultCard {
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
