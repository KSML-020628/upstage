// Phase 3A (shadow-only): a finer-grained clarification model than the
// single boolean needsTargetClarification (responses.ts) currently returns.
// This is a NEW, standalone, unit-tested module -- it is NOT wired into
// app/api/chat/route.ts's real response path in this phase (doing so would
// be a primary-path behavior change, out of Phase 3A's scope). It exists so
// the Targeted Query Builder's shadow run has a correct three-way signal to
// log against, and as a validated design for Phase 3B to wire in.
export type ClarificationState = {
  targetNeeded: boolean;
  fieldNeeded: boolean;
  conditionNeeded: boolean;
  reason?: string;
};

// A question is "topic-less" when it's little more than a bare reference +
// a question particle/ending, with no other content word -- e.g. "셰필드는?"
// or "그 대학은 어때?" ("what about Sheffield?"/"how about that university?").
// The 10-character cap on the leading segment is what keeps this from also
// matching a real request like "셰필드 대학교 정보 알려줘" ("tell me about
// Sheffield university"), which is longer and carries actual content past
// the reference itself, even though its intent is also "general".
const TOPIC_LESS_PATTERN = /^.{1,10}(는|은|이|가)\s*(뭐야|뭐지|어때|어떄)?\s*\??$/;

export function resolveClarificationState(args: {
  exactTargetCount: number;
  hasValidFollowupContext: boolean;
  intent: string;
  requestedFields: string[];
  hasActionableConditions: boolean;
  question: string;
}): ClarificationState {
  const normalized = args.question.normalize("NFKC").trim();

  // Target clarification: no exact university resolved AND no valid prior
  // context to fall back on (a follow-up like "그 대학은?" needs an actual
  // resolved previous target, not just the phrase itself).
  const targetNeeded = args.exactTargetCount === 0 && !args.hasValidFollowupContext;
  if (targetNeeded) {
    return { targetNeeded: true, fieldNeeded: false, conditionNeeded: false, reason: "no_target_resolved" };
  }

  // Field clarification: a target IS resolved, but the question carries no
  // topic at all. detectIntent (constraints.ts) only ever falls back to
  // "general" when NONE of its keyword patterns matched -- every other
  // intent (language/housing/cost/deadline/quota/restriction/source) is
  // real, keyword-grounded evidence of an actual topic. "셰필드는?" lands
  // here (intent stays "general", nothing else grounds it); "셰필드 기숙사"
  // does not (intent = housing).
  const hasTopic = args.intent !== "general" || args.requestedFields.length > 0;
  const looksTopicLess = !hasTopic && TOPIC_LESS_PATTERN.test(normalized);
  if (looksTopicLess) {
    return { targetNeeded: false, fieldNeeded: true, conditionNeeded: false, reason: "target_resolved_no_topic" };
  }

  // Condition clarification: reserved for a future case (e.g. a
  // recommendation-style intent with a target already resolved but zero
  // actionable filter at all) -- included in the type per the requested
  // shape, but not yet given an independent trigger distinct from the
  // existing hasActionableSearchConditions-driven target-clarification
  // logic in responses.ts, to avoid inventing an untested new gate.
  return { targetNeeded: false, fieldNeeded: false, conditionNeeded: false };
}
