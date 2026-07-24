import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deadlineRowTime, parseEnglishDate, parseKoreanDate } from "../app/lib/chat/deadline-dates.ts";

describe("deadlineRowTime: the real Bristol bug (deadline_date null, Korean deadline_text)", () => {
  it("parses a Korean-formatted deadline_text when deadline_date is null (the exact Bristol row shape)", () => {
    const time = deadlineRowTime({ deadline_date: null, deadline_text: "2026년 5월 3일" });
    assert.equal(time, Date.parse("2026-05-03"));
    assert.equal(new Date(time!).getUTCFullYear(), 2026);
  });

  it("still prefers a real ISO deadline_date when present", () => {
    const time = deadlineRowTime({ deadline_date: "2026-05-03", deadline_text: "some other text" });
    assert.equal(time, Date.parse("2026-05-03"));
  });

  it("parses an English 'D Month YYYY' deadline_text when deadline_date is null", () => {
    const time = deadlineRowTime({ deadline_date: null, deadline_text: "3 May 2026" });
    assert.equal(time, Date.parse("2026-05-03"));
  });

  it("returns undefined for deadline_text with no year at all (correctly left unparsed)", () => {
    assert.equal(deadlineRowTime({ deadline_date: null, deadline_text: "15th January" }), undefined);
    assert.equal(deadlineRowTime({ deadline_date: null, deadline_text: "30 April (Finnish time 23:59)" }), undefined);
  });
});

describe("parseKoreanDate / parseEnglishDate", () => {
  it("parseKoreanDate handles single-digit month/day with zero-padding", () => {
    assert.equal(parseKoreanDate("2026년 5월 3일"), "2026-05-03");
    assert.equal(parseKoreanDate("2026년 12월 25일"), "2026-12-25");
  });

  it("parseEnglishDate handles ordinal suffixes", () => {
    assert.equal(parseEnglishDate("3rd May 2026"), "2026-05-03");
    assert.equal(parseEnglishDate("1 October 2026"), "2026-10-01");
  });
});
