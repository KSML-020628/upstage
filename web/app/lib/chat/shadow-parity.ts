import type { ResultCard } from "./types.ts";
import type { TargetedQueryResult } from "./targeted-query.ts";

// "exact_with_legacy_fallback" is the same ID/field-level match as "exact",
// but the targeted result only got there by borrowing one or more fields
// from the legacy University object (course_restrictions/source_links have
// no dedicated fact table at all; profile_sections is always borrowed
// unconditionally by hydrateUniversitiesFromCatalog) rather than the
// Targeted Query Builder resolving them independently. Kept distinct from
// plain "exact" so a reader can tell "targeted genuinely reproduced this"
// from "targeted matched because it copied legacy's own answer for part of
// it" -- the latter says less about whether a real primary-path migration
// could drop the legacy full-load entirely.
export type ShadowParityStatus = "exact" | "exact_with_legacy_fallback" | "equivalent" | "mismatch" | "shadow_error";

export type ShadowParityLog = {
  requestId: string;
  intent: string;
  candidateSource: string;

  legacyUniversityIds: string[];
  targetedUniversityIds: string[];

  missingFromTargeted: string[];
  extraInTargeted: string[];
  orderMatches: boolean;

  // Both legacyCards and targetedCards are produced by the SAME
  // evaluateUniversity/selectCards/selectClassifiedCards functions (see
  // route.ts's shadow block) -- the only difference is which University[]
  // was fed in (full legacy load vs targeted-hydrated). This makes these
  // comparisons meaningful, unlike Phase 3A's original raw-fact-presence
  // check: condition_checks/match_status/unknown_fields come from the same
  // decision logic on both sides now, not from a targeted-only fact dump.
  factValueParity: "exact" | "partial_mismatch" | "not_applicable";
  sourceParity: "exact" | "partial_mismatch" | "not_applicable";
  conditionStateParity: "exact" | "partial_mismatch" | "not_applicable";
  unknownFieldParity: "exact" | "partial_mismatch" | "not_applicable";

  fetchedTables: string[];
  queryCount: number;
  rowCountsByTable: Record<string, number>;
  legacyTotalFactRows: number;
  targetedFetchedRowCount: number;

  legacyQueryMs: number;
  targetedQueryMs: number;

  parityStatus: ShadowParityStatus;
  unsupportedFields: string[];
  // Fields the targeted-hydrated University actually borrowed from the
  // legacy object rather than resolving independently -- always includes
  // "profile_sections" (hydrateUniversitiesFromCatalog borrows it
  // unconditionally) plus whichever of course_restrictions/source_links
  // were in unsupportedFields for this request.
  legacyFallbackFields: string[];
  targetedErrors: string[];
};

function cardKey(card: ResultCard) {
  return card.university_id;
}

// Presence/equality-level comparison for a specific per-card field getter --
// shared logic for fact/source/condition/unknown comparisons below. "exact"
// requires every legacy card's own value to be reproduced by the matching
// targeted card; universities missing from targeted entirely don't count
// against this (that's already captured by missingFromTargeted/mismatch).
function compareField<T>(
  legacyCards: ResultCard[],
  targetedById: Map<string, ResultCard>,
  getValue: (card: ResultCard) => T,
  isEqual: (a: T, b: T) => boolean,
): "exact" | "partial_mismatch" | "not_applicable" {
  let checked = 0;
  let mismatched = 0;
  for (const card of legacyCards) {
    const targetedCard = targetedById.get(cardKey(card));
    if (!targetedCard) continue;
    checked += 1;
    if (!isEqual(getValue(card), getValue(targetedCard))) mismatched += 1;
  }
  if (!checked) return "not_applicable";
  return mismatched === 0 ? "exact" : "partial_mismatch";
}

function factSignature(card: ResultCard): string {
  return (card.fact_bundle ?? [])
    .map((fact) => `${fact.field_key ?? ""}:${fact.value ?? ""}`)
    .sort()
    .join("|");
}

function sourceSignature(card: ResultCard): string {
  return (card.fact_bundle ?? [])
    .map((fact) => fact.source_url ?? "")
    .filter(Boolean)
    .sort()
    .join("|");
}

function conditionSignature(card: ResultCard): string {
  return (card.condition_checks ?? [])
    .map((check) => `${check.key}:${check.state}`)
    .sort()
    .join("|");
}

function unknownFieldSignature(card: ResultCard): string {
  return [...(card.unknown_fields ?? [])].sort().join("|");
}

