import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateReasonerOutput } from "../app/lib/chat/reasoner.ts";
import { attachRecommendationExplanations, composeShortAnswer } from "../app/lib/chat/short-answer.ts";
import type { EvidencePacket } from "../app/lib/chat/evidence-packet.ts";
import type { ResultCard } from "../app/lib/chat/types.ts";

function packet(universities: EvidencePacket["universities"], question = "IELTS 6.0으로 지원 가능한 유럽 대학을 추천해줘"): EvidencePacket {
  return { question, queryPlan: null, universities, unknownFields: [] };
}

// University A has TWO language facts (IELTS and TOEFL) with DIFFERENT
// numbers, so a recommendation that cites one but states the other's number
// is a same-university, cross-field crossover -- exactly the case the old
// packet-wide/university-wide grounding could not catch.
const matchedA = {
  universityId: "u-a",
  universityName: "University A",
  country: "United Kingdom",
  city: "A City",
  verdict: "matched" as const,
  conditionSummary: ["어학 조건: met (IELTS 최소 6.5 필요, 보유 6.5)"],
  unresolvedConditionKeys: [] as string[],
  facts: [
    { factId: "fact-a-ielts", universityId: "u-a", fieldKey: "language_requirements", displayValue: "IELTS 6.5 minimum" },
    { factId: "fact-a-toefl", universityId: "u-a", fieldKey: "language_requirements", displayValue: "TOEFL iBT 88 minimum" },
  ],
};

// University B's housing guarantee is unknown (unresolvedConditionKeys),
// but it also has an unrelated cost fact -- used to test that a caution
// citation about the WRONG topic can't be used to bypass the unknown-upgrade
// guard.
const partialB = {
  universityId: "u-b",
  universityName: "University B",
  country: "Sweden",
  city: "B City",
  verdict: "partial" as const,
  conditionSummary: ["배정 보장: unknown (확인 필요)"],
  unresolvedConditionKeys: ["housing_guaranteed"],
  facts: [
    { factId: "fact-b-housing", universityId: "u-b", fieldKey: "housing_facts", displayValue: "housing application available" },
    { factId: "fact-b-cost", universityId: "u-b", fieldKey: "cost_facts", displayValue: "tuition 5000 EUR per semester" },
  ],
};

describe("validateReasonerOutput: per-recommendation fact-ID grounding", () => {
  it("accepts a number that belongs to the specific fact the recommendation cited", () => {
    const result = validateReasonerOutput(
      {
        shortAnswer: "University A는 IELTS 6.5를 요구합니다.",
        recommendations: [
          { universityId: "u-a", reasonFactIds: ["fact-a-ielts"], cautionFactIds: [], explanation: "IELTS 6.5 이상을 요구합니다." },
        ],
        unknownFields: [],
        suggestedDetailTab: "summary",
      },
      packet([matchedA]),
    );
    assert.equal(result.output?.recommendations.length, 1);
  });

  it("rejects a same-university, cross-field crossover: citing the IELTS fact but stating the TOEFL fact's number", () => {
    // Only "fact-a-ielts" (6.5) is cited -- "88" belongs to "fact-a-toefl",
    // which was never cited by this recommendation, even though it's a real
    // number for this same university.
    const result = validateReasonerOutput(
      {
        shortAnswer: "요약",
        recommendations: [
          { universityId: "u-a", reasonFactIds: ["fact-a-ielts"], cautionFactIds: [], explanation: "TOEFL 88 이상을 요구합니다." },
        ],
        unknownFields: [],
        suggestedDetailTab: "summary",
      },
      packet([matchedA]),
    );
    assert.equal(result.output?.recommendations.length ?? 0, 0);
    assert.ok(result.issues.includes("unsafe_explanation:u-a"));
  });

  it("accepts both numbers when both facts are actually cited together", () => {
    const result = validateReasonerOutput(
      {
        shortAnswer: "요약",
        recommendations: [
          {
            universityId: "u-a",
            reasonFactIds: ["fact-a-ielts", "fact-a-toefl"],
            cautionFactIds: [],
            explanation: "IELTS 6.5 또는 TOEFL 88 중 하나를 충족하면 됩니다.",
          },
        ],
        unknownFields: [],
        suggestedDetailTab: "summary",
      },
      packet([matchedA]),
    );
    assert.equal(result.output?.recommendations.length, 1);
  });

  it("rejects the student's own question number standing in for the university's different official requirement", () => {
    // The student asked about IELTS 6.0. This university's own cited fact
    // requires 6.5. An explanation that reports "6.0" as this university's
    // requirement is fabricating the university's number from the student's
    // query constraint instead of its own fact.
    const result = validateReasonerOutput(
      {
        shortAnswer: "요약",
        recommendations: [
          { universityId: "u-a", reasonFactIds: ["fact-a-ielts"], cautionFactIds: [], explanation: "이 대학은 IELTS 6.0 이상이면 지원 가능합니다." },
        ],
        unknownFields: [],
        suggestedDetailTab: "summary",
      },
      packet([matchedA], "IELTS 6.0으로 지원 가능한 유럽 대학을 추천해줘"),
    );
    assert.equal(result.output?.recommendations.length ?? 0, 0);
    assert.ok(result.issues.includes("unsafe_explanation:u-a"));
  });

  it("accepts the university's own correct number even when it differs from what the student asked", () => {
    const result = validateReasonerOutput(
      {
        shortAnswer: "요약",
        recommendations: [
          { universityId: "u-a", reasonFactIds: ["fact-a-ielts"], cautionFactIds: [], explanation: "이 대학은 IELTS 6.5 이상을 요구합니다." },
        ],
        unknownFields: [],
        suggestedDetailTab: "summary",
      },
      packet([matchedA], "IELTS 6.0으로 지원 가능한 유럽 대학을 추천해줘"),
    );
    assert.equal(result.output?.recommendations.length, 1);
  });
});

