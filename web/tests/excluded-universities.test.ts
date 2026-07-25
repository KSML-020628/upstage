import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EXCLUDED_UNIVERSITY_IDS, isExcludedUniversityId } from "../app/lib/excluded-universities.ts";

describe("excluded-universities: exact-id exclusion, never a name substring match", () => {
  it("excludes North Park University's exact canonical id", () => {
    assert.equal(isExcludedUniversityId("06e08924-f32d-4f73-962b-3b138f195e62"), true);
  });

  it("does not exclude an unrelated university id", () => {
    assert.equal(isExcludedUniversityId("5afa27e9-7044-4048-9a97-ea025693c987"), false);
  });

  it("does not exclude a similarly-prefixed or substring-matching id", () => {
    assert.equal(isExcludedUniversityId("06e08924"), false);
    assert.equal(isExcludedUniversityId("06e08924-f32d-4f73-962b-3b138f195e62-extra"), false);
  });

  it("the exclusion set contains exactly one entry (no accidental broadening)", () => {
    assert.equal(EXCLUDED_UNIVERSITY_IDS.size, 1);
  });
});
