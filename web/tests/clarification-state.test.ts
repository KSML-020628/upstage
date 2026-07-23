import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveClarificationState } from "../app/lib/chat/clarification-state.ts";

describe("resolveClarificationState: the 3 requested cases", () => {
  it('"셰필드 기숙사" -> target 명확, field 명확, 정상 조회', () => {
    const state = resolveClarificationState({
      exactTargetCount: 1,
      hasValidFollowupContext: false,
      intent: "housing",
      requestedFields: ["housing_options"],
      hasActionableConditions: false,
      question: "셰필드 기숙사",
    });
    assert.equal(state.targetNeeded, false);
    assert.equal(state.fieldNeeded, false);
  });

  it('"셰필드는?" -> target 명확, field 불명확 (field clarification 가능)', () => {
    const state = resolveClarificationState({
      exactTargetCount: 1,
      hasValidFollowupContext: false,
      intent: "general",
      requestedFields: [],
      hasActionableConditions: false,
      question: "셰필드는?",
    });
    assert.equal(state.targetNeeded, false);
    assert.equal(state.fieldNeeded, true);
    assert.equal(state.reason, "target_resolved_no_topic");
  });

  it('"그 대학은?" with no valid prior context -> target clarification', () => {
    const state = resolveClarificationState({
      exactTargetCount: 0,
      hasValidFollowupContext: false,
      intent: "general",
      requestedFields: [],
      hasActionableConditions: false,
      question: "그 대학은?",
    });
    assert.equal(state.targetNeeded, true);
    assert.equal(state.fieldNeeded, false);
  });
});

describe("resolveClarificationState: does not regress a longer, genuinely general request", () => {
  it('"셰필드 대학교 정보 알려줘" (longer, real content) does not trigger field clarification', () => {
    const state = resolveClarificationState({
      exactTargetCount: 1,
      hasValidFollowupContext: false,
      intent: "general",
      requestedFields: [],
      hasActionableConditions: false,
      question: "셰필드 대학교 정보 알려줘",
    });
    assert.equal(state.fieldNeeded, false);
  });
});

describe("resolveClarificationState: target resolution takes priority over field ambiguity", () => {
  it("does not raise field clarification when target itself is unresolved", () => {
    const state = resolveClarificationState({
      exactTargetCount: 0,
      hasValidFollowupContext: false,
      intent: "general",
      requestedFields: [],
      hasActionableConditions: false,
      question: "그 대학은 어때?",
    });
    assert.equal(state.targetNeeded, true);
    assert.equal(state.fieldNeeded, false);
  });

  it("a valid follow-up context resolves target even with exactTargetCount 0", () => {
    const state = resolveClarificationState({
      exactTargetCount: 0,
      hasValidFollowupContext: true,
      intent: "housing",
      requestedFields: ["housing_options"],
      hasActionableConditions: false,
      question: "거기 기숙사는?",
    });
    assert.equal(state.targetNeeded, false);
  });
});
