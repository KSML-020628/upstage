import type { ResultCard } from "./types.ts";
import type { TargetedQueryResult } from "./targeted-query.ts";

export type ShadowParityStatus = "exact" | "equivalent" | "mismatch" | "shadow_error";

export type ShadowParityLog = {
  requestId: string;
  intent: string;

  legacyUniversityIds: string[];
  targetedUniversityIds: string[];

  missingFromTargeted: string[];
  extraInTargeted: string[];
  orderMatches: boolean;

  factValueParity: "exact" | "partial_mismatch" | "not_applicable";
  sourceParity: "exact" | "partial_mismatch" | "not_applicable";
  // Phase 3A's Targeted Query Builder only fetches raw fact rows -- it does
  // not re-run evaluateUniversity's condition-state decision logic (that's a
  // real, intentional scope boundary: Phase 3A validates DB access parity,
  // not decision-logic parity, per the phase's own instructions). This is
  // always "not_computed_by_targeted" rather than a real comparison result --
  // recorded explicitly so a reader of the log never mistakes its absence
  // for an "exact" match on this dimension.
  conditionStateParity: "not_computed_by_targeted";
  unknownFieldParity: "not_computed_by_targeted";

  fetchedTables: string[];
  rowCountsByTable: Record<string, number>;
  legacyFetchedRowCount: number;
  targetedFetchedRowCount: number;

  legacyQueryMs: number;
  targetedQueryMs: number;

  parityStatus: ShadowParityStatus;
  targetedErrors: string[];
};

function legacyRowCount(cards: ResultCard[]): number {
  return cards.reduce((sum, card) => sum + (card.fact_bundle?.length ?? 0), 0);
}

// Presence-level parity, not a byte-for-byte value diff: a legacy
// fact_bundle entry is a human-formatted display string (e.g. "IELTS 6.0
// minimum"), while a targeted row is bare DB columns (e.g. minimum_score:6)
// -- the two are not directly string-comparable without reimplementing
// present-fact.ts's formatting logic a second time on the targeted side,
// which Phase 3A's instructions explicitly don't ask for (only DB-access
// parity, not decision/formatting-logic parity). What IS honestly checkable
// with what's built so far: for each university with a non-empty legacy
// fact_bundle, did the targeted query fetch ANY row for that university at
// all? A "yes" for every such university is reported as "exact"; any
// university where legacy has facts but targeted fetched zero rows is a
// real, reportable mismatch (e.g. the field wasn't in the allowlist, or the
// fetch failed).
function compareFactValues(legacyCards: ResultCard[], targeted: TargetedQueryResult): "exact" | "partial_mismatch" | "not_applicable" {
  const targetedById = new Map(targeted.factBundles.map((bundle) => [bundle.universityId, bundle]));
  let checked = 0;
  let mismatched = 0;
  for (const card of legacyCards) {
    if (!card.fact_bundle?.length) continue;
    checked += 1;
    const bundle = targetedById.get(card.university_id);
    const targetedRowCount = bundle ? Object.values(bundle.facts).flat().length : 0;
    if (targetedRowCount === 0) mismatched += 1;
  }
  if (!checked) return "not_applicable";
  return mismatched === 0 ? "exact" : "partial_mismatch";
}

// Same presence-level approach as compareFactValues, applied to source_url
// specifically: for each university where the legacy fact_bundle has at
// least one real source URL, did the targeted query fetch at least one row
// with a source_url at all for that same university?
function compareSourcePresence(legacyCards: ResultCard[], targeted: TargetedQueryResult): "exact" | "partial_mismatch" | "not_applicable" {
  const targetedById = new Map(targeted.factBundles.map((bundle) => [bundle.universityId, bundle]));
  let checked = 0;
  let mismatched = 0;
  for (const card of legacyCards) {
    const hasLegacySource = (card.fact_bundle ?? []).some((fact) => fact.source_url);
    if (!hasLegacySource) continue;
    checked += 1;
    const bundle = targetedById.get(card.university_id);
    const hasTargetedSource = bundle ? Object.values(bundle.facts).flat().some((row) => Boolean(row.source_url)) : false;
    if (!hasTargetedSource) mismatched += 1;
  }
  if (!checked) return "not_applicable";
  return mismatched === 0 ? "exact" : "partial_mismatch";
}

export function computeShadowParity(args: {
  requestId: string;
  intent: string;
  legacyCards: ResultCard[];
  targeted: TargetedQueryResult | null;
  targetedError?: string;
  legacyQueryMs: number;
  targetedQueryMs: number;
}): ShadowParityLog {
  const legacyUniversityIds = args.legacyCards.map((card) => card.university_id);
  const targetedUniversityIds = args.targeted?.universityIds ?? [];

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
      legacyUniversityIds,
      targetedUniversityIds: [],
      missingFromTargeted: legacyUniversityIds,
      extraInTargeted: [],
      orderMatches: false,
      factValueParity: "not_applicable",
      sourceParity: "not_applicable",
      conditionStateParity: "not_computed_by_targeted",
      unknownFieldParity: "not_computed_by_targeted",
      fetchedTables: [],
      rowCountsByTable: {},
      legacyFetchedRowCount: legacyRowCount(args.legacyCards),
      targetedFetchedRowCount: 0,
      legacyQueryMs: args.legacyQueryMs,
      targetedQueryMs: args.targetedQueryMs,
      parityStatus: "shadow_error",
      targetedErrors: args.targetedError ? [args.targetedError] : ["targeted_query_unavailable"],
    };
  }

  const factValueParity = compareFactValues(args.legacyCards, args.targeted);
  const sourceParity = compareSourcePresence(args.legacyCards, args.targeted);

  const targetedFetchedRowCount = Object.values(args.targeted.rowCountsByTable).reduce((sum, count) => sum + count, 0);
  const idsExact = missingFromTargeted.length === 0 && extraInTargeted.length === 0 && orderMatches;
  const parityStatus: ShadowParityStatus = args.targeted.errors.length
    ? "mismatch"
    : idsExact
      ? "exact"
      : missingFromTargeted.length || extraInTargeted.length
        ? "mismatch"
        : "equivalent";

  return {
    requestId: args.requestId,
    intent: args.intent,
    legacyUniversityIds,
    targetedUniversityIds,
    missingFromTargeted,
    extraInTargeted,
    orderMatches,
    factValueParity,
    sourceParity,
    conditionStateParity: "not_computed_by_targeted",
    unknownFieldParity: "not_computed_by_targeted",
    fetchedTables: args.targeted.fetchedTables,
    rowCountsByTable: args.targeted.rowCountsByTable,
    legacyFetchedRowCount: legacyRowCount(args.legacyCards),
    targetedFetchedRowCount,
    legacyQueryMs: args.legacyQueryMs,
    targetedQueryMs: args.targetedQueryMs,
    parityStatus,
    targetedErrors: args.targeted.errors,
  };
}

export function logShadowParity(parity: ShadowParityLog) {
  console.info("[chat-v2] targeted-query-shadow", parity);
}
