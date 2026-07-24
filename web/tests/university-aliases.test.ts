import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { universityNamesFromAliases } from "../app/lib/chat/university-aliases.ts";

describe("universityNamesFromAliases: two-university comparison phrasings", () => {
  it("resolves both universities from bare English short names with Korean particles attached", () => {
    // Regression: "Sheffield와 Bristol을 어학, 기숙사, 마감일 기준으로 비교해줘"
    // used to resolve zero universities (no "University of" prefix, no Korean
    // nickname, and no "university/college/대학/학교" keyword anywhere in the
    // sentence for findTargetUniversities's keyword-gated heuristic to latch
    // onto), so the query fell through to generic recommendation ranking and
    // returned 4 unrelated universities instead of Sheffield/Bristol.
    const names = universityNamesFromAliases("Sheffield와 Bristol을 어학, 기숙사, 마감일 기준으로 비교해줘.");
    assert.deepEqual(new Set(names), new Set(["University of Sheffield", "University of Bristol"]));
  });

  it("resolves both universities from bare English short names with 'vs'", () => {
    const names = universityNamesFromAliases("Sheffield vs Bristol을 비교해줘.");
    assert.deepEqual(new Set(names), new Set(["University of Sheffield", "University of Bristol"]));
  });

  it("resolves both universities from Korean nicknames", () => {
    const names = universityNamesFromAliases("셰필드와 브리스톨을 어학, 기숙사, 마감일 기준으로 비교해줘.");
    assert.deepEqual(new Set(names), new Set(["University of Sheffield", "University of Bristol"]));
  });

  it("resolves both universities from official full names", () => {
    const names = universityNamesFromAliases("University of Bristol과 University of Sheffield의 IELTS와 지원 마감일을 표로 비교해줘.");
    assert.deepEqual(new Set(names), new Set(["University of Sheffield", "University of Bristol"]));
  });

  it("does not register a short-name alias for a country name or major world city (false-positive risk)", () => {
    // "Indonesia"/"Sao Paulo" are deliberately excluded from short-form
    // aliasing -- registering them would make any unrelated question that
    // happens to mention the country/city wrongly resolve to a single
    // named-university query.
    const names = universityNamesFromAliases("Indonesia와 Sao Paulo 중 어디가 물가가 더 싼가요?");
    assert.deepEqual(names, []);
  });
});
