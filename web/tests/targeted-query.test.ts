import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  hydrateUniversitiesFromCatalog,
  resolveCandidateUniversityIds,
  tablesForRequestedFields,
} from "../app/lib/chat/targeted-query.ts";
import type { QueryPlan } from "../app/lib/chat/query-plan.ts";
import type { UniversityCatalogItem } from "../app/lib/chat/university-catalog.ts";
import type { University } from "../app/lib/types.ts";

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

  it("reports course_restrictions/source_links as unsupported (no dedicated fact table today)", () => {
    const { tables, unsupported } = tablesForRequestedFields(["course_restrictions", "source_links"]);
    assert.deepEqual(tables, []);
    assert.deepEqual(unsupported.sort(), ["course_restrictions", "source_links"]);
  });
});

describe("resolveCandidateUniversityIds: Phase 3A.1 requirement 1 -- reuse already-resolved target IDs directly", () => {
  it("uses providedUniversityIds directly, bypassing catalog name-matching entirely (fixes '셰필드 기숙사')", async () => {
    const result = await resolveCandidateUniversityIds({
      plan: plan(),
      catalog,
      providedUniversityIds: ["u-sheffield"],
    });
    assert.equal(result.source, "provided_target_ids");
    assert.deepEqual(result.ids, ["u-sheffield"]);
  });

  it("resolves an exact universityNames list when no provided IDs exist", async () => {
    const result = await resolveCandidateUniversityIds({
      plan: plan({ universityNames: ["University of Sheffield"] }),
      catalog,
    });
    assert.equal(result.source, "exact_name_match");
    assert.deepEqual(result.ids, ["u-sheffield"]);
  });

  it("falls back to region-filtered catalog entries when no university/provided IDs exist and no fact-table constraint applies", async () => {
    const result = await resolveCandidateUniversityIds({
      plan: plan({ hardFilters: { regions: ["europe"], countries: [], excludedRegions: [], excludedCountries: [] } }),
      catalog,
    });
    assert.equal(result.source, "catalog_region_filter");
    assert.deepEqual(result.ids.sort(), ["u-bristol", "u-hanken", "u-sheffield"]);
  });
});

describe("hydrateUniversitiesFromCatalog: common Domain Model, no separate targeted evaluator", () => {
  it("produces a University[] shape usable by the same selectCards/evaluateUniversity as legacy", () => {
    const factBundles = [
      { universityId: "u-sheffield", universityName: "University of Sheffield", facts: { housing_options: [{ housing_guaranteed: true }] } },
    ];
    const legacyById = new Map<string, University>();
    const [university] = hydrateUniversitiesFromCatalog(
      [{ universityId: "u-sheffield", universityName: "University of Sheffield", aliases: [], country: "United Kingdom", region: "europe" }],
      factBundles,
      legacyById,
    );
    assert.equal(university.id, "u-sheffield");
    assert.equal(university.exchange_programs?.[0]?.housing_options?.length, 1);
    assert.equal(university.exchange_programs?.[0]?.housing_options?.[0]?.housing_guaranteed, true);
  });

  it("explicitly borrows course_restrictions/source_links from the legacy University (no independent targeted fetch)", () => {
    const legacy: University = {
      id: "u-sheffield", university_name: "University of Sheffield", country: "United Kingdom", city: "Sheffield",
      summary: "", latitude: 0, longitude: 0,
      exchange_programs: [{
        id: "p1", university_id: "u-sheffield", academic_year: "2026/27", program_name: "Exchange",
        course_restrictions: [{ restriction_text: "Some restriction" }],
        source_links: [{ url: "https://example.com" }],
      }],
    };
    const legacyById = new Map([["u-sheffield", legacy]]);
    const [university] = hydrateUniversitiesFromCatalog(
      [{ universityId: "u-sheffield", universityName: "University of Sheffield", aliases: [], country: "United Kingdom", region: "europe" }],
      [],
      legacyById,
    );
    assert.equal(university.exchange_programs?.[0]?.course_restrictions?.[0]?.restriction_text, "Some restriction");
    assert.equal(university.exchange_programs?.[0]?.source_links?.[0]?.url, "https://example.com");
  });
});
