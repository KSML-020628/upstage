import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  attemptTargetedRecommendation,
  hasComplexRecommendationConditions,
  hasUnsupportedRecommendationConditions,
  resolveComplexCandidateIds,
  COMPLEX_RECOMMENDATION_EXCLUDED_INTENTS,
} from "../app/lib/chat/targeted-recommendation.ts";
import type { PlannerRun } from "../app/lib/chat/query-plan.ts";
import type { QueryPlan } from "../app/lib/chat/query-plan.ts";
import type { QueryConstraints, ResultCard } from "../app/lib/chat/types.ts";
import type { UniversityCatalogItem } from "../app/lib/chat/university-catalog.ts";
import type { TargetedQueryResult } from "../app/lib/chat/targeted-query.ts";

function plan(overrides: Partial<QueryPlan> = {}): QueryPlan {
  return {
    intent: "university_recommendation",
    universityNames: [],
    hardFilters: { regions: [], countries: [], excludedRegions: [], excludedCountries: [] },
    softPreferences: {},
    requestedFields: [],
    limit: 4,
    followupReference: { enabled: false },
    clarificationNeeded: false,
    ...overrides,
  } as QueryPlan;
}

function plannerRun(validatedPlan: QueryPlan | null): PlannerRun {
  return { rawPlan: validatedPlan, validatedPlan, issues: [], usedSolar: true };
}

function constraints(overrides: Partial<QueryConstraints> = {}): QueryConstraints {
  return {
    intent: "language",
    topN: 4,
    explicitTopN: false,
    requireEurope: false,
    requireAsia: false,
    requireAmericas: false,
    inScope: true,
    requireHousing: false,
    requireHousingGuaranteed: false,
    requireAll: false,
    requireOfficialSource: false,
    requireClearCost: false,
    countries: [],
    excludedCountries: [],
    excludeAsia: false,
    requestedFields: [],
    explicitClears: [],
    ...overrides,
  } as QueryConstraints;
}

const catalog: UniversityCatalogItem[] = [
  { universityId: "u-sheffield", universityName: "University of Sheffield", aliases: [], country: "United Kingdom", region: "europe" },
  { universityId: "u-bristol", universityName: "University of Bristol", aliases: [], country: "United Kingdom", region: "europe" },
  { universityId: "u-hanken", universityName: "Hanken School of Economics", aliases: [], country: "Finland", region: "europe" },
  { universityId: "u-ntu", universityName: "National Taiwan University", aliases: [], country: "Taiwan", region: "asia" },
  { universityId: "u-tokyo", universityName: "University of Tokyo", aliases: [], country: "Japan", region: "asia" },
  { universityId: "u-toronto", universityName: "University of Toronto", aliases: [], country: "Canada", region: "americas" },
];

const baseArgs = {
  enabled: true,
  canaryRate: 1,
  canaryKey: "test-session-id",
  intent: "language" as const,
  catalogExactTargetIds: [] as string[],
  hasFollowupContext: false,
  planner: plannerRun(plan()),
  finalInScope: true,
  question: "IELTS 6.0으로 가능한 유럽 대학을 추천해줘.",
  constraints: constraints({ requireEurope: true, languageTest: "IELTS Academic", languageScore: 6.0 }),
  catalog,
};

function emptyTargetedQueryResult(universityIds: string[]): TargetedQueryResult {
  return {
    universityIds,
    candidateSource: "candidate_id_search",
    fetchedTables: [],
    queryCount: 0,
    rowCountsByTable: {},
    factBundles: universityIds.map((id) => ({ universityId: id, universityName: "", facts: {} })),
    unsupportedFields: [],
    errors: [],
  };
}

function fakeCard(universityId: string): ResultCard {
  return {
    university_id: universityId,
    university_name: universityId,
    country: "", city: "", summary: "", badges: [], highlights: [],
    action_label: "", action_url: "",
  };
}