describe("validateReasonerOutput: unknown-state upgrade guard (topic-relevant caution)", () => {
  it("drops a recommendation for a partial-verdict university with zero caution citations", () => {
    const result = validateReasonerOutput(
      {
        shortAnswer: "요약",
        recommendations: [
          { universityId: "u-b", reasonFactIds: ["fact-b-housing"], cautionFactIds: [], explanation: "기숙사 신청이 가능합니다." },
        ],
        unknownFields: [],
        suggestedDetailTab: "summary",
      },
      packet([partialB]),
    );
    assert.equal(result.output?.recommendations.length ?? 0, 0);
    assert.ok(result.issues.includes("unknown_upgraded_to_positive:u-b"));
  });

  it("drops a recommendation whose caution citation is about an unrelated topic (irrelevant-caution bypass)", () => {
    // housing_guaranteed is unknown, but the caution cited is the cost fact
    // -- unrelated to housing -- while the explanation asserts the housing
    // guarantee is effectively confirmed. A non-empty cautionFactIds must
    // not be enough on its own to pass.
    const result = validateReasonerOutput(
      {
        shortAnswer: "요약",
        recommendations: [
          {
            universityId: "u-b",
            reasonFactIds: ["fact-b-housing"],
            cautionFactIds: ["fact-b-cost"],
            explanation: "기숙사 배정은 사실상 보장됩니다.",
          },
        ],
        unknownFields: [],
        suggestedDetailTab: "summary",
      },
      packet([partialB]),
    );
    assert.equal(result.output?.recommendations.length ?? 0, 0);
    assert.ok(result.issues.includes("unknown_upgraded_to_positive:u-b"));
  });

  it("keeps a partial-verdict recommendation whose caution citation is actually about the unresolved topic", () => {
    const result = validateReasonerOutput(
      {
        shortAnswer: "요약",
        recommendations: [
          {
            universityId: "u-b",
            reasonFactIds: ["fact-b-housing"],
            cautionFactIds: ["fact-b-housing"],
            explanation: "기숙사 신청은 가능하나 배정 보장 여부는 확인이 필요합니다.",
          },
        ],
        unknownFields: [],
        suggestedDetailTab: "summary",
      },
      packet([partialB]),
    );
    assert.equal(result.output?.recommendations.length, 1);
  });

  it("does not require a caution citation for a fully matched university", () => {
    const result = validateReasonerOutput(
      {
        shortAnswer: "요약",
        recommendations: [
          { universityId: "u-a", reasonFactIds: ["fact-a-ielts"], cautionFactIds: [], explanation: "IELTS 6.5 이상을 요구합니다." },
        ],
        unknownFields: [],
        suggestedDetailTab: "summary",
      },
      packet([matchedA]),
    );
    assert.equal(result.output?.recommendations.length, 1);
  });
});

