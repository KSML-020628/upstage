import type { PlannerRun } from "./query-plan.ts";
import type { Intent, QueryConstraints, ResultCard } from "./types.ts";
import type { UniversityCatalogItem } from "./university-catalog.ts";
import { groundPlannerFields } from "./planner-grounding.ts";
import { canaryRollFor } from "./targeted-primary.ts";
import {
  filterCatalogByRegionCountry,
  fetchLegacyFallbackFields,
  hydrateUniversitiesFromCatalog,
  queryRelevantUniversityFacts,
} from "./targeted-query.ts";
import type { University } from "../types";
import type { selectCards, selectClassifiedCards } from "./selection.ts";

// Phase 3B step 4 scope: compound-condition RECOMMENDATION queries only --
// region/country include-exclude, language test+score(+subscore), deadline
// before/after/year/semester, housing available/guaranteed, major, topN,
// and combinations of these. Explicitly NOT this step's scope (left on
// Legacy): named-university comparisons (2+ resolved targets -- that's a
// distinct, clearer-target problem the user's own review notes could be
// tackled independently, but isn't implemented here), follow-up re-ranking,
// cost/quota/gpa/official-source-driven recommendations, and
// course_restrictions-primary queries. The single-university lookup case
// remains targeted-primary.ts's job, untouched by this file.
export const COMPLEX_RECOMMENDATION_EXCLUDED_INTENTS: ReadonlySet<Intent> = new Set([
  "cost",
  "source",
  "restriction",
  "quota",
]);

const INTENT_TO_REQUESTED_FIELD: Partial<Record<Intent, string>> = {
  general: "universities",
  language: "language_requirements",
  housing: "housing_options",
  deadline: "application_deadlines",
};

// True when at least one condition this step actually supports is present.
// Deliberately narrower than search-conditions.ts's own
// hasRecommendationConditions -- that one also counts gpa/quota/
// requireOfficialSource, which this step must NOT attempt (see
// hasUnsupportedRecommendationConditions below). A request satisfying
// neither this nor the unsupported check is a fully broad "추천해줘" with
// no real narrowing condition at all -- explicitly excluded per the
// instruction ("유효한 candidate 조건이 전혀 없는 광범위 요청").
export function hasComplexRecommendationConditions(constraints: QueryConstraints): boolean {
  return Boolean(
    constraints.requireEurope ||
      constraints.requireAsia ||
      constraints.requireAmericas ||
      constraints.countries.length ||
      constraints.excludedCountries.length ||
      constraints.excludeAsia ||
      constraints.requireHousing ||
      constraints.requireHousingGuaranteed ||
      (constraints.languageTest && constraints.languageScore !== undefined) ||
      constraints.deadlineSemester !== undefined ||
      constraints.deadlineAcademicYear !== undefined ||
      (constraints.deadlineComparator !== undefined && constraints.deadlineDate !== undefined) ||
      constraints.major,
  );
}

// Any of these push the request into cost/quota/gpa/official-source
// territory this step does not attempt at all (no candidate-narrowing or
// hydration logic exists here for them) -- must fall back to Legacy, not
// silently ignore the condition.
export function hasUnsupportedRecommendationConditions(constraints: QueryConstraints): boolean {
  return Boolean(
    constraints.requireOfficialSource ||
      constraints.requireClearCost ||
      constraints.budgetKrwSemester !== undefined ||
      constraints.gpa !== undefined ||
      constraints.requireGpaKnown ||
      constraints.sortGpaLowest ||
      constraints.quotaMin !== undefined ||
      constraints.quotaMode !== undefined ||
      constraints.requireQuotaKnown ||
      constraints.requireHousingMissing,
  );
}

// Region/country are always-known catalog facts (never "unknown" for any
// university), so this can never drop a university evaluateUniversity
// would have called "partial" -- the only recall-relevant narrowing this
// step performs. Every other condition (language score, deadline date,
// housing, major) is intentionally left for the shared
// evaluateUniversity/selectClassifiedCards to classify AFTER hydration,
// exactly as Legacy does, rather than re-narrowing candidates by them here
// (over-inclusion never breaks recall; under-inclusion does -- see
// targeted-query.ts's candidateIdsFromHousing comment for the same
// principle applied to a single condition).
export function resolveComplexCandidateIds(constraints: QueryConstraints, catalog: UniversityCatalogItem[]): string[] {
  const regions = [
    ...(constraints.requireEurope ? ["europe"] : []),
    ...(constraints.requireAsia ? ["asia"] : []),
    ...(constraints.requireAmericas ? ["americas"] : []),
  ];
  const excludedRegions = constraints.excludeAsia ? ["asia"] : [];
  const filtered = filterCatalogByRegionCountry(
    {
      regions,
      excludedRegions,
      countries: constraints.countries,
      excludedCountries: constraints.excludedCountries,
    },
    catalog,
  );
  return filtered.map((item) => item.universityId);
}