describe("hasComplexRecommendationConditions / hasUnsupportedRecommendationConditions", () => {
  it("is false for a fully broad request with no narrowing condition at all", () => {
    assert.equal(hasComplexRecommendationConditions(constraints()), false);
  });
  it("is true when a region condition alone is present", () => {
    assert.equal(hasComplexRecommendationConditions(constraints({ requireEurope: true })), true);
  });
  it("is true when a housing-guarantee condition alone is present", () => {
    assert.equal(hasComplexRecommendationConditions(constraints({ requireHousingGuaranteed: true })), true);
  });
  it("is true when a deadline-after condition (comparator+date) is present", () => {
    assert.equal(hasComplexRecommendationConditions(constraints({ deadlineComparator: "gte", deadlineDate: "2026-05-01" })), true);
  });
  it("is true when only major is present", () => {
    assert.equal(hasComplexRecommendationConditions(constraints({ major: "engineering" })), true);
  });
  it("language test alone (no score) does not count -- languageScore is required too", () => {
    assert.equal(hasComplexRecommendationConditions(constraints({ languageTest: "IELTS Academic" })), false);
  });

  it("flags gpa/quota/cost/official-source conditions as unsupported this step", () => {
    assert.equal(hasUnsupportedRecommendationConditions(constraints({ gpa: 3.5 })), true);
    assert.equal(hasUnsupportedRecommendationConditions(constraints({ quotaMin: 2 })), true);
    assert.equal(hasUnsupportedRecommendationConditions(constraints({ budgetKrwSemester: 5_000_000 })), true);
    assert.equal(hasUnsupportedRecommendationConditions(constraints({ requireOfficialSource: true })), true);
    assert.equal(hasUnsupportedRecommendationConditions(constraints({ requireHousingMissing: true })), true);
  });
  it("does not flag the allowed condition set as unsupported", () => {
    assert.equal(hasUnsupportedRecommendationConditions(constraints({ requireEurope: true, requireHousingGuaranteed: true, major: "engineering" })), false);
  });
});

describe("COMPLEX_RECOMMENDATION_EXCLUDED_INTENTS: cost/source/restriction/quota held back this step", () => {
  it("excludes exactly cost/source/restriction/quota", () => {
    assert.deepEqual([...COMPLEX_RECOMMENDATION_EXCLUDED_INTENTS].sort(), ["cost", "quota", "restriction", "source"].sort());
  });
});