describe("validateReasonerOutput: partial fallback (narrative vs recommendations independence)", () => {
  it("keeps valid per-university recommendations even when the top-level shortAnswer is ungrounded", () => {
    const result = validateReasonerOutput(
      {
        shortAnswer: "University A는 IELTS 9.9를 요구합니다.", // 9.9 appears nowhere in the packet or question
        recommendations: [
          { universityId: "u-a", reasonFactIds: ["fact-a-ielts"], cautionFactIds: [], explanation: "IELTS 6.5 이상을 요구합니다." },
        ],
        unknownFields: [],
        suggestedDetailTab: "summary",
      },
      packet([matchedA]),
    );
    assert.equal(result.output?.shortAnswer, "");
    assert.ok(result.issues.includes("unsafe_short_answer"));
    assert.equal(result.output?.recommendations.length, 1);
  });

  it("keeps a valid shortAnswer even when every recommendation is rejected", () => {
    const result = validateReasonerOutput(
      {
        shortAnswer: "University A는 IELTS 6.5를 요구합니다.",
        recommendations: [
          { universityId: "u-b", reasonFactIds: ["fact-b-housing"], cautionFactIds: [], explanation: "기숙사가 보장됩니다." },
        ],
        unknownFields: [],
        suggestedDetailTab: "summary",
      },
      packet([matchedA, partialB]),
    );
    assert.equal(result.output?.shortAnswer, "University A는 IELTS 6.5를 요구합니다.");
    assert.equal(result.output?.recommendations.length ?? 0, 0);
  });

  it("returns null output only when both the narrative and every recommendation fail", () => {
    const result = validateReasonerOutput(
      {
        shortAnswer: "",
        recommendations: [
          { universityId: "u-b", reasonFactIds: ["fact-b-housing"], cautionFactIds: [], explanation: "기숙사가 보장됩니다." },
        ],
        unknownFields: [],
        suggestedDetailTab: "summary",
      },
      packet([partialB]),
    );
    assert.equal(result.output, null);
  });
});

describe("validateReasonerOutput: recommendation stats", () => {
  it("reports generated/accepted/rejected counts for a mix of good and bad recommendations", () => {
    const matchedC = {
      universityId: "u-c",
      universityName: "University C",
      country: "Germany",
      city: "C City",
      verdict: "matched" as const,
      conditionSummary: [],
      unresolvedConditionKeys: [] as string[],
      facts: [{ factId: "fact-c-1", universityId: "u-c", fieldKey: "language_requirements", displayValue: "IELTS 6.0 minimum" }],
    };
    const result = validateReasonerOutput(
      {
        shortAnswer: "요약",
        recommendations: [
          { universityId: "u-a", reasonFactIds: ["fact-a-ielts"], cautionFactIds: [], explanation: "IELTS 6.5 이상을 요구합니다." }, // accepted
          { universityId: "u-b", reasonFactIds: ["fact-b-housing"], cautionFactIds: [], explanation: "기숙사가 보장됩니다." }, // rejected: unknown-upgrade
          { universityId: "u-c", reasonFactIds: ["fact-c-1"], cautionFactIds: [], explanation: "TOEFL 88 이상을 요구합니다." }, // rejected: ungrounded number
        ],
        unknownFields: [],
        suggestedDetailTab: "summary",
      },
      packet([matchedA, partialB, matchedC]),
    );
    assert.deepEqual(result.recommendationStats, { generated: 3, accepted: 1, rejected: 2 });
    assert.equal(result.output?.recommendations.length, 1);
  });
});

function card(overrides: Partial<ResultCard> & { university_id: string; university_name: string }): ResultCard {
  return {
    country: "",
    city: "",
    summary: "",
    badges: [],
    highlights: [],
    action_label: "",
    action_url: "",
    ...overrides,
  };
}

