import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  attemptTargetedFastPath,
  canaryRollFor,
  stableCanaryBucket,
  TARGETED_PRIMARY_ALLOWED_INTENTS,
} from "../app/lib/chat/targeted-primary.ts";
import type { PlannerRun } from "../app/lib/chat/query-plan.ts";
import type { QueryPlan } from "../app/lib/chat/query-plan.ts";
import type { QueryConstraints } from "../app/lib/chat/types.ts";
import type { UniversityCatalogItem } from "../app/lib/chat/university-catalog.ts";

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

const catalog: UniversityCatalogItem[] = [
  { universityId: "u-sheffield", universityName: "University of Sheffield", aliases: [], country: "United Kingdom", region: "europe" },
  { universityId: "u-bristol", universityName: "University of Bristol", aliases: [], country: "United Kingdom", region: "europe" },
];

const baseArgs = {
  enabled: true,
  canaryRate: 1,
  canaryKey: "test-request-id",
  intent: "language" as const,
  catalogExactTargetIds: ["u-sheffield"],
  hasFollowupContext: false,
  planner: plannerRun(plan()),
  finalInScope: true,
  question: "University of Sheffield의 IELTS 조건을 알려줘.",
  constraints: constraints(),
  catalog,
};

describe("TARGETED_PRIMARY_ALLOWED_INTENTS: Phase 3B scope is single-university lookups only", () => {
  it("allows exactly general/language/housing/deadline, holding back cost/quota/restriction/source", () => {
    assert.deepEqual(
      [...TARGETED_PRIMARY_ALLOWED_INTENTS].sort(),
      ["deadline", "general", "housing", "language"].sort(),
    );
  });
});

describe("stableCanaryBucket / canaryRollFor: deterministic, not Math.random()-based", () => {
  it("returns the same bucket for the same key every time (no Math.random involved)", () => {
    const a = stableCanaryBucket("session-abc-123");
    const b = stableCanaryBucket("session-abc-123");
    assert.equal(a, b);
  });

  it("returns a bucket in [0, 10000)", () => {
    const bucket = stableCanaryBucket("some-key");
    assert.ok(bucket >= 0 && bucket < 10_000);
  });

  it("canaryRollFor is deterministic for a given key and rate -- same key never flips between calls", () => {
    const key = "session-xyz-789";
    const first = canaryRollFor(key, 0.5);
    for (let i = 0; i < 20; i += 1) {
      assert.equal(canaryRollFor(key, 0.5), first);
    }
  });

  it("rate 0 never selects any key, rate 1 always selects every key", () => {
    const keys = ["a", "b", "c", "session-1", "session-2", "req-abc"];
    for (const key of keys) {
      assert.equal(canaryRollFor(key, 0), false);
      assert.equal(canaryRollFor(key, 1), true);
    }
  });

  it("does not cluster sequential/near-identical keys onto one side (regression: djb2's raw hash put session-1..session-10 all on the same side of a 50% split before a finalizer was added)", () => {
    let selectedCount = 0;
    const total = 1000;
    for (let i = 0; i < total; i += 1) {
      if (canaryRollFor(`session-${i}`, 0.5)) selectedCount += 1;
    }
    // Not asserting an exact 50% -- just that it's a real split, not a
    // near-100/0 clustering from poor hash avalanche behavior.
    assert.ok(selectedCount > total * 0.35 && selectedCount < total * 0.65, `expected a roughly even split, got ${selectedCount}/${total}`);
  });

  it("different keys can land in different buckets (not all collapsed to one value)", () => {
    const buckets = new Set(["a", "b", "c", "d", "e", "f", "g", "h"].map((key) => stableCanaryBucket(key)));
    assert.ok(buckets.size > 1);
  });
});

describe("stableCanaryBucket: 10,000-session distribution (Phase 3B step 3 prod-canary-prep requirement)", () => {
  const SESSION_COUNT = 10_000;
  const sessions = Array.from({ length: SESSION_COUNT }, (_, i) => `prod-canary-prep-session-${i}`);

  function selectedFraction(rate: number): number {
    const selected = sessions.filter((key) => canaryRollFor(key, rate)).length;
    return selected / SESSION_COUNT;
  }

  it("rate 0 selects exactly 0% of 10,000 sessions", () => {
    assert.equal(selectedFraction(0), 0);
  });

  it("rate 0.01 selects approximately 1% (+/- 0.5 percentage points)", () => {
    const fraction = selectedFraction(0.01);
    assert.ok(Math.abs(fraction - 0.01) < 0.005, `expected ~1%, got ${(fraction * 100).toFixed(2)}%`);
  });

  it("rate 0.05 selects approximately 5% (+/- 1 percentage point)", () => {
    const fraction = selectedFraction(0.05);
    assert.ok(Math.abs(fraction - 0.05) < 0.01, `expected ~5%, got ${(fraction * 100).toFixed(2)}%`);
  });

  it("rate 0.1 selects approximately 10% (+/- 1.5 percentage points)", () => {
    const fraction = selectedFraction(0.1);
    assert.ok(Math.abs(fraction - 0.1) < 0.015, `expected ~10%, got ${(fraction * 100).toFixed(2)}%`);
  });

  it("rate 1 selects exactly 100% of 10,000 sessions", () => {
    assert.equal(selectedFraction(1), 1);
  });

  it("the same sessionId repeated 100 times always selects the same side", () => {
    const key = "prod-canary-prep-repeat-check";
    const first = canaryRollFor(key, 0.37);
    for (let i = 0; i < 100; i += 1) {
      assert.equal(canaryRollFor(key, 0.37), first, `flipped on repeat #${i}`);
    }
  });

  it("sequential sessionIds (10,000 of them) do not cluster into a narrow bucket range", () => {
    // Regression guard for the exact bug found and fixed in Phase 3B step
    // 2 (raw djb2 clustered session-1..session-10 onto one side) --
    // extended here to 10,000 sequential keys at a moderate rate, checking
    // the selected fraction is close to the configured rate rather than
    // collapsing toward 0% or 100%.
    const fraction = selectedFraction(0.1);
    assert.ok(fraction > 0.07 && fraction < 0.13, `expected ~10% even over 10,000 sequential keys, got ${(fraction * 100).toFixed(2)}%`);
  });
});