describe("resolveComplexCandidateIds: recall-safe region/country narrowing (catalog-only, never an 'unknown' condition)", () => {
  it("requireEurope narrows to exactly the europe-region catalog entries", () => {
    const ids = resolveComplexCandidateIds(constraints({ requireEurope: true }), catalog);
    assert.deepEqual(ids.sort(), ["u-bristol", "u-hanken", "u-sheffield"].sort());
  });
  it("excludeAsia removes exactly the asia-region entries, keeping the rest", () => {
    const ids = resolveComplexCandidateIds(constraints({ excludeAsia: true }), catalog);
    assert.deepEqual(ids.sort(), ["u-bristol", "u-hanken", "u-sheffield", "u-toronto"].sort());
  });
  it("countries narrows to an exact country match", () => {
    const ids = resolveComplexCandidateIds(constraints({ countries: ["Finland"] }), catalog);
    assert.deepEqual(ids, ["u-hanken"]);
  });
  it("excludedCountries removes a specific country while keeping everyone else", () => {
    const ids = resolveComplexCandidateIds(constraints({ excludedCountries: ["Finland"] }), catalog);
    assert.deepEqual(ids.sort(), ["u-bristol", "u-ntu", "u-sheffield", "u-tokyo", "u-toronto"].sort());
  });
  it("combining requireEurope + excludedCountries narrows both dimensions together", () => {
    const ids = resolveComplexCandidateIds(constraints({ requireEurope: true, excludedCountries: ["Finland"] }), catalog);
    assert.deepEqual(ids.sort(), ["u-bristol", "u-sheffield"].sort());
  });
  it("a language/housing/deadline/major-only condition (no region/country) never narrows the candidate pool at all -- full catalog, by design (recall safety over precision)", () => {
    const ids = resolveComplexCandidateIds(constraints({ languageTest: "IELTS Academic", languageScore: 6.0 }), catalog);
    assert.equal(ids.length, catalog.length);
  });

  it("includedRegions + excludedRegions used together narrow to the intersection", () => {
    // Every entry in `catalog` is either europe/asia/americas -- excluding
    // asia on top of requiring europe should just be europe (asia is
    // already outside the include set, so the exclude is a no-op here, but
    // exercises both dials active simultaneously without one silently
    // overriding the other).
    const ids = resolveComplexCandidateIds(constraints({ requireEurope: true, excludeAsia: true }), catalog);
    assert.deepEqual(ids.sort(), ["u-bristol", "u-hanken", "u-sheffield"].sort());
  });

  it("includedCountries + excludedCountries used together: exclude wins when they name the same country (an impossible combination the caller should never actually construct, but must not silently include it anyway)", () => {
    const ids = resolveComplexCandidateIds(constraints({ countries: ["Finland"], excludedCountries: ["Finland"] }), catalog);
    assert.deepEqual(ids, []);
  });

  it("country matching is case-insensitive", () => {
    const ids = resolveComplexCandidateIds(constraints({ countries: ["fInLaNd"] }), catalog);
    assert.deepEqual(ids, ["u-hanken"]);
  });

  describe("recall safety when the catalog's own region/country data is incomplete (Phase 3B integration requirement [4])", () => {
    // Real-world trigger: university-catalog.ts's deriveRegion is derived
    // from `country` alone (EUROPE_COUNTRIES/ASIA_COUNTRIES/AMERICAS_COUNTRIES
    // set membership + a UK regex), while filters.ts's own
    // isEuropeanUniversity/isAsianUniversity/isAmericasUniversity (what
    // Legacy's evaluateUniversity/passesStructuredFilters actually use) is
    // STRICTLY BROADER -- it also matches via known city/university-name
    // text the catalog doesn't even carry a field for (UniversityCatalogItem
    // has no `city` field at all). A university whose `country` the catalog
    // can't classify (region: undefined) but whose city/name Legacy WOULD
    // recognize must still reach the candidate pool, or recall silently
    // drops below 100% for exactly that university.
    const catalogWithUnknowns: typeof catalog = [
      ...catalog,
      { universityId: "u-unknown-region", universityName: "Somewhere University", aliases: [], country: "Atlantis", region: undefined },
      { universityId: "u-unknown-country", universityName: "Mystery University", aliases: [], country: undefined, region: undefined },
    ];

    it("a catalog entry with region: undefined is NOT dropped by an inclusive region filter (kept as a candidate, not silently excluded)", () => {
      const ids = resolveComplexCandidateIds(constraints({ requireEurope: true }), catalogWithUnknowns);
      assert.ok(ids.includes("u-unknown-region"), "expected the unknown-region university to be kept as a candidate");
      assert.ok(ids.includes("u-unknown-country"), "expected the unknown-country university to be kept as a candidate");
    });

    it("a catalog entry with region: undefined is NOT dropped by an exclusive region filter either (can't confirm it's the excluded region, so it must not be assumed to be)", () => {
      const ids = resolveComplexCandidateIds(constraints({ excludeAsia: true }), catalogWithUnknowns);
      assert.ok(ids.includes("u-unknown-region"));
      assert.ok(ids.includes("u-unknown-country"));
    });

    it("a catalog entry with country: undefined is NOT dropped by an inclusive country filter", () => {
      const ids = resolveComplexCandidateIds(constraints({ countries: ["Finland"] }), catalogWithUnknowns);
      assert.ok(ids.includes("u-unknown-country"), "expected the unknown-country university to be kept even though it doesn't match the named country");
    });

    it("a catalog entry with a KNOWN, non-matching country is still correctly excluded (the fix is only about unknowns, not a blanket broadening)", () => {
      const ids = resolveComplexCandidateIds(constraints({ countries: ["Finland"] }), catalogWithUnknowns);
      assert.ok(!ids.includes("u-unknown-region"), "Atlantis is a known (if fictional) country that isn't Finland -- must still be excluded");
    });
  });
});