describe("attachRecommendationExplanations: cards never disappear on partial reasoner failure", () => {
  it("keeps all 3 cards when 2 of 3 recommendations were rejected, with only the surviving one attached", () => {
    const cards = [
      card({ university_id: "u-a", university_name: "University A" }),
      card({ university_id: "u-b", university_name: "University B" }),
      card({ university_id: "u-c", university_name: "University C" }),
    ];
    const matchedC = {
      universityId: "u-c",
      universityName: "University C",
      country: "Germany",
      city: "C City",
      verdict: "matched" as const,
      conditionSummary: [],
      unresolvedConditionKeys: [] as string[],
      facts: [{ factId: "fact-c-1", universityId: "u-c", fieldKey: "language_requirements", displayValue: "IELTS 6.0 minimum" }],
    };
    const validated = validateReasonerOutput(
      {
        shortAnswer: "요약",
        recommendations: [
          { universityId: "u-a", reasonFactIds: ["fact-a-ielts"], cautionFactIds: [], explanation: "IELTS 6.5 이상을 요구합니다." }, // accepted
          { universityId: "u-b", reasonFactIds: ["fact-b-housing"], cautionFactIds: [], explanation: "기숙사가 보장됩니다." }, // rejected
          { universityId: "u-c", reasonFactIds: ["fact-c-1"], cautionFactIds: [], explanation: "TOEFL 88 이상을 요구합니다." }, // rejected
        ],
        unknownFields: [],
        suggestedDetailTab: "summary",
      },
      packet([matchedA, partialB, matchedC]),
    );
    assert.equal(validated.recommendationStats.rejected, 2);

    const attached = attachRecommendationExplanations(cards, validated.output?.recommendations ?? []);
    assert.equal(attached.length, 3, "no card should disappear");
    assert.equal(attached.find((c) => c.university_id === "u-a")?.ai_explanation, "IELTS 6.5 이상을 요구합니다.");
    assert.equal(attached.find((c) => c.university_id === "u-b")?.ai_explanation, undefined);
    assert.equal(attached.find((c) => c.university_id === "u-c")?.ai_explanation, undefined);
    // Rejected cards fall back to their original server-only data untouched.
    assert.equal(attached.find((c) => c.university_id === "u-b")?.university_name, "University B");
    assert.equal(attached.find((c) => c.university_id === "u-c")?.university_name, "University C");
  });
});

describe("composeShortAnswer", () => {
  it("never lets Solar's narrative name a partially-matched university", () => {
    const cards = [
      card({ university_id: "u-a", university_name: "University A", match_status: "matched" }),
      card({ university_id: "u-b", university_name: "University B", match_status: "partial" }),
    ];
    const { shortAnswer, source } = composeShortAnswer({
      cards,
      narrative: "University B(스웨덴)도 좋은 선택지입니다.",
      deterministicShortAnswer: "fallback",
    });
    assert.equal(source, "authoritative_template");
    assert.ok(!shortAnswer.includes("University B"));
  });

  it("combines the factual header with the narrative when there are no partial matches", () => {
    const cards = [card({ university_id: "u-a", university_name: "University A", match_status: "matched" })];
    const { shortAnswer, source } = composeShortAnswer({
      cards,
      narrative: "University A는 훌륭한 선택입니다.",
      deterministicShortAnswer: "fallback",
    });
    assert.equal(source, "server_plus_solar");
    assert.ok(shortAnswer.includes("University A는 훌륭한 선택입니다."));
  });

  it("always prefers an explicit override regardless of cards or narrative", () => {
    const cards = [card({ university_id: "u-a", university_name: "University A", match_status: "partial" })];
    const { shortAnswer, source } = composeShortAnswer({
      cards,
      narrative: "narrative text",
      shortAnswerOverride: "override text",
      deterministicShortAnswer: "fallback",
    });
    assert.equal(source, "override");
    assert.equal(shortAnswer, "override text");
  });

  it("falls back to the deterministic template when there's no header and no narrative", () => {
    const cards = [card({ university_id: "u-a", university_name: "University A" })];
    const { shortAnswer, source } = composeShortAnswer({ cards, narrative: "", deterministicShortAnswer: "fallback" });
    assert.equal(source, "deterministic_fallback");
    assert.equal(shortAnswer, "fallback");
  });
});