export function computeShadowParity(args: {
  requestId: string;
  intent: string;
  legacyCards: ResultCard[];
  targetedCards: ResultCard[];
  targeted: TargetedQueryResult | null;
  targetedError?: string;
  legacyQueryMs: number;
  legacyTotalFactRows: number;
  targetedQueryMs: number;
}): ShadowParityLog {
  const legacyUniversityIds = args.legacyCards.map(cardKey);
  const targetedUniversityIds = args.targetedCards.map(cardKey);

  const legacySet = new Set(legacyUniversityIds);
  const targetedSet = new Set(targetedUniversityIds);
  const missingFromTargeted = legacyUniversityIds.filter((id) => !targetedSet.has(id));
  const extraInTargeted = targetedUniversityIds.filter((id) => !legacySet.has(id));
  const orderMatches = legacyUniversityIds.length === targetedUniversityIds.length
    && legacyUniversityIds.every((id, index) => id === targetedUniversityIds[index]);

  if (!args.targeted) {
    return {
      requestId: args.requestId,
      intent: args.intent,
      candidateSource: "none",
      legacyUniversityIds,
      targetedUniversityIds: [],
      missingFromTargeted: legacyUniversityIds,
      extraInTargeted: [],
      orderMatches: false,
      factValueParity: "not_applicable",
      sourceParity: "not_applicable",
      conditionStateParity: "not_applicable",
      unknownFieldParity: "not_applicable",
      fetchedTables: [],
      queryCount: 0,
      rowCountsByTable: {},
      legacyTotalFactRows: args.legacyTotalFactRows,
      targetedFetchedRowCount: 0,
      legacyQueryMs: args.legacyQueryMs,
      targetedQueryMs: args.targetedQueryMs,
      parityStatus: "shadow_error",
      unsupportedFields: [],
      legacyFallbackFields: [],
      targetedErrors: args.targetedError ? [args.targetedError] : ["targeted_query_unavailable"],
    };
  }

  const targetedById = new Map(args.targetedCards.map((card) => [cardKey(card), card]));
  const factValueParity = compareField(args.legacyCards, targetedById, factSignature, (a, b) => a === b);
  const sourceParity = compareField(args.legacyCards, targetedById, sourceSignature, (a, b) => a === b);
  const conditionStateParity = compareField(args.legacyCards, targetedById, conditionSignature, (a, b) => a === b);
  const unknownFieldParity = compareField(args.legacyCards, targetedById, unknownFieldSignature, (a, b) => a === b);

  const targetedFetchedRowCount = Object.values(args.targeted.rowCountsByTable).reduce((sum, count) => sum + count, 0);
  const idsExact = missingFromTargeted.length === 0 && extraInTargeted.length === 0 && orderMatches;
  // "equivalent" (same candidate SET, different order -- e.g. a recommendation
  // query where ranking differs but every legacy match is still present) is
  // now reachable now that both sides run the identical evaluator: it means
  // ID recall is 100% and every compared field matched, just not in the same
  // order.
  const fieldsAllMatch = [factValueParity, sourceParity, conditionStateParity, unknownFieldParity]
    .every((status) => status === "exact" || status === "not_applicable");
  const idsEquivalent = missingFromTargeted.length === 0 && extraInTargeted.length === 0;

  // profile_sections is borrowed from legacy unconditionally by
  // hydrateUniversitiesFromCatalog whenever any candidate was hydrated, so
  // it's always logged here for full transparency -- but it isn't a
  // user-visible fact field the way course_restrictions/source_links are,
  // so it alone doesn't flip the parityStatus split below (that split is
  // specifically about fields this REQUEST asked for and got via legacy
  // fallback, i.e. targeted.unsupportedFields).
  const legacyFallbackFields = [
    ...new Set([...args.targeted.unsupportedFields, ...(targetedUniversityIds.length ? ["profile_sections"] : [])]),
  ];

  const parityStatus: ShadowParityStatus = args.targeted.errors.length
    ? "mismatch"
    : idsExact && fieldsAllMatch
      ? (args.targeted.unsupportedFields.length ? "exact_with_legacy_fallback" : "exact")
      : idsEquivalent && fieldsAllMatch
        ? "equivalent"
        : "mismatch";

  return {
    requestId: args.requestId,
    intent: args.intent,
    candidateSource: args.targeted.candidateSource,
    legacyUniversityIds,
    targetedUniversityIds,
    missingFromTargeted,
    extraInTargeted,
    orderMatches,
    factValueParity,
    sourceParity,
    conditionStateParity,
    unknownFieldParity,
    fetchedTables: args.targeted.fetchedTables,
    queryCount: args.targeted.queryCount,
    rowCountsByTable: args.targeted.rowCountsByTable,
    legacyTotalFactRows: args.legacyTotalFactRows,
    targetedFetchedRowCount,
    legacyQueryMs: args.legacyQueryMs,
    targetedQueryMs: args.targetedQueryMs,
    parityStatus,
    unsupportedFields: args.targeted.unsupportedFields,
    legacyFallbackFields,
    targetedErrors: args.targeted.errors,
  };
}

export function logShadowParity(parity: ShadowParityLog) {
  console.info("[chat-v2] targeted-query-shadow", parity);
}
