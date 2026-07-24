import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeTriStateFlag } from "../app/lib/chat/utils.ts";
import { evaluateUniversity, passesStructuredFilters } from "../app/lib/chat/filters.ts";
import { presentHousingGuarantee } from "../app/lib/display/present-fact.ts";
import type { QueryConstraints } from "../app/lib/chat/types.ts";
import type { University } from "../app/lib/types.ts";

describe("normalizeTriStateFlag: shared true/false/unknown normalization", () => {
  it("treats real booleans as-is", () => {
    assert.equal(normalizeTriStateFlag(true), true);
    assert.equal(normalizeTriStateFlag(false), false);
  });

  it("recognizes true, \"true\", \"yes\", \"y\", 1 as true (case/whitespace-insensitive)", () => {
    for (const value of [true, "true", "TRUE", " True ", "yes", "Yes", " YES ", "y", "Y", 1]) {
      assert.equal(normalizeTriStateFlag(value), true, `expected true for ${JSON.stringify(value)}`);
    }
  });

  it("recognizes false, \"false\", \"no\", \"n\", 0 as false (case/whitespace-insensitive)", () => {
    for (const value of [false, "false", "FALSE", " False ", "no", "No", " NO ", "n", "N", 0]) {
      assert.equal(normalizeTriStateFlag(value), false, `expected false for ${JSON.stringify(value)}`);
    }
  });

  it("treats null, undefined, empty string, and unrecognized values as unknown (undefined) -- never silently false", () => {
    for (const value of [null, undefined, "", "   ", "maybe", "unknown", 2, -1, {}, []]) {
      assert.equal(normalizeTriStateFlag(value), undefined, `expected undefined for ${JSON.stringify(value)}`);
    }
  });
});

function baseConstraints(overrides: Partial<QueryConstraints> = {}): QueryConstraints {
  return {
    intent: "housing",
    topN: 4,
    explicitTopN: false,
    requireEurope: false,
    requireAsia: false,
    requireAmericas: false,
    inScope: true,
    requireHousing: false,
    requireHousingGuaranteed: true,
    requireAll: false,
    requireOfficialSource: false,
    requireClearCost: false,
    countries: [],
    excludedCountries: [],
    excludeAsia: false,
    requestedFields: [],
    explicitClears: [],
    ...overrides,
  } as QueryConstraints;
}

function universityWithHousingRows(id: string, housingOptions: Record<string, unknown>[]): University {
  return {
    id,
    university_name: id,
    country: "United Kingdom",
    city: "",
    summary: "",
    latitude: 0,
    longitude: 0,
    profile_sections: [],
    exchange_programs: [{
      id: `${id}-program`,
      university_id: id,
      academic_year: "2026/27",
      program_name: "Exchange",
      language_requirements: [],
      housing_options: housingOptions,
      application_deadlines: [],
      estimated_costs: [],
      quota_facts: [],
      course_restrictions: [],
      source_links: [],
    }],
  };
}

describe("evaluateUniversity: housing_guaranteed condition check is source-shape-independent", () => {
  it("a structured-table row (housing_guaranteed: true) is 'met'", () => {
    const university = universityWithHousingRows("u-table-true", [{ housing_guaranteed: true, review_status: "approved" }]);
    const result = evaluateUniversity(university, baseConstraints());
    const check = result.checks.find((c) => c.key === "housing_guaranteed");
    assert.equal(check?.state, "met");
  });

  it("a blob-shaped row (is_guaranteed: \"Yes\", a string, not a boolean) is ALSO 'met' -- the real bug this step fixes", () => {
    const university = universityWithHousingRows("u-blob-yes", [{ is_guaranteed: "Yes", review_status: "approved" }]);
    const result = evaluateUniversity(university, baseConstraints());
    const check = result.checks.find((c) => c.key === "housing_guaranteed");
    assert.equal(check?.state, "met");
  });

  it("a blob-shaped row (is_guaranteed: \"No\") is 'failed', not silently 'unknown'", () => {
    const university = universityWithHousingRows("u-blob-no", [{ is_guaranteed: "No", review_status: "approved" }]);
    const result = evaluateUniversity(university, baseConstraints());
    const check = result.checks.find((c) => c.key === "housing_guaranteed");
    assert.equal(check?.state, "failed");
  });

  it("a genuinely unrecognized value stays 'unknown' (not coerced to false)", () => {
    const university = universityWithHousingRows("u-weird-value", [{ is_guaranteed: "TBD", review_status: "approved" }]);
    const result = evaluateUniversity(university, baseConstraints());
    const check = result.checks.find((c) => c.key === "housing_guaranteed");
    assert.equal(check?.state, "unknown");
  });

  it("no housing rows at all is 'unknown', not 'failed' -- recall-preserving default unchanged by this fix", () => {
    const university = universityWithHousingRows("u-no-rows", []);
    const result = evaluateUniversity(university, baseConstraints());
    const check = result.checks.find((c) => c.key === "housing_guaranteed");
    assert.equal(check?.state, "unknown");
  });

  it("Legacy-shaped (is_guaranteed) and Targeted-shaped (housing_guaranteed) universities with equivalent real facts produce IDENTICAL condition_checks", () => {
    const legacyShaped = universityWithHousingRows("u-same-fact", [{ is_guaranteed: "Yes", review_status: "approved" }]);
    const targetedShaped = universityWithHousingRows("u-same-fact", [{ housing_guaranteed: true, review_status: "approved" }]);
    const legacyResult = evaluateUniversity(legacyShaped, baseConstraints());
    const targetedResult = evaluateUniversity(targetedShaped, baseConstraints());
    assert.deepEqual(
      legacyResult.checks.map((c) => ({ key: c.key, state: c.state })),
      targetedResult.checks.map((c) => ({ key: c.key, state: c.state })),
    );
    assert.equal(legacyResult.status, targetedResult.status);
  });
});

describe("passesStructuredFilters: the strict boolean gate also recognizes the blob's string shape", () => {
  it("passes for is_guaranteed: \"Yes\" the same as housing_guaranteed: true", () => {
    const blobShaped = universityWithHousingRows("u-blob", [{ is_guaranteed: "Yes" }]);
    const tableShaped = universityWithHousingRows("u-table", [{ housing_guaranteed: true }]);
    assert.equal(passesStructuredFilters(blobShaped, baseConstraints()), true);
    assert.equal(passesStructuredFilters(tableShaped, baseConstraints()), true);
  });

  it("does not pass for is_guaranteed: \"No\"", () => {
    const university = universityWithHousingRows("u-blob-no", [{ is_guaranteed: "No" }]);
    assert.equal(passesStructuredFilters(university, baseConstraints()), false);
  });
});

describe("presentHousingGuarantee: the display layer recognizes the blob's string shape too (not just filters.ts)", () => {
  it("renders \"보장\" for is_guaranteed: \"Yes\", the same as housing_guaranteed: true", () => {
    assert.equal(presentHousingGuarantee({ is_guaranteed: "Yes" }).value, "보장");
    assert.equal(presentHousingGuarantee({ housing_guaranteed: true }).value, "보장");
  });

  it("renders \"명시적으로 보장되지 않음\" for is_guaranteed: \"No\", not \"unknown\"", () => {
    const field = presentHousingGuarantee({ is_guaranteed: "No" });
    assert.equal(field.value, "명시적으로 보장되지 않음");
  });

  it("stays unknown (no value) when the row has no guarantee field at all", () => {
    const field = presentHousingGuarantee({});
    assert.equal(field.value, undefined);
  });
});