export type TargetedRecommendationSelectedPath = "targeted_recommendation" | "legacy_fallback" | "legacy_default";

export type TargetedRecommendationResult = {
  selectedPath: TargetedRecommendationSelectedPath;
  fallbackReason: string | null;
  cards: ResultCard[] | null;
  classified: ReturnType<typeof selectClassifiedCards> | undefined;
  targetedAttempted: boolean;
  targetedSucceeded: boolean;
  complexRecommendationEligible: boolean;
  canarySelected: boolean;
  candidateCount: number;
  targetedQueryMs: number;
};

// Test-only dependency injection, same pattern and same safety boundary as
// TargetedPrimaryDeps in targeted-primary.ts -- route.ts's real call site
// never passes overrides; only a deliberate test invocation does.
export type TargetedRecommendationDeps = {
  resolveComplexCandidateIds?: typeof resolveComplexCandidateIds;
  queryRelevantUniversityFacts?: typeof queryRelevantUniversityFacts;
  fetchLegacyFallbackFields?: typeof fetchLegacyFallbackFields;
  selectCards?: typeof selectCards;
  selectClassifiedCards?: typeof selectClassifiedCards;
};

function notAttempted(fallbackReason: string, eligible = false): TargetedRecommendationResult {
  return {
    selectedPath: "legacy_default", fallbackReason, cards: null, classified: undefined,
    targetedAttempted: false, targetedSucceeded: false,
    complexRecommendationEligible: eligible, canarySelected: false, candidateCount: 0, targetedQueryMs: 0,
  };
}

function fellBack(fallbackReason: string, targetedQueryMs: number, candidateCount = 0): TargetedRecommendationResult {
  return {
    selectedPath: "legacy_fallback", fallbackReason, cards: null, classified: undefined,
    targetedAttempted: true, targetedSucceeded: false,
    complexRecommendationEligible: true, canarySelected: true, candidateCount, targetedQueryMs,
  };
}