describe("attemptTargetedRecommendation: eligibility gate never even attempts outside its scope", () => {
  it("does not attempt when the feature flag is disabled", async () => {
    const result = await attemptTargetedRecommendation({ ...baseArgs, enabled: false });
    assert.equal(result.selectedPath, "legacy_default");
    assert.equal(result.fallbackReason, "flag_disabled");
  });

  it("does not attempt for an excluded intent (cost)", async () => {
    const result = await attemptTargetedRecommendation({ ...baseArgs, intent: "cost" });
    assert.equal(result.fallbackReason, "intent_not_eligible");
  });

  it("does not attempt when a single/multi named-university target was already resolved (that's targeted-primary's or Legacy comparison's job)", async () => {
    const result = await attemptTargetedRecommendation({ ...baseArgs, catalogExactTargetIds: ["u-sheffield"] });
    assert.equal(result.fallbackReason, "not_recommendation_query");
  });

  it("does not attempt when there is follow-up context", async () => {
    const result = await attemptTargetedRecommendation({ ...baseArgs, hasFollowupContext: true });
    assert.equal(result.fallbackReason, "followup_not_eligible");
  });

  it("does not attempt without a validated Planner plan", async () => {
    const result = await attemptTargetedRecommendation({ ...baseArgs, planner: plannerRun(null) });
    assert.equal(result.fallbackReason, "no_validated_plan");
  });

  it("does not attempt when the question is out of scope", async () => {
    const result = await attemptTargetedRecommendation({ ...baseArgs, finalInScope: false });
    assert.equal(result.fallbackReason, "out_of_scope");
  });

  it("does not attempt when an unsupported condition (gpa/quota/cost/official-source) is present", async () => {
    const result = await attemptTargetedRecommendation({ ...baseArgs, constraints: constraints({ requireEurope: true, gpa: 3.5 }) });
    assert.equal(result.fallbackReason, "unsupported_condition");
  });

  it("does not attempt for a fully broad request with no actionable condition at all", async () => {
    const result = await attemptTargetedRecommendation({ ...baseArgs, constraints: constraints() });
    assert.equal(result.fallbackReason, "no_actionable_condition");
  });

  it("does not attempt when there is no stable canary key", async () => {
    const result = await attemptTargetedRecommendation({ ...baseArgs, canaryKey: null });
    assert.equal(result.fallbackReason, "no_stable_canary_key");
    assert.equal(result.complexRecommendationEligible, false);
  });

  it("does not attempt when the canary rate is 0 (guaranteed miss) -- but this IS eligible, unlike the structural exclusions above", async () => {
    const result = await attemptTargetedRecommendation({ ...baseArgs, canaryRate: 0 });
    assert.equal(result.fallbackReason, "canary_miss");
    assert.equal(result.complexRecommendationEligible, true);
    assert.equal(result.canarySelected, false);
  });

  it("every structural exclusion reports complexRecommendationEligible: false, canarySelected: false", async () => {
    const structuralExclusions: Array<Partial<Parameters<typeof attemptTargetedRecommendation>[0]>> = [
      { enabled: false },
      { intent: "cost" },
      { catalogExactTargetIds: ["u-sheffield"] },
      { hasFollowupContext: true },
      { planner: plannerRun(null) },
      { finalInScope: false },
      { constraints: constraints({ requireEurope: true, gpa: 3.5 }) },
      { constraints: constraints() },
      { canaryKey: null },
    ];
    for (const override of structuralExclusions) {
      const result = await attemptTargetedRecommendation({ ...baseArgs, ...override });
      assert.equal(result.complexRecommendationEligible, false, `expected false for ${JSON.stringify(override)}`);
      assert.equal(result.canarySelected, false, `expected false for ${JSON.stringify(override)}`);
    }
  });
});

describe("attemptTargetedRecommendation: successful attempt reuses the shared selectCards/selectClassifiedCards, never a separate evaluator", () => {
  it("uses selectClassifiedCards (matched+partial) for a non-deadline intent, matching route.ts's own useClassification formula", async () => {
    const stubCards = [fakeCard("u-sheffield"), fakeCard("u-bristol")];
    const result = await attemptTargetedRecommendation({
      ...baseArgs,
      deps: {
        queryRelevantUniversityFacts: async (ids) => emptyTargetedQueryResult(ids),
        fetchLegacyFallbackFields: async () => ({ data: new Map(), rowCount: 0, queryCount: 0 }),
        selectClassifiedCards: () => ({ matched: [stubCards[0]], partiallyMatched: [stubCards[1]], excluded: [] }),
      },
    });
    assert.equal(result.selectedPath, "targeted_recommendation");
    assert.equal(result.targetedSucceeded, true);
    assert.ok(result.classified, "expected a classified result for a non-deadline intent");
    assert.deepEqual(result.cards?.map((c) => c.university_id), ["u-sheffield", "u-bristol"]);
  });

  it("uses plain selectCards (no classification) for a deadline-intent recommendation, matching Legacy's own strict-filter branch", async () => {
    const stubCards = [fakeCard("u-sheffield")];
    const result = await attemptTargetedRecommendation({
      ...baseArgs,
      intent: "deadline",
      constraints: constraints({ requireEurope: true, deadlineComparator: "gte", deadlineDate: "2026-05-01" }),
      deps: {
        queryRelevantUniversityFacts: async (ids) => emptyTargetedQueryResult(ids),
        fetchLegacyFallbackFields: async () => ({ data: new Map(), rowCount: 0, queryCount: 0 }),
        selectCards: () => stubCards,
      },
    });
    assert.equal(result.selectedPath, "targeted_recommendation");
    assert.equal(result.classified, undefined, "deadline intent must not use the classified branch");
    assert.deepEqual(result.cards?.map((c) => c.university_id), ["u-sheffield"]);
  });

  it("reports the resolved candidateCount on success", async () => {
    const result = await attemptTargetedRecommendation({
      ...baseArgs,
      deps: {
        queryRelevantUniversityFacts: async (ids) => emptyTargetedQueryResult(ids),
        fetchLegacyFallbackFields: async () => ({ data: new Map(), rowCount: 0, queryCount: 0 }),
        selectClassifiedCards: () => ({ matched: [fakeCard("u-sheffield")], partiallyMatched: [], excluded: [] }),
      },
    });
    // requireEurope -> u-sheffield/u-bristol/u-hanken (3 candidates)
    assert.equal(result.candidateCount, 3);
  });
});

