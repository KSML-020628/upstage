import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateReasonerOutput } from "../app/lib/chat/reasoner.ts";
import { composeShortAnswer } from "../app/lib/chat/short-answer.ts";
import type { EvidencePacket } from "../app/lib/chat/evidence-packet.ts";
import type { ResultCard } from "../app/lib/chat/types.ts";

function packet(universities: EvidencePacket["universities"], question = "IELTS 6.0으로 지원 가능한 유럽 대학을 추천해줘"): EvidencePacket {
  return { question, queryPlan: null, universities, unknownFields: [] };
}

const matchedA = {
  universityId: "u-a",
  universityName: "University A",
  country: "United Kingdom",
  city: "A City",
  verdict: "matched" as const,
  conditionSummary: ["어학 조건: met (IELTS 최소 6.0 필요, 보유 6.5)"],
  facts: [{ factId: "fact-a-1", universityId: "u-a", fieldKey: "language", displayValue: "IELTS 6.0 minimum" }],
};

const partialB = {
  universityId: "u-b",
  universityName: "University B",
  country: "Sweden",
  city: "B City",
  verdict: "partial" as const,
  conditionSummary: ["기숙사: unknown (배정 여부 확인 필요)"],
  facts: [{ factId: "fact-b-1", universityId: "u-b", fieldKey: "housing", displayValue: "housing application available" }],
};

describe("validateReasonerOutput: per-university number grounding", () => {
  it("accepts a number that actually belongs to the cited university's own facts", () => {
    const result = validateReasonerOutput(
      {
        shortAnswer: "University A는 IELTS 6.0을 요구합니다.",
        recommendations: [
          { universityId: "u-a", reasonFactIds: ["fact-a-1"], cautionFactIds: [], explanation: "IELTS 6.0 이상을 요구합니다." },
        ],
        unknownFields: [],
        suggestedDetailTab: "summary",
      },
      packet([matchedA]),
    );
    assert.equal(result.output?.recommendations.length, 1);
    assert.equal(result.output?.recommendations[0].explanation, "IELTS 6.0 이상을 요구합니다.");
  });

  it("rejects a number from a DIFFERENT university's facts bleeding into this recommendation", () => {
    // "6.5" only exists in University A's own facts (its student's held
    // score), never in University B's. An explanation attributed to B that
    // cites it is fabricating a number for B, even though the number is
    // "real" somewhere in the same evidence packet.
    const result = validateReasonerOutput(
      {
        shortAnswer: "University A는 IELTS 6.0을 요구합니다.",
        recommendations: [
          { universityId: "u-b", reasonFactIds: ["fact-b-1"], cautionFactIds: ["fact-b-1"], explanation: "University B는 IELTS 6.5를 요구합니다." },
        ],
        unknownFields: [],
        suggestedDetailTab: "summary",
      },
      packet([matchedA, partialB]),
    );
    assert.equal(result.output?.recommendations.length ?? 0, 0);
    assert.ok(result.issues.some((issue) => issue.startsWith("unsafe_explanation:u-b")));
  });

  it("still allows a number the student themselves stated in the question, for any university", () => {
    const result = validateReasonerOutput(
      {
        shortAnswer: "요약",
        recommendations: [
          { universityId: "u-b", reasonFactIds: ["fact-b-1"], cautionFactIds: ["fact-b-1"], explanation: "IELTS 6.0 기준으로 지원 가능합니다." },
        ],
        unknownFields: [],
        suggestedDetailTab: "summary",
      },
      packet([partialB], "IELTS 6.0으로 지원 가능한 유럽 대학을 추천해줘"),
    );
    assert.equal(result.output?.recommendations.length, 1);
  });
});

describe("validateReasonerOutput: unknown-state upgrade guard", () => {
  it("drops a recommendation for a partial-verdict university with zero caution citations", () => {
    const result = validateReasonerOutput(
      {
        shortAnswer: "요약",
        recommendations: [
          { universityId: "u-b", reasonFactIds: ["fact-b-1"], cautionFactIds: [], explanation: "기숙사 신청이 가능합니다." },
        ],
        unknownFields: [],
        suggestedDetailTab: "summary",
      },
      packet([partialB]),
    );
    assert.equal(result.output?.recommendations.length ?? 0, 0);
    assert.ok(result.issues.includes("unknown_upgraded_to_positive:u-b"));
  });

  it("keeps a partial-verdict recommendation that does disclose a caution", () => {
    const result = validateReasonerOutput(
      {
        shortAnswer: "요약",
        recommendations: [
          { universityId: "u-b", reasonFactIds: ["fact-b-1"], cautionFactIds: ["fact-b-1"], explanation: "기숙사 신청은 가능하나 배정 보장 여부는 확인이 필요합니다." },
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
          { universityId: "u-a", reasonFactIds: ["fact-a-1"], cautionFactIds: [], explanation: "IELTS 6.0 이상을 요구합니다." },
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
          { universityId: "u-a", reasonFactIds: ["fact-a-1"], cautionFactIds: [], explanation: "IELTS 6.0 이상을 요구합니다." },
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
        shortAnswer: "University A는 IELTS 6.0을 요구합니다.",
        recommendations: [
          { universityId: "u-b", reasonFactIds: ["fact-b-1"], cautionFactIds: [], explanation: "기숙사가 보장됩니다." },
        ],
        unknownFields: [],
        suggestedDetailTab: "summary",
      },
      packet([matchedA, partialB]),
    );
    assert.equal(result.output?.shortAnswer, "University A는 IELTS 6.0을 요구합니다.");
    assert.equal(result.output?.recommendations.length ?? 0, 0);
  });

  it("returns null output only when both the narrative and every recommendation fail", () => {
    const result = validateReasonerOutput(
      {
        shortAnswer: "",
        recommendations: [
          { universityId: "u-b", reasonFactIds: ["fact-b-1"], cautionFactIds: [], explanation: "기숙사가 보장됩니다." },
        ],
        unknownFields: [],
        suggestedDetailTab: "summary",
      },
      packet([partialB]),
    );
    assert.equal(result.output, null);
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
