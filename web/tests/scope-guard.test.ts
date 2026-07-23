import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isConservativeChitchat } from "../app/lib/chat/constraints.ts";

describe("isConservativeChitchat: blocks only unambiguous chit-chat", () => {
  const chitchat = ["안녕", "안녕하세요", "고마워", "감사합니다", "thanks", "hello", "ㅋㅋㅋ", "ㅎㅎ", "😊", "👍🙏"];
  for (const text of chitchat) {
    it(`blocks "${text}"`, () => assert.equal(isConservativeChitchat(text), true));
  }

  const realQuestions = [
    "셰필드 기숙사",
    "브리스톨 IELTS",
    "2026 봄 마감",
    "유럽 대학",
    "오늘 서울 날씨 알려줘", // off-topic but NOT chit-chat -- must reach the Planner, which itself should call it out_of_scope
    "Hanken 붙을 수 있을까?", // the real regex false-negative this fix targets
  ];
  for (const text of realQuestions) {
    it(`does not block "${text}"`, () => assert.equal(isConservativeChitchat(text), false));
  }

  it("treats an empty/whitespace-only message as chit-chat (nothing to plan)", () => {
    assert.equal(isConservativeChitchat("   "), true);
  });
});
