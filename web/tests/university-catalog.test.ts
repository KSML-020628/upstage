import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { catalogToKnownUniversityNames, resolveCatalogItemByName } from "../app/lib/chat/university-catalog.ts";
import type { UniversityCatalogItem } from "../app/lib/chat/university-catalog.ts";

const catalog: UniversityCatalogItem[] = [
  { universityId: "u-sheffield", universityName: "University of Sheffield", aliases: ["셰필드대"], country: "United Kingdom", region: "europe" },
  { universityId: "u-hanken", universityName: "Hanken School of Economics", aliases: ["한켄"], country: "Finland", region: "europe" },
];

describe("UniversityCatalogItem: contains no detailed fact fields", () => {
  it("only ever has the 5 identity keys -- no language/housing/cost/deadline/quota/profile fields", () => {
    const allowedKeys = new Set(["universityId", "universityName", "aliases", "country", "region"]);
    for (const item of catalog) {
      for (const key of Object.keys(item)) {
        assert.ok(allowedKeys.has(key), `unexpected key "${key}" on a catalog item -- catalog must stay fact-free`);
      }
    }
  });
});

describe("catalogToKnownUniversityNames: compatibility adapter for runSolarPlanner's existing API", () => {
  it("returns exactly the catalog's official names, in order", () => {
    assert.deepEqual(catalogToKnownUniversityNames(catalog), ["University of Sheffield", "Hanken School of Economics"]);
  });
});

describe("resolveCatalogItemByName", () => {
  it("resolves an exact (case-insensitive) official name to its catalog entry", () => {
    const item = resolveCatalogItemByName(catalog, "university of sheffield");
    assert.equal(item?.universityId, "u-sheffield");
  });

  it("returns undefined for a name not in the catalog", () => {
    assert.equal(resolveCatalogItemByName(catalog, "Nonexistent University"), undefined);
  });
});
