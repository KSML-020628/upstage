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

function targetedResult(overrides: Partial<TargetedQueryResult> = {}): TargetedQueryResult {
  return {
    universityIds: [],
    candidateSource: "provided_target_ids",
    fetchedTables: [],
    queryCount: 0,
    rowCountsByTable: {},
    factBundles: [],
    unsupportedFields: [],
    errors: [],
    ...overrides,
  };
}

describe("computeShadowParity: a Targeted Query failure never throws and is reported, not hidden", () => {
  it("reports shadow_error when the targeted query is null (failed), without throwing", () => {
    const legacyCards = [card({ university_id: "u-1", university_name: "A" })];
    const parity = computeShadowParity({
      requestId: "r1", intent: "housing", legacyCards, targetedCards: [], targeted: null, targetedError: "network_down",
      legacyQueryMs: 10, legacyTotalFactRows: 5, targetedQueryMs: 5,
    });
    assert.equal(parity.parityStatus, "shadow_error");
    assert.deepEqual(parity.targetedErrors, ["network_down"]);
    assert.deepEqual(parity.missingFromTargeted, ["u-1"]);
  });
});

describe("computeShadowParity: common-evaluator comparison (both sides run the same selectCards/selectClassifiedCards)", () => {
  it("reports exact when IDs, order, and every compared field match", () => {
    const legacyCards = [
      card({ university_id: "u-1", university_name: "A", fact_bundle: [{ field_key: "housing_options", value: "guaranteed" }], condition_checks: [{ key: "housing_guaranteed", label: "배정 보장", state: "met", detail: "보장" }] }),
      card({ university_id: "u-2", university_name: "B", fact_bundle: [{ field_key: "housing_options", value: "guaranteed" }], condition_checks: [{ key: "housing_guaranteed", label: "배정 보장", state: "met", detail: "보장" }] }),
    ];
    const targetedCards = legacyCards.map((c) => ({ ...c }));
    const targeted = targetedResult({ universityIds: ["u-1", "u-2"], fetchedTables: ["housing_facts"], rowCountsByTable: { housing_facts: 2 } });
    const parity = computeShadowParity({
      requestId: "r2", intent: "housing", legacyCards, targetedCards, targeted, legacyQueryMs: 10, legacyTotalFactRows: 100, targetedQueryMs: 8,
    });
    assert.equal(parity.parityStatus, "exact");
    assert.equal(parity.orderMatches, true);
    assert.equal(parity.conditionStateParity, "exact");
    assert.deepEqual(parity.missingFromTargeted, []);
    assert.deepEqual(parity.extraInTargeted, []);
  });

  it("reports mismatch when the targeted query missed a university the legacy path found", () => {
    const legacyCards = [card({ university_id: "u-1", university_name: "A" }), card({ university_id: "u-2", university_name: "B" })];
    const targetedCards = [card({ university_id: "u-1", university_name: "A" })];
    const targeted = targetedResult({ universityIds: ["u-1"], fetchedTables: ["housing_facts"], rowCountsByTable: { housing_facts: 1 } });
    const parity = computeShadowParity({
      requestId: "r3", intent: "housing", legacyCards, targetedCards, targeted, legacyQueryMs: 10, legacyTotalFactRows: 50, targetedQueryMs: 8,
    });
    assert.equal(parity.parityStatus, "mismatch");
    assert.deepEqual(parity.missingFromTargeted, ["u-2"]);
  });

  it("reports equivalent when the ID set matches but order differs and all fields still match", () => {
    const legacyCards = [
      card({ university_id: "u-1", university_name: "A", condition_checks: [] }),
      card({ university_id: "u-2", university_name: "B", condition_checks: [] }),
    ];
    const targetedCards = [
      card({ university_id: "u-2", university_name: "B", condition_checks: [] }),
      card({ university_id: "u-1", university_name: "A", condition_checks: [] }),
    ];
    const targeted = targetedResult({ universityIds: ["u-2", "u-1"] });
    const parity = computeShadowParity({
      requestId: "r4", intent: "housing", legacyCards, targetedCards, targeted, legacyQueryMs: 10, legacyTotalFactRows: 10, targetedQueryMs: 8,
    });
    assert.equal(parity.orderMatches, false);
    assert.equal(parity.parityStatus, "equivalent");
  });

  it("detects a real condition_checks divergence (e.g. targeted data disagrees on match_status)", () => {
    const legacyCards = [card({ university_id: "u-1", university_name: "A", condition_checks: [{ key: "housing_guaranteed", label: "배정 보장", state: "met", detail: "보장" }] })];
    const targetedCards = [card({ university_id: "u-1", university_name: "A", condition_checks: [{ key: "housing_guaranteed", label: "배정 보장", state: "unknown", detail: "확인 필요" }] })];
    const targeted = targetedResult({ universityIds: ["u-1"] });
    const parity = computeShadowParity({
      requestId: "r5", intent: "housing", legacyCards, targetedCards, targeted, legacyQueryMs: 10, legacyTotalFactRows: 10, targetedQueryMs: 8,
    });
    assert.equal(parity.conditionStateParity, "partial_mismatch");
    assert.equal(parity.parityStatus, "mismatch");
  });

  it("reports exact_with_legacy_fallback (not plain exact) when the request's unsupportedFields required legacy fallback, and logs which fields", () => {
    const legacyCards = [card({ university_id: "u-1", university_name: "A" })];
    const targetedCards = legacyCards.map((c) => ({ ...c }));
    // source_links has no dedicated fact table -- the caller (route.ts)
    // borrows it from the legacy University and reports it via
    // unsupportedFields, same as course_restrictions.
    const targeted = targetedResult({ universityIds: ["u-1"], unsupportedFields: ["source_links"] });
    const parity = computeShadowParity({
      requestId: "r6", intent: "source", legacyCards, targetedCards, targeted, legacyQueryMs: 10, legacyTotalFactRows: 10, targetedQueryMs: 8,
    });
    assert.equal(parity.parityStatus, "exact_with_legacy_fallback");
    assert.ok(parity.legacyFallbackFields.includes("source_links"));
    // profile_sections is always borrowed unconditionally by
    // hydrateUniversitiesFromCatalog whenever any candidate was hydrated,
    // so it's logged here too even though it alone wouldn't flip the status.
    assert.ok(parity.legacyFallbackFields.includes("profile_sections"));
  });

  it("reports plain exact (no legacy fallback) when the request needed no unsupported fields", () => {
    const legacyCards = [card({ university_id: "u-1", university_name: "A" })];
    const targetedCards = legacyCards.map((c) => ({ ...c }));
    const targeted = targetedResult({ universityIds: ["u-1"] });
    const parity = computeShadowParity({
      requestId: "r7", intent: "housing", legacyCards, targetedCards, targeted, legacyQueryMs: 10, legacyTotalFactRows: 10, targetedQueryMs: 8,
    });
    assert.equal(parity.parityStatus, "exact");
    // profile_sections is still logged (always borrowed), just doesn't
    // change the status since it isn't a field this request explicitly asked
    // for.
    assert.deepEqual(parity.legacyFallbackFields, ["profile_sections"]);
  });
});
