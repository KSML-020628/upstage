import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeShadowParity } from "../app/lib/chat/shadow-parity.ts";
import type { ResultCard } from "../app/lib/chat/types.ts";
import type { TargetedQueryResult } from "../app/lib/chat/targeted-query.ts";

function card(overrides: Partial<ResultCard> & { university_id: string; university_name: string }): ResultCard {
  return {
    country: "", city: "", summary: "", badges: [], highlights: [], action_label: "", action_url: "",
    ...overrides,
  };
}

describe("computeShadowParity: a Targeted Query failure never throws and is reported, not hidden", () => {
  it("reports shadow_error when the targeted query is null (failed), without throwing", () => {
    const legacyCards = [card({ university_id: "u-1", university_name: "A" })];
    const parity = computeShadowParity({
      requestId: "r1", intent: "housing", legacyCards, targeted: null, targetedError: "network_down",
      legacyQueryMs: 10, targetedQueryMs: 5,
    });
    assert.equal(parity.parityStatus, "shadow_error");
    assert.deepEqual(parity.targetedErrors, ["network_down"]);
    assert.deepEqual(parity.missingFromTargeted, ["u-1"]);
  });
});

describe("computeShadowParity: ID set and order comparison", () => {
  it("reports exact when IDs and order match exactly", () => {
    const legacyCards = [card({ university_id: "u-1", university_name: "A" }), card({ university_id: "u-2", university_name: "B" })];
    const targeted: TargetedQueryResult = {
      universityIds: ["u-1", "u-2"],
      fetchedTables: ["housing_facts"],
      rowCountsByTable: { housing_facts: 2 },
      factBundles: [
        { universityId: "u-1", universityName: "A", facts: { housing_options: [{ source_url: "https://a" }] } },
        { universityId: "u-2", universityName: "B", facts: { housing_options: [{ source_url: "https://b" }] } },
      ],
      errors: [],
    };
    legacyCards[0].fact_bundle = [{ value: "x", source_url: "https://a" }];
    legacyCards[1].fact_bundle = [{ value: "y", source_url: "https://b" }];
    const parity = computeShadowParity({
      requestId: "r2", intent: "housing", legacyCards, targeted, legacyQueryMs: 10, targetedQueryMs: 8,
    });
    assert.equal(parity.parityStatus, "exact");
    assert.equal(parity.orderMatches, true);
    assert.deepEqual(parity.missingFromTargeted, []);
    assert.deepEqual(parity.extraInTargeted, []);
  });

  it("reports mismatch when the targeted query missed a university the legacy path found", () => {
    const legacyCards = [card({ university_id: "u-1", university_name: "A" }), card({ university_id: "u-2", university_name: "B" })];
    const targeted: TargetedQueryResult = {
      universityIds: ["u-1"],
      fetchedTables: ["housing_facts"],
      rowCountsByTable: { housing_facts: 1 },
      factBundles: [{ universityId: "u-1", universityName: "A", facts: {} }],
      errors: [],
    };
    const parity = computeShadowParity({
      requestId: "r3", intent: "housing", legacyCards, targeted, legacyQueryMs: 10, targetedQueryMs: 8,
    });
    assert.equal(parity.parityStatus, "mismatch");
    assert.deepEqual(parity.missingFromTargeted, ["u-2"]);
  });

  it("always reports conditionStateParity/unknownFieldParity as not_computed_by_targeted", () => {
    const parity = computeShadowParity({
      requestId: "r4", intent: "housing", legacyCards: [], targeted: null, legacyQueryMs: 1, targetedQueryMs: 1,
    });
    assert.equal(parity.conditionStateParity, "not_computed_by_targeted");
    assert.equal(parity.unknownFieldParity, "not_computed_by_targeted");
  });
});
