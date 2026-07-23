import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveTargetUniversityIds, tablesForRequestedFields } from "../app/lib/chat/targeted-query.ts";
import type { QueryPlan } from "../app/lib/chat/query-plan.ts";
import type { UniversityCatalogItem } from "../app/lib/chat/university-catalog.ts";

function plan(overrides: Partial<QueryPlan> = {}): QueryPlan {
  return {
    intent: "housing",
    universityNames: [],
    hardFilters: { regions: [], countries: [], excludedRegions: [], excludedCountries: [] },
    softPreferences: {},
    requestedFields: [],
    limit: 4,
    followupReference: { enabled: false },
    clarificationNeeded: false,
    ...overrides,
  } as QueryPlan;
}

const catalog: UniversityCatalogItem[] = [
  { universityId: "u-sheffield", universityName: "University of Sheffield", aliases: [], country: "United Kingdom", region: "europe" },
  { universityId: "u-bristol", universityName: "University of Bristol", aliases: [], country: "United Kingdom", region: "europe" },
  { universityId: "u-hanken", universityName: "Hanken School of Economics", aliases: ["한켄"], country: "Finland", region: "europe" },
  { universityId: "u-ntu", universityName: "National Taiwan University", aliases: [], country: "Taiwan", region: "asia" },
];

describe("tablesForRequestedFields: only allowlisted, requested tables are ever queried", () => {
  it("maps requested fields to exactly their own tables, nothing extra", () => {
    const { tables, unsupported } = tablesForRequestedFields(["housing_options"]);
    assert.deepEqual(tables, ["housing_facts"]);
    assert.deepEqual(unsupported, []);
  });

  it("never includes cost_facts/language_requirements/etc when they weren't requested", () => {
    const { tables } = tablesForRequestedFields(["application_deadlines"]);
    assert.deepEqual(tables, ["application_deadlines"]);
    assert.ok(!tables.includes("cost_facts"));
    assert.ok(!tables.includes("language_requirements"));
    assert.ok(!tables.includes("housing_facts"));
  });

  it("reports course_restrictions/source_links as unsupported (no dedicated fact table today)", () => {
    const { tables, unsupported } = tablesForRequestedFields(["course_restrictions", "source_links"]);
    assert.deepEqual(tables, []);
    assert.deepEqual(unsupported.sort(), ["course_restrictions", "source_links"]);
  });

  it("defaults to just base university info when nothing was requested", () => {
    const { tables, unsupported } = tablesForRequestedFields([]);
    assert.deepEqual(tables, []);
    assert.deepEqual(unsupported, []);
  });
});

describe("resolveTargetUniversityIds", () => {
  it("resolves an exact universityNames list to only those catalog entries", () => {
    const targets = resolveTargetUniversityIds(plan({ universityNames: ["University of Sheffield"] }), catalog);
    assert.deepEqual(targets.map((t) => t.universityId), ["u-sheffield"]);
  });

  it("falls back to region-filtered catalog entries when no university is named", () => {
    const targets = resolveTargetUniversityIds(
      plan({ hardFilters: { regions: ["europe"], countries: [], excludedRegions: [], excludedCountries: [] } }),
      catalog,
    );
    assert.deepEqual(targets.map((t) => t.universityId).sort(), ["u-bristol", "u-hanken", "u-sheffield"]);
  });

  it("excludes a region via excludedRegions without needing a named university", () => {
    const targets = resolveTargetUniversityIds(
      plan({ hardFilters: { regions: [], countries: [], excludedRegions: ["asia"], excludedCountries: [] } }),
      catalog,
    );
    assert.ok(!targets.some((t) => t.universityId === "u-ntu"));
    assert.equal(targets.length, 3);
  });
});