describe("attemptTargetedFastPath: eligibility gate never even attempts the Targeted path outside its scope", () => {
  it("does not attempt when the feature flag is disabled (defaults doubly safe)", async () => {
    const result = await attemptTargetedFastPath({ ...baseArgs, enabled: false });
    assert.equal(result.selectedPath, "legacy_default");
    assert.equal(result.fallbackReason, "flag_disabled");
    assert.equal(result.cards, null);
  });

  it("does not attempt for a held-back intent (e.g. cost recommendation)", async () => {
    const result = await attemptTargetedFastPath({ ...baseArgs, intent: "cost" });
    assert.equal(result.fallbackReason, "intent_not_eligible");
  });

  it("does not attempt when there is follow-up context (held back for a later expansion)", async () => {
    const result = await attemptTargetedFastPath({ ...baseArgs, hasFollowupContext: true });
    assert.equal(result.fallbackReason, "followup_not_eligible");
  });

  it("does not attempt for a recommendation query with zero named universities", async () => {
    const result = await attemptTargetedFastPath({ ...baseArgs, catalogExactTargetIds: [] });
    assert.equal(result.fallbackReason, "not_single_target");
  });

  it("does not attempt for a multi-university comparison (다수 대학 비교 및 랭킹 held back)", async () => {
    const result = await attemptTargetedFastPath({ ...baseArgs, catalogExactTargetIds: ["u-sheffield", "u-bristol"] });
    assert.equal(result.fallbackReason, "not_single_target");
  });

  it("does not attempt without a validated Planner plan", async () => {
    const result = await attemptTargetedFastPath({ ...baseArgs, planner: plannerRun(null) });
    assert.equal(result.fallbackReason, "no_validated_plan");
  });

  it("does not attempt when the question is out of scope", async () => {
    const result = await attemptTargetedFastPath({ ...baseArgs, finalInScope: false });
    assert.equal(result.fallbackReason, "out_of_scope");
  });

  it("does not attempt when the canary rate is 0 (guaranteed miss, deterministically) -- but this IS eligible, unlike the structural exclusions above", async () => {
    const result = await attemptTargetedFastPath({ ...baseArgs, canaryRate: 0 });
    assert.equal(result.fallbackReason, "canary_miss");
    assert.equal(result.targetedEligible, true);
    assert.equal(result.canarySelected, false);
  });

  it("every structural exclusion (not canary_miss) reports targetedEligible: false, canarySelected: false", async () => {
    const structuralExclusions: Array<Partial<Parameters<typeof attemptTargetedFastPath>[0]>> = [
      { enabled: false },
      { intent: "cost" },
      { hasFollowupContext: true },
      { catalogExactTargetIds: [] },
      { planner: plannerRun(null) },
      { finalInScope: false },
      { canaryKey: null },
    ];
    for (const override of structuralExclusions) {
      const result = await attemptTargetedFastPath({ ...baseArgs, ...override });
      assert.equal(result.targetedEligible, false, `expected targetedEligible: false for ${JSON.stringify(override)}`);
      assert.equal(result.canarySelected, false, `expected canarySelected: false for ${JSON.stringify(override)}`);
      assert.equal(result.targetedQueryMs, 0);
    }
  });

  it("does not attempt when there is no stable canary key (canaryKey: null) -- excluded from canary, never rolled per-request", async () => {
    const result = await attemptTargetedFastPath({ ...baseArgs, canaryKey: null });
    assert.equal(result.selectedPath, "legacy_default");
    assert.equal(result.fallbackReason, "no_stable_canary_key");
    assert.equal(result.targetedAttempted, false);
    assert.equal(result.targetedSucceeded, false);
  });

  it("every not-attempted result reports targetedAttempted: false, targetedSucceeded: false", async () => {
    const result = await attemptTargetedFastPath({ ...baseArgs, enabled: false });
    assert.equal(result.targetedAttempted, false);
    assert.equal(result.targetedSucceeded, false);
  });
});
