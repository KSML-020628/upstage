import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveTargetedPrimary, TARGETED_PRIMARY_ALLOWED_INTENTS } from "../app/lib/chat/targeted-primary.ts";
import type { PlannerRun } from "../app/lib/chat/query-plan.ts";
import type { QueryPlan } from "../app/lib/chat/query-plan.ts";
import type { QueryConstraints } from "../app/lib/chat/types.ts";
import type { University } from "../app/lib/types.ts";

function plan(overrides: Partial<QueryPlan> = {}): QueryPlan {
  return {
    intent: "language_requirement",
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
    countries: [],
    excludedCountries: [],
    topN: 4,
    requestedFields: [],
    ...overrides,
  } as QueryConstraints;
}

const sheffield: University = {
  id: "u-sheffield", university_name: "University of Sheffield", country: "United Kingdom", city: "Sheffield",
  summary: "", latitude: 0, longitude: 0,
  exchange_programs: [{ id: "p1", university_id: "u-sheffield", academic_year: "2026/27", program_name: "Exchange" }],
};

const baseArgs = {
  enabled: true,
  canaryRate: 1,
  intent: "language" as const,
  exactTargets: [sheffield],
  followupTargets: [],
  planner: plannerRun(plan()),
  finalInScope: true,
  question: "University of Sheffield의 IELTS 조건을 알려줘.",
  constraints: constraints(),
  legacyById: new Map([["u-sheffield", sheffield]]),
};

describe("TARGETED_PRIMARY_ALLOWED_INTENTS: Phase 3B step 1 scope is single-university lookups only", () => {
  it("allows exactly general/language/housing/deadline, holding back cost/quota/restriction/source", () => {
    assert.deepEqual(
      [...TARGETED_PRIMARY_ALLOWED_INTENTS].sort(),
      ["deadline", "general", "housing", "language"].sort(),
    );
  });
});

describe("resolveTargetedPrimary: eligibility gate never even attempts the Targeted path outside its scope", () => {
  it("does not attempt when the feature flag is disabled (defaults doubly safe)", async () => {
    const result = await resolveTargetedPrimary({ ...baseArgs, enabled: false });
    assert.equal(result.selectedPath, "legacy_default");
    assert.equal(result.fallbackReason, "flag_disabled");
    assert.equal(result.cards, null);
  });

  it("does not attempt for a held-back intent (e.g. cost recommendation)", async () => {
    const result = await resolveTargetedPrimary({ ...baseArgs, intent: "cost" });
    assert.equal(result.fallbackReason, "intent_not_eligible");
  });

  it("does not attempt when there is follow-up context (held back for a later expansion)", async () => {
    const result = await resolveTargetedPrimary({ ...baseArgs, followupTargets: [sheffield] });
    assert.equal(result.fallbackReason, "followup_not_eligible");
  });

  it("does not attempt for a recommendation query with zero named universities", async () => {
    const result = await resolveTargetedPrimary({ ...baseArgs, exactTargets: [] });
    assert.equal(result.fallbackReason, "not_single_target");
  });

  it("does not attempt for a multi-university comparison (다수 대학 비교 및 랭킹 held back)", async () => {
    const bristol: University = { ...sheffield, id: "u-bristol", university_name: "University of Bristol" };
    const result = await resolveTargetedPrimary({ ...baseArgs, exactTargets: [sheffield, bristol] });
    assert.equal(result.fallbackReason, "not_single_target");
  });

  it("does not attempt without a validated Planner plan", async () => {
    const result = await resolveTargetedPrimary({ ...baseArgs, planner: plannerRun(null) });
    assert.equal(result.fallbackReason, "no_validated_plan");
  });

  it("does not attempt when the question is out of scope", async () => {
    const result = await resolveTargetedPrimary({ ...baseArgs, finalInScope: false });
    assert.equal(result.fallbackReason, "out_of_scope");
  });

  it("does not attempt when the canary rate is 0 (guaranteed miss)", async () => {
    const result = await resolveTargetedPrimary({ ...baseArgs, canaryRate: 0 });
    assert.equal(result.fallbackReason, "canary_miss");
  });
});
