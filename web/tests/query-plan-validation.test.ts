import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateQueryPlan } from "../app/lib/chat/query-plan.ts";
import { applyValidatedPlannerPlan } from "../app/lib/chat/planner-integration.ts";
import { detectConstraints } from "../app/lib/chat/constraints.ts";

const Q4 = "아시아 빼고 2026-05-01 이후 마감인 대학";

function rawPlan(overrides: Record<string, unknown> = {}) {
  return {
    intent: "deadline",
    universityNames: [],
    hardFilters: {
      regions: [], countries: [], excludedRegions: [], excludedCountries: [],
      ieltsMax: null, ieltsMinimumSubscore: null, toeflMax: null, gpaValue: null, gpaScale: null,
      housingAvailable: null, housingGuaranteed: null, quotaMin: null,
      semesters: [], academicYears: [], majors: [],
      officialSourceRequired: null, numericCostRequired: null,
      ...overrides.hardFilters as object,
    },
    softPreferences: { lowerCost: null, englishCourses: null, housingPreferred: null, earlierDeadline: null },
    requestedFields: [],
    limit: 4,
    followupReference: { enabled: false, ordinal: null, previousResultOnly: null },
    clarificationNeeded: false,
    clarificationQuestion: null,
    ...overrides,
  };
}

describe("validateQueryPlan: limit grounding", () => {
  it("rejects an ungrounded limit (the exact q4 bug: Solar guesses a count the question never stated)", () => {
    const { plan, issues } = validateQueryPlan(Q4, rawPlan({ limit: 10 }), []);
    assert.equal(plan?.limit, 4);
    assert.ok(issues.includes("limit_not_grounded"));
  });

  it("also rejects an ungrounded limit of 0", () => {
    const { plan, issues } = validateQueryPlan(Q4, rawPlan({ limit: 0 }), []);
    assert.equal(plan?.limit, 4);
    assert.ok(issues.includes("limit_not_grounded"));
  });

  it("accepts a limit that's actually grounded in the question's own text", () => {
    const { plan, issues } = validateQueryPlan("유럽 대학 3개를 추천해줘", rawPlan({ limit: 3 }), []);
    assert.equal(plan?.limit, 3);
    assert.ok(!issues.includes("limit_not_grounded"));
  });

  it("does not let a date's own digits (2026-05-01) ground an unrelated limit of 5", () => {
    // Regression: once the schema declared limit's bounds as 1-5, Solar
    // started landing on 5 consistently for q4 instead of its earlier
    // out-of-range guesses (0, 10) -- and "05" inside "2026-05-01" is
    // numerically 5, so the OLD (pre-fix) grounding check treated that
    // date fragment as if the user had asked for "5개", re-introducing the
    // exact nondeterminism this whole fix exists to remove.
    const { plan, issues } = validateQueryPlan(Q4, rawPlan({ limit: 5 }), []);
    assert.equal(plan?.limit, 4);
    assert.ok(issues.includes("limit_not_grounded"));
  });

  it("still grounds a real explicit count even when the question also contains a date", () => {
    const { plan, issues } = validateQueryPlan("2026-05-01 이후 마감인 대학 3개 추천해줘", rawPlan({ limit: 3 }), []);
    assert.equal(plan?.limit, 3);
    assert.ok(!issues.includes("limit_not_grounded"));
  });
});

describe("validateQueryPlan: region polarity", () => {
  it("rejects a positive region claim when the question phrases it as an exclusion (the q4 hypothesis)", () => {
    const { plan, issues } = validateQueryPlan(Q4, rawPlan({ hardFilters: { regions: ["asia"] } }), []);
    assert.deepEqual(plan?.hardFilters.regions, []);
    assert.ok(issues.includes("region_polarity_conflict:asia"));
  });

  it("accepts excludedRegions for the same exclusion-phrased question", () => {
    const { plan, issues } = validateQueryPlan(Q4, rawPlan({ hardFilters: { excludedRegions: ["asia"] } }), []);
    assert.deepEqual(plan?.hardFilters.excludedRegions, ["asia"]);
    assert.ok(!issues.some((issue) => issue.startsWith("excluded_region_not_grounded")));
  });

  it("accepts a genuine positive region claim with no exclusion marker nearby", () => {
    const { plan, issues } = validateQueryPlan("유럽 대학 추천해줘", rawPlan({ hardFilters: { regions: ["europe"] } }), []);
    assert.deepEqual(plan?.hardFilters.regions, ["europe"]);
    assert.ok(!issues.some((issue) => issue.startsWith("region_polarity_conflict")));
  });

  it("flags a direct include/exclude self-contradiction for the same region", () => {
    // No exclusion marker anywhere near "유럽" -- both individual polarity
    // checks pass on their own, so this isolates the separate "same region
    // claimed on both sides at once" self-contradiction check.
    const { issues } = validateQueryPlan(
      "유럽 대학 정보 알려줘",
      rawPlan({ hardFilters: { regions: ["europe"], excludedRegions: ["europe"] } }),
      [],
    );
    assert.ok(issues.includes("region_include_exclude_conflict:europe"));
  });
});

describe("planner-integration applyValidatedPlannerPlan: topN merge uses explicitTopN, not a magic-default comparison", () => {
  it("adopts the Planner's grounded limit when the user gave no explicit count (the fixed q4 path)", () => {
    const legacy = detectConstraints(Q4);
    assert.equal(legacy.topN, 4);
    assert.equal(legacy.explicitTopN, false);
    const { plan } = validateQueryPlan(Q4, rawPlan({ limit: 4, hardFilters: { excludedRegions: ["asia"] } }), []);
    const merged = applyValidatedPlannerPlan(legacy, plan);
    assert.equal(merged.topN, 4);
  });

  it("keeps the user's own explicit count even if the (already-validated) Planner limit differs", () => {
    const legacy = detectConstraints("유럽 대학 3개 추천해줘");
    assert.equal(legacy.topN, 3);
    assert.equal(legacy.explicitTopN, true);
    const { plan } = validateQueryPlan("유럽 대학 3개 추천해줘", rawPlan({ limit: 3, hardFilters: { regions: ["europe"] } }), []);
    // Force the validated plan's limit to disagree with the user's own
    // explicit count, to isolate the merge decision itself from
    // validateQueryPlan's grounding -- explicitTopN must win regardless of
    // what the Planner says.
    const disagreeingPlan = plan ? { ...plan, limit: 5 } : plan;
    const merged = applyValidatedPlannerPlan(legacy, disagreeingPlan);
    assert.equal(merged.topN, 3);
  });
});