export async function attemptTargetedRecommendation(args: {
  enabled: boolean;
  canaryRate: number;
  // Salted separately from targeted-primary.ts's single-university canary
  // key (see route.ts) so the two canaries are independently distributed,
  // per the instruction's "단일 대학용 CHAT_TARGETED_PRIMARY_* 설정과
  // 섞지 마세요" -- a session landing in the single-lookup canary bucket
  // says nothing about whether it lands in this one.
  canaryKey: string | null;
  intent: Intent;
  // Non-empty means a single/multi named-university target was already
  // resolved -- that's targeted-primary.ts's (or Legacy comparison's) job,
  // not this recommendation path's.
  catalogExactTargetIds: string[];
  hasFollowupContext: boolean;
  planner: PlannerRun;
  finalInScope: boolean;
  question: string;
  constraints: QueryConstraints;
  catalog: UniversityCatalogItem[];
  deps?: TargetedRecommendationDeps;
}): Promise<TargetedRecommendationResult> {
  if (!args.enabled) return notAttempted("flag_disabled");
  if (COMPLEX_RECOMMENDATION_EXCLUDED_INTENTS.has(args.intent)) return notAttempted("intent_not_eligible");
  if (args.catalogExactTargetIds.length > 0) return notAttempted("not_recommendation_query");
  if (args.hasFollowupContext) return notAttempted("followup_not_eligible");
  if (!args.planner.validatedPlan) return notAttempted("no_validated_plan");
  if (!args.finalInScope) return notAttempted("out_of_scope");
  if (hasUnsupportedRecommendationConditions(args.constraints)) return notAttempted("unsupported_condition");
  if (!hasComplexRecommendationConditions(args.constraints)) return notAttempted("no_actionable_condition");
  if (args.canaryKey === null) return notAttempted("no_stable_canary_key");
  if (!canaryRollFor(args.canaryKey, args.canaryRate)) return notAttempted("canary_miss", true);

  const attemptStart = Date.now();
  try {
    const grounded = groundPlannerFields({ question: args.question, validatedPlan: args.planner.validatedPlan });
    if (grounded.issues.length) return fellBack("planner_grounding_issue", Date.now() - attemptStart);

    const resolveComplexCandidateIdsFn = args.deps?.resolveComplexCandidateIds ?? resolveComplexCandidateIds;
    const candidateIds = resolveComplexCandidateIdsFn(args.constraints, args.catalog);
    if (!candidateIds.length) return fellBack("empty_candidate_pool", Date.now() - attemptStart, 0);

    const intentField = INTENT_TO_REQUESTED_FIELD[args.intent];
    const conditionFields = [
      ...(args.constraints.languageTest && args.constraints.languageScore !== undefined ? ["language_requirements"] : []),
      ...(args.constraints.requireHousing || args.constraints.requireHousingGuaranteed ? ["housing_options"] : []),
      ...(args.constraints.deadlineSemester !== undefined
        || args.constraints.deadlineAcademicYear !== undefined
        || (args.constraints.deadlineComparator !== undefined && args.constraints.deadlineDate !== undefined)
        ? ["application_deadlines"]
        : []),
    ];
    // Always unions in the FINAL, already-computed constraints.requestedFields
    // (never grounded.requestedFields.value as a substitute) -- cards.ts's
    // own requestedFactBundle() (what Legacy actually calls) unions
    // primaryIntent with constraints.requestedFields, never with a
    // separately re-derived grounding result. Live parity testing caught
    // the divergence this fixes: grounded.requestedFields.value could
    // legitimately differ from constraints.requestedFields (the Planner's
    // own raw plan sometimes claims a broader requestedFields set than what
    // the question text actually grounds), which surfaced as an EXTRA
    // fact_bundle entry (e.g. application_deadlines on a pure housing-only
    // query) that Legacy's own cards never showed for the identical
    // constraints object. intentField/conditionFields above already cover
    // this path's own "compensate for an empty requestedFields on a
    // single-intent query" need (language/housing/deadline), so grounded
    // itself is only still needed for its issues check below.
    const groundedRequestedFields = [...new Set([
      ...(intentField ? [intentField] : []),
      ...conditionFields,
      ...args.constraints.requestedFields,
    ])];

    const queryRelevantUniversityFactsFn = args.deps?.queryRelevantUniversityFacts ?? queryRelevantUniversityFacts;
    const targeted = await queryRelevantUniversityFactsFn(candidateIds, groundedRequestedFields, "candidate_id_search");
    if (targeted.errors.length) return fellBack("targeted_error", Date.now() - attemptStart, candidateIds.length);
    if (targeted.unsupportedFields.length) return fellBack("unsupported_field", Date.now() - attemptStart, candidateIds.length);

    const fetchLegacyFallbackFieldsFn = args.deps?.fetchLegacyFallbackFields ?? fetchLegacyFallbackFields;
    const legacyFallback = await fetchLegacyFallbackFieldsFn(candidateIds);

    const candidateIdSet = new Set(candidateIds);
    const candidateCatalogItems = args.catalog.filter((item) => candidateIdSet.has(item.universityId));
    const hydratedUniversities: University[] = hydrateUniversitiesFromCatalog(
      candidateCatalogItems,
      targeted.factBundles,
      new Map(),
      legacyFallback.data,
    );

    // Matches route.ts's own existing useClassification formula exactly
    // (intent !== "cost" && intent !== "deadline") -- cost is already
    // excluded above via COMPLEX_RECOMMENDATION_EXCLUDED_INTENTS, so only
    // the deadline check is live here. Deadline-primary recommendations use
    // Legacy's plain selectCards + passesStructuredFilters pool, not the
    // matched/partial/excluded classification -- reusing the same
    // condition means this path can never disagree with Legacy about which
    // branch a given intent takes.
    const useClassification = args.intent !== "deadline";

    // Each import is lazy AND only reached for the branch actually taken --
    // selection.ts also exports unknownInstitutionResponse, which pulls in
    // next/server (fine under Next's own bundler, but it breaks a plain
    // `node --test` run if imported at all, even from a branch that's never
    // executed this call, since a dynamic import() still evaluates the
    // target module's top-level code the moment it's awaited).
    let cards: ResultCard[];
    let classified: ReturnType<typeof selectClassifiedCards> | undefined;
    if (useClassification) {
      const selectClassifiedCardsFn = args.deps?.selectClassifiedCards ?? (await import("./selection.ts")).selectClassifiedCards;
      classified = selectClassifiedCardsFn(hydratedUniversities, args.constraints, args.question);
      cards = [...classified.matched, ...classified.partiallyMatched];
    } else {
      const selectCardsFn = args.deps?.selectCards ?? (await import("./selection.ts")).selectCards;
      cards = selectCardsFn(hydratedUniversities, args.constraints, args.question);
    }

    // Cheap self-consistency check (the recall-preserving guarantee itself
    // comes from resolveComplexCandidateIds never narrowing by an
    // unknown-capable condition, not from this check) -- catches the exact
    // class of bug already found once in this codebase's history (Phase
    // 3A.1's shadow re-test: candidate resolution silently substituting
    // unrelated universities into the hydrated set).
    if (cards.some((card) => !candidateIdSet.has(card.university_id))) {
      return fellBack("validation_failed", Date.now() - attemptStart, candidateIds.length);
    }

    return {
      selectedPath: "targeted_recommendation", fallbackReason: null, cards, classified,
      targetedAttempted: true, targetedSucceeded: true,
      complexRecommendationEligible: true, canarySelected: true,
      candidateCount: candidateIds.length, targetedQueryMs: Date.now() - attemptStart,
    };
  } catch (error) {
    return fellBack(
      error instanceof Error ? `targeted_error:${error.message}` : "targeted_error",
      Date.now() - attemptStart,
    );
  }
}