describe("attemptTargetedRecommendation: fallback paths (forced via dependency injection, never real data mutation)", () => {
  it("falls back with empty_candidate_pool when candidate resolution yields zero ids", async () => {
    const result = await attemptTargetedRecommendation({
      ...baseArgs,
      deps: { resolveComplexCandidateIds: () => [] },
    });
    assert.equal(result.selectedPath, "legacy_fallback");
    assert.equal(result.fallbackReason, "empty_candidate_pool");
    assert.equal(result.targetedSucceeded, false);
  });

  it("falls back with targeted_error when queryRelevantUniversityFacts throws", async () => {
    const result = await attemptTargetedRecommendation({
      ...baseArgs,
      deps: {
        queryRelevantUniversityFacts: async () => {
          throw new Error("simulated failure");
        },
      },
    });
    assert.equal(result.selectedPath, "legacy_fallback");
    assert.ok(result.fallbackReason?.startsWith("targeted_error"), `expected targeted_error, got ${result.fallbackReason}`);
  });

  it("falls back with targeted_error when queryRelevantUniversityFacts reports fetch errors", async () => {
    const result = await attemptTargetedRecommendation({
      ...baseArgs,
      deps: {
        queryRelevantUniversityFacts: async (ids) => ({ ...emptyTargetedQueryResult(ids), errors: ["fetch_failed:language_requirements:boom"] }),
      },
    });
    assert.equal(result.fallbackReason, "targeted_error");
  });

  it("falls back with unsupported_field when queryRelevantUniversityFacts reports an unsupported field", async () => {
    const result = await attemptTargetedRecommendation({
      ...baseArgs,
      deps: {
        queryRelevantUniversityFacts: async (ids) => ({ ...emptyTargetedQueryResult(ids), unsupportedFields: ["source_links"] }),
      },
    });
    assert.equal(result.fallbackReason, "unsupported_field");
  });

  it("falls back with validation_failed when a returned card's university_id is not in the resolved candidate set", async () => {
    const result = await attemptTargetedRecommendation({
      ...baseArgs,
      deps: {
        queryRelevantUniversityFacts: async (ids) => emptyTargetedQueryResult(ids),
        fetchLegacyFallbackFields: async () => ({ data: new Map(), rowCount: 0, queryCount: 0 }),
        selectClassifiedCards: () => ({ matched: [fakeCard("not-a-real-candidate-id")], partiallyMatched: [], excluded: [] }),
      },
    });
    assert.equal(result.fallbackReason, "validation_failed");
  });

  it("every fallback result still reports targetedAttempted: true, targetedSucceeded: false, complexRecommendationEligible: true, canarySelected: true", async () => {
    const result = await attemptTargetedRecommendation({
      ...baseArgs,
      deps: {
        queryRelevantUniversityFacts: async () => {
          throw new Error("simulated");
        },
      },
    });
    assert.equal(result.targetedAttempted, true);
    assert.equal(result.targetedSucceeded, false);
    assert.equal(result.complexRecommendationEligible, true);
    assert.equal(result.canarySelected, true);
  });
});
