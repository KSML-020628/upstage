import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hasActionableSearchConditions } from "../app/lib/chat/search-conditions.ts";
import { detectConstraints } from "../app/lib/chat/constraints.ts";

describe("hasActionableSearchConditions: q4's exact case", () => {
  it("is true for q4 even when the Planner's own hardFilters would be empty", () => {
    // This is the whole point of the fix: hasActionableSearchConditions
    // looks at the FINAL merged constraints (which already has excludeAsia
    // and a deadline comparator from the regex side), not just what the
    // Planner itself contributed -- so even a run where Solar drops
    // hardFilters entirely doesn't wrongly ask "which university?".
    const constraints = detectConstraints("아시아 빼고 2026-05-01 이후 마감인 대학");
    assert.equal(constraints.excludeAsia, true);
    assert.equal(constraints.deadlineComparator, "gt");
    assert.equal(constraints.deadlineDate, "2026-05-01");
    assert.equal(hasActionableSearchConditions(constraints), true);
  });

  it("is false for a question with no actionable condition at all", () => {
    const constraints = detectConstraints("교환학생 프로그램이 뭐야?");
    assert.equal(hasActionableSearchConditions(constraints), false);
  });

  it("is true from a deadline date/comparator alone, which hasRecommendationConditions doesn't cover", () => {
    const constraints = detectConstraints("2026-05-01 이후 마감인 대학 알려줘");
    assert.equal(constraints.deadlineComparator, "gt");
    assert.equal(hasActionableSearchConditions(constraints), true);
  });
});
