import { AMERICAS_COUNTRIES, ASIA_COUNTRIES, EUROPE_COUNTRIES, normalizeSearchText } from "./utils.ts";
import { UNIVERSITY_ALIASES } from "./university-aliases.ts";
import { isExcludedUniversityId } from "../excluded-universities.ts";

// Phase 3A (shadow-only): a minimal per-university identity record for
// feeding the Planner and the Targeted Query Builder, deliberately excluding
// every fact field (language scores, housing detail, cost, deadlines,
// quota, full UI profile JSON, source rows). This is NOT wired into the real
// response path -- app/api/chat/route.ts still loads the full
// getChatUniversities() result and answers from that. See docs/decisions.md.
export type UniversityCatalogItem = {
  universityId: string;
  universityName: string;
  aliases: string[];
  country?: string;
  region?: "europe" | "asia" | "americas";
};

type CatalogRow = {
  id: string;
  name: string;
  country: string | null;
};

function supabaseCatalogRestBase() {
  const raw = (process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/+$/, "");
  return raw.endsWith("/rest/v1") ? raw : `${raw}/rest/v1`;
}

function supabaseCatalogKey() {
  return (
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_SERVICE_KEY ??
    process.env.SUPABASE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    process.env.SUPABASE_ANON_KEY
  );
}

// Deliberately re-derives region from country the same way
// isEuropeanUniversity/isAsianUniversity/isAmericasUniversity do (utils.ts),
// rather than importing those directly -- they expect a full University
// object, and this module intentionally has no dependency on that richer
// shape (the whole point of a "thin" catalog).
function deriveRegion(country: string | null): UniversityCatalogItem["region"] {
  const normalized = normalizeSearchText(country ?? "");
  if (!normalized) return undefined;
  if (EUROPE_COUNTRIES.has(normalized) || /united kingdom|\buk\b|england|scotland/.test(normalized)) return "europe";
  if (ASIA_COUNTRIES.has(normalized)) return "asia";
  if (AMERICAS_COUNTRIES.has(normalized)) return "americas";
  return undefined;
}

function aliasesFor(universityName: string, aliasMap: Record<string, string[]>): string[] {
  return aliasMap[universityName] ?? [];
}

let cachedCatalog: { at: number; items: UniversityCatalogItem[] } | undefined;
const CATALOG_CACHE_MS = 5 * 60 * 1000;

export async function getUniversityCatalog(): Promise<UniversityCatalogItem[]> {
  if (cachedCatalog && Date.now() - cachedCatalog.at < CATALOG_CACHE_MS) return cachedCatalog.items;

  const key = supabaseCatalogKey();
  const base = supabaseCatalogRestBase();
  if (!key || !base || base === "/rest/v1") {
    throw new Error("Supabase environment is not configured for getUniversityCatalog");
  }

  const response = await fetch(`${base}/universities?select=id,name,country&order=name.asc`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    next: { revalidate: 300 },
  });
  if (!response.ok) throw new Error(`getUniversityCatalog fetch failed: ${response.status}`);
  const allRows = await response.json() as CatalogRow[];
  // See excluded-universities.ts -- exact-id exclusion, applied here so
  // the Targeted paths (which resolve candidates from this catalog, never
  // the full getUniversities() load) also never surface it.
  const rows = allRows.filter((row) => !isExcludedUniversityId(row.id));

  const items = rows.map((row): UniversityCatalogItem => ({
    universityId: row.id,
    universityName: row.name,
    aliases: aliasesFor(row.name, UNIVERSITY_ALIASES),
    country: row.country ?? undefined,
    region: deriveRegion(row.country),
  }));
  cachedCatalog = { at: Date.now(), items };
  return items;
}

// Compatibility adapter: runSolarPlanner's existing API contract takes a
// bare `knownUniversityNames: string[]` (see query-plan.ts) -- until that's
// changed to accept catalog entries directly (a real API-contract change,
// out of scope for a shadow-only phase), this adapts a catalog to the shape
// the existing Planner call already expects, so the shadow path can share
// the exact same catalog data instead of re-deriving a name list.
export function catalogToKnownUniversityNames(catalog: UniversityCatalogItem[]): string[] {
  return catalog.map((item) => item.universityName);
}

// A second adapter to resolve a Planner-returned name (or a Korean alias)
// back to a catalog entry -- the same resolution job
// university-aliases.ts/findTargetUniversities do against the full
// University[] list, but against the thin catalog instead.
export function resolveCatalogItemByName(catalog: UniversityCatalogItem[], name: string): UniversityCatalogItem | undefined {
  const normalized = name.trim().toLowerCase();
  return catalog.find((item) => item.universityName.toLowerCase() === normalized);
}
