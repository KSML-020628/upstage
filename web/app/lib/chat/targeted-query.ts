import type { QueryPlan } from "./query-plan.ts";
import type { ProfileSection, University } from "../types";
import type { UniversityCatalogItem } from "./university-catalog.ts";
import { LANGUAGE_TEST_ALIASES, type LanguageTestName } from "./types.ts";
import {
  normalizeCostFact,
  normalizeDeadlineFact,
  normalizeHousingFact,
  normalizeLanguageFact,
  normalizeQuotaFact,
  requestFactRows,
  requestOptionalFactRows,
  supabaseServerRequest,
} from "./supabase-facts.ts";
import { factMap, profileFromFacts, sectionsFromFacts, sourceLinks, type CanonicalFactRow } from "../supabase.ts";
import { cleanText } from "./utils.ts";

export type UniversityFactBundle = {
  universityId: string;
  universityName: string;
  country?: string;
  // Keyed by requestedFields name (language_requirements/housing_options/
  // application_deadlines/estimated_costs/quota_facts), not raw table name.
  facts: Record<string, Record<string, unknown>[]>;
};

export type CandidateSource = "provided_target_ids" | "exact_name_match" | "catalog_region_filter" | "candidate_id_search";

export type TargetedQueryResult = {
  universityIds: string[];
  // Set by the caller from resolveCandidateUniversityIds's own result --
  // this function only does stage 2 (hydration), not candidate resolution,
  // so it has no opinion on where the ID list came from.
  candidateSource: CandidateSource;
  fetchedTables: string[];
  queryCount: number;
  rowCountsByTable: Record<string, number>;
  factBundles: UniversityFactBundle[];
  // Fields with no dedicated fact table today (course_restrictions,
  // source_links) -- the caller (route.ts's shadow block) explicitly
  // borrows these from the legacy University object instead of pretending
  // the Targeted Query Builder fetched them independently.
  unsupportedFields: string[];
  errors: string[];
};

const FIELD_TABLE_ALLOWLIST: Record<
  string,
  { table: string; select: string; normalize: (row: Record<string, unknown>) => Record<string, unknown>; optional?: boolean } | null
> = {
  universities: null,
  language_requirements: {
    table: "language_requirements",
    select: "id,university_id,language,test_type,minimum_score,minimum_subscores,cefr_level,is_required,notes,source_url,source_type,evidence_quote,confidence,review_status,issue_notes",
    normalize: normalizeLanguageFact,
  },
  housing_options: {
    table: "housing_facts",
    select: "id,university_id,housing_available,housing_guaranteed,housing_type,room_type,meal_type,cost_min,cost_max,currency,billing_period,application_required,deadline,source_url,source_type,evidence_quote,confidence,review_status,issue_notes",
    normalize: normalizeHousingFact,
  },
  application_deadlines: {
    table: "application_deadlines",
    select: "id,university_id,semester,deadline_type,deadline_date,deadline_text,source_url,source_type,evidence_quote,confidence,review_status,issue_notes",
    normalize: normalizeDeadlineFact,
  },
  estimated_costs: {
    table: "cost_facts",
    select: "id,university_id,cost_type,amount_min,amount_max,currency,billing_period,reference_period,normalized_krw_min,normalized_krw_max,source_url,source_type,evidence_quote,confidence,review_status,issue_notes",
    normalize: normalizeCostFact,
  },
  quota_facts: {
    table: "extracted_facts",
    select: "id,university_id,topic,field_key,value_json,value_text,evidence_url,evidence_quote,confidence,review_status,issue_notes",
    normalize: normalizeQuotaFact,
    optional: true,
  },
  // No dedicated fact table exists for these two -- both are only ever
  // populated from the full ui_profile_json blob, which the Targeted Query
  // Builder must not fetch (that would defeat "targeted"). The caller falls
  // back to the legacy University's own values for these specific fields.
  course_restrictions: null,
  source_links: null,
};

export function tablesForRequestedFields(requestedFields: string[]): { tables: string[]; unsupported: string[] } {
  const fields = requestedFields.length ? requestedFields : ["universities"];
  const tables: string[] = [];
  const unsupported: string[] = [];
  for (const field of fields) {
    const entry = FIELD_TABLE_ALLOWLIST[field];
    if (entry === undefined) { unsupported.push(field); continue; }
    if (entry === null) { if (field !== "universities") unsupported.push(field); continue; }
    tables.push(entry.table);
  }
  return { tables, unsupported };
}

export type RegionCountryFilter = {
  regions: string[];
  excludedRegions: string[];
  countries: string[];
  excludedCountries: string[];
};

// Exported for targeted-recommendation.ts's complex-condition candidate
// resolution (Phase 3B step 4): region/country are always-known catalog
// facts (never an "unknown" state a university can be in), so filtering by
// them can never accidentally drop a university evaluateUniversity would
// have called "partial" -- unlike housing/language/deadline conditions,
// which need the recall-preserving candidateIdsFrom* treatment below. Takes
// the raw filter fields directly (not a full QueryPlan) so both a Planner
// plan's hardFilters AND a QueryConstraints object's region/country fields
// (a different shape -- booleans + arrays, not a single regions array) can
// each build one of these and share this same filter.
export function filterCatalogByRegionCountry(filters: RegionCountryFilter, catalog: UniversityCatalogItem[]): UniversityCatalogItem[] {
  const regions = new Set(filters.regions.map((r) => r.toLowerCase()));
  const excludedRegions = new Set(filters.excludedRegions.map((r) => r.toLowerCase()));
  const countries = new Set(filters.countries.map((c) => c.toLowerCase()));
  const excludedCountries = new Set(filters.excludedCountries.map((c) => c.toLowerCase()));
  return catalog.filter((item) => {
    // Recall-preserving: an item whose region/country is UNKNOWN in the
    // catalog (item.region/item.country undefined) is never excluded by an
    // INCLUSIVE filter, only by an EXCLUSIVE one matching a known value.
    // The catalog's own region (deriveRegion, university-catalog.ts) is
    // derived from country alone and is strictly narrower than
    // filters.ts's isEuropeanUniversity/isAsianUniversity/
    // isAmericasUniversity, which also fall back to city/university-name
    // text matching the catalog doesn't even carry (it has no city field)
    // -- a university whose country the catalog can't classify but whose
    // city/name Legacy's own check WOULD recognize must still make it into
    // the candidate pool, or recall silently drops below 100% for exactly
    // that university. The shared evaluator (which uses the more accurate
    // check) still correctly filters out any wrongly-included candidate
    // later -- over-inclusion here never produces a wrong final answer,
    // only a slightly larger candidate set to hydrate.
    if (regions.size && item.region && !regions.has(item.region)) return false;
    if (excludedRegions.size && item.region && excludedRegions.has(item.region)) return false;
    if (countries.size && item.country && !countries.has(item.country.toLowerCase())) return false;
    if (excludedCountries.size && item.country && excludedCountries.has(item.country.toLowerCase())) return false;
    return true;
  });
}

function distinctUniversityIds(rows: Record<string, unknown>[]): string[] {
  return [...new Set(rows.map((row) => row.university_id).filter((id): id is string => typeof id === "string"))];
}

// Stage-1 candidate narrowing via a fact table -- ONLY used where the SQL
// filter can never drop a university the common evaluator would have
// accepted (candidate recall must stay 100%). housing_guaranteed/
// housing_available are plain booleans, but evaluateUniversity (filters.ts)
// treats a university with no true/false row at all as "unknown", which
// still surfaces in the shown card list (the partiallyMatched bucket) --
// only a university whose rows are ALL explicitly false is a true negative.
// So the guaranteed-housing filter must match true OR null rows, not eq.true
// alone; querying eq.true only silently dropped every null-only university
// from the candidate set before hydration ever got a chance to run them
// through the real evaluator (confirmed live against Q6 "기숙사 배정이
// 보장되는 대학을 추천해줘": 3 legacy-shown universities all had
// housing_guaranteed: null in every housing_facts row). A university with
// only null+false rows can slip in as an over-inclusive false positive here
// -- that's fine, stage 2's hydration + the real evaluator will correctly
// exclude it; over-inclusion never breaks recall, only under-inclusion does.
async function candidateIdsFromHousing(args: { housingGuaranteed?: boolean; housingAvailable?: boolean }): Promise<string[] | null> {
  // passesStructuredFilters (filters.ts) also checks a fallback
  // is_guaranteed column, but that field only ever appears in
  // ui_profile_json-sourced housing_options rows -- the structured
  // housing_facts TABLE (what this queries) has no such column at all
  // (confirmed live: querying it throws a real Postgres 42703 "column does
  // not exist" error). housing_guaranteed is the only column that exists
  // here.
  const filter = args.housingGuaranteed
    ? "or=(housing_guaranteed.eq.true,housing_guaranteed.is.null)"
    : args.housingAvailable
      ? "housing_available=eq.true"
      : null;
  if (!filter) return null;
  const rows = await supabaseServerRequest<Record<string, unknown>[]>(
    `housing_facts?select=university_id&${filter}&review_status=neq.rejected&limit=1000`,
  );
  return distinctUniversityIds(rows);
}

// Deliberately does NOT filter by minimum_score at the SQL level (the real
// comparison is "this university's requirement <= the student's own
// score", which needs per-row numeric evaluation the common evaluator
// already does correctly) -- only narrows by test_type, using the exact
// same alias substrings matchesLanguageTest (filters.ts) checks, so this
// can't silently exclude a row the common evaluator would have accepted.
async function candidateIdsFromLanguage(languageTest?: LanguageTestName): Promise<string[] | null> {
  if (!languageTest) return null;
  const aliases = LANGUAGE_TEST_ALIASES[languageTest];
  const orFilter = aliases.map((alias) => `test_type.ilike.*${alias}*`).join(",");
  const rows = await supabaseServerRequest<Record<string, unknown>[]>(
    `language_requirements?select=university_id&or=(${orFilter})&review_status=neq.rejected&limit=1000`,
  );
  return distinctUniversityIds(rows);
}

export async function resolveCandidateUniversityIds(args: {
  plan: QueryPlan;
  catalog: UniversityCatalogItem[];
  // Already resolved by route.ts's own alias/legacy-name/follow-up matching
  // (exactTargets/followupTargets) -- when present, used DIRECTLY instead of
  // re-resolving via the catalog, so a case like "셰필드 기숙사" (which our
  // own alias system already resolves correctly) never falls back to
  // scanning the whole catalog.
  providedUniversityIds?: string[];
  groundedHousingAvailable?: boolean;
  groundedHousingGuaranteed?: boolean;
  groundedLanguageTest?: LanguageTestName;
}): Promise<{ ids: string[]; source: CandidateSource; queryCount: number }> {
  if (args.providedUniversityIds?.length) {
    return { ids: args.providedUniversityIds, source: "provided_target_ids", queryCount: 0 };
  }
  if (args.plan.universityNames.length) {
    const byName = new Map(args.catalog.map((item) => [item.universityName, item.universityId]));
    const ids = args.plan.universityNames.flatMap((name) => {
      const id = byName.get(name);
      return id ? [id] : [];
    });
    return { ids, source: "exact_name_match", queryCount: 0 };
  }

  // Recommendation-style query, no named university -- 2-stage candidate
  // search: (1) catalog region/country filter (no query, uses the
  // already-loaded thin catalog), (2) intersect with any fact-table
  // candidate search that has a safe, recall-preserving SQL filter.
  const regionFiltered = filterCatalogByRegionCountry({
    regions: args.plan.hardFilters.regions ?? [],
    excludedRegions: args.plan.hardFilters.excludedRegions ?? [],
    countries: args.plan.hardFilters.countries ?? [],
    excludedCountries: args.plan.hardFilters.excludedCountries ?? [],
  }, args.catalog).map((item) => item.universityId);
  const factCandidateResults = await Promise.all([
    candidateIdsFromHousing({ housingGuaranteed: args.groundedHousingGuaranteed, housingAvailable: args.groundedHousingAvailable }),
    candidateIdsFromLanguage(args.groundedLanguageTest),
  ]);
  const factCandidateSets = factCandidateResults.filter((set): set is string[] => set !== null);
  if (!factCandidateSets.length) {
    return { ids: regionFiltered, source: "catalog_region_filter", queryCount: 0 };
  }
  const intersected = regionFiltered.filter((id) => factCandidateSets.every((set) => set.includes(id)));
  return { ids: intersected, source: "candidate_id_search", queryCount: factCandidateResults.length };
}

// Stage 2: full-row hydration for exactly the resolved candidate IDs and
// exactly the allowlisted tables implied by requestedFields -- no other
// table or university is ever touched.
export async function queryRelevantUniversityFacts(
  universityIds: string[],
  requestedFields: string[],
  candidateSource: CandidateSource,
): Promise<TargetedQueryResult> {
  const errors: string[] = [];
  const { unsupported } = tablesForRequestedFields(requestedFields);
  const fields = requestedFields.length ? requestedFields : ["universities"];
  const fetchedTables: string[] = [];
  const rowCountsByTable: Record<string, number> = {};
  const rowsByField = new Map<string, Map<string, Record<string, unknown>[]>>();
  let queryCount = 0;

  for (const field of fields) {
    const entry = FIELD_TABLE_ALLOWLIST[field];
    if (entry === undefined || entry === null || !universityIds.length) continue;
    try {
      queryCount += 1;
      const rows = entry.optional
        ? await requestOptionalFactRows(entry.table, universityIds, entry.select)
        : await requestFactRows(entry.table, universityIds, entry.select);
      fetchedTables.push(entry.table);
      rowCountsByTable[entry.table] = rows.length;
      const byUniversity = new Map<string, Record<string, unknown>[]>();
      for (const row of rows) {
        const universityId = typeof row.university_id === "string" ? row.university_id : undefined;
        if (!universityId) continue;
        byUniversity.set(universityId, [...(byUniversity.get(universityId) ?? []), entry.normalize(row)]);
      }
      rowsByField.set(field, byUniversity);
    } catch (error) {
      errors.push(`fetch_failed:${entry.table}:${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const factBundles: UniversityFactBundle[] = universityIds.map((id) => ({
    universityId: id,
    universityName: "",
    facts: Object.fromEntries(
      [...rowsByField.entries()].map(([field, byUniversity]) => [field, byUniversity.get(id) ?? []]),
    ),
  }));

  return { universityIds, candidateSource, fetchedTables, queryCount, rowCountsByTable, factBundles, unsupportedFields: unsupported, errors };
}

export type LegacyFallbackData = {
  profileSections: ProfileSection[];
  sourceLinksData: Record<string, unknown>[];
  // Added for Phase 3B step 4 (complex-recommendation candidate pools):
  // satisfiesMajor (filters.ts) reads university.summary and
  // exchange_programs[0].course_registration_notes as its keyword-match
  // corpus. A single-university lookup (Phase 3B step 2) always has these
  // via a scoped getUniversity() call, but a multi-candidate recommendation
  // pool never calls getUniversity() per candidate (that would be N
  // separate queries) -- these two fields are derived from the exact same
  // canonical_facts rows this function already fetches in one batched
  // query, so no extra round trip is needed to also return them.
  summary?: string;
  courseRegistrationNotes?: string;
};

// Phase 3A.2: profile_sections and source_links have no dedicated fact
// table -- both are only ever derived from the canonical_facts blob
// (ui_profile_json, or the section_NN_summary/evidence_url rows it falls
// back to). Previously hydrateUniversitiesFromCatalog borrowed both from
// the full legacy University[] (which requires getChatUniversities()'s
// full ~53-university load to have already happened), which meant the
// Targeted Query Builder was never actually independent of the full legacy
// load -- it just looked independent because the caller already had that
// full load sitting around anyway. This queries canonical_facts scoped to
// ONLY the resolved candidate IDs, reusing the exact same derivation logic
// supabase.ts's own legacy loader uses, so a real Phase 3B primary path
// (no full legacy preload) can still populate these two fields correctly.
// course_restrictions has no fact-table OR blob derivation anywhere in this
// codebase today -- legacy's own exchangeProgram() (supabase.ts) never
// populates it either -- so it stays a fixed empty array on both sides,
// not a "fallback" that pretends to depend on anything.
export type LegacyFallbackFetchResult = {
  data: Map<string, LegacyFallbackData>;
  // Reported separately so callers can fold this query's real DB cost into
  // the same row-count/query-count metrics used for the fair legacy-vs-
  // targeted latency comparison -- this fetch is real Targeted-side query
  // load, not something to leave invisible in that comparison.
  rowCount: number;
  queryCount: number;
};

export async function fetchLegacyFallbackFields(universityIds: string[]): Promise<LegacyFallbackFetchResult> {
  const result = new Map<string, LegacyFallbackData>();
  if (!universityIds.length) return { data: result, rowCount: 0, queryCount: 0 };
  const select = "university_id,field_key,topic,value_json,value_text,evidence_url";
  const rows: CanonicalFactRow[] = [];
  let queryCount = 0;
  for (let index = 0; index < universityIds.length; index += 80) {
    const group = universityIds.slice(index, index + 80).map(encodeURIComponent).join(",");
    queryCount += 1;
    rows.push(...(await supabaseServerRequest<CanonicalFactRow[]>(`canonical_facts?select=${select}&university_id=in.(${group})`)));
  }
  const byUniversity = new Map<string, CanonicalFactRow[]>();
  for (const row of rows) {
    if (!row.university_id) continue;
    byUniversity.set(row.university_id, [...(byUniversity.get(row.university_id) ?? []), row]);
  }
  for (const id of universityIds) {
    const facts = byUniversity.get(id) ?? [];
    const mapped = factMap(facts);
    const profile = profileFromFacts(facts);
    result.set(id, {
      profileSections: sectionsFromFacts(profile, mapped),
      sourceLinksData: sourceLinks(profile, mapped),
      // Same derivation supabase.ts's hydrateUniversity() uses for these two
      // fields (minus its own static-fallback-dataset lookup, which only
      // matters when Supabase itself is unreachable -- not relevant here,
      // since reaching this line already means the canonical_facts query
      // above succeeded).
      summary: cleanText(profile?.summary, cleanText(mapped.get("summary")?.value_text, "")) || undefined,
      courseRegistrationNotes: cleanText(profile?.course_registration_notes, mapped.get("section_11_summary")?.value_text ?? "") || undefined,
    });
  }
  return { data: result, rowCount: rows.length, queryCount };
}

// Builds the SAME University shape the legacy pipeline uses
// (exchange_programs[0]), so the caller can feed it into the EXACT SAME
// evaluateUniversity/passesStructuredFilters/selectCards/
// selectClassifiedCards functions the legacy path uses -- no separate
// targeted-only evaluator or ranker is implemented anywhere.
// city/summary/academic_year/program_name are still borrowed from the
// legacy University when available (cheap, non-scoring identity fields,
// not the class of "legacy fallback" this phase scoped down).
// profile_sections/source_links prefer legacyFallback (fetchLegacyFallbackFields'
// scoped, per-candidate canonical_facts query, used by the shadow path and
// Phase 3B step 1, which run alongside a full legacy load anyway) but fall
// back to legacyById's own University object when legacyFallback has no
// entry -- Phase 3B step 2's fast path passes a single-entry legacyById
// (from a scoped getUniversity(id) call, not a full load) and an EMPTY
// legacyFallback, since getUniversity() already derives profile_sections/
// source_links from its own canonical_facts fetch; requiring a second,
// duplicate scoped fetch just to populate legacyFallback would defeat the
// purpose of skipping the full load in the first place.
export function hydrateUniversitiesFromCatalog(
  catalogItems: UniversityCatalogItem[],
  factBundles: UniversityFactBundle[],
  legacyById: Map<string, University>,
  legacyFallback: Map<string, LegacyFallbackData>,
): University[] {
  const bundleById = new Map(factBundles.map((bundle) => [bundle.universityId, bundle]));
  return catalogItems.map((item): University => {
    const bundle = bundleById.get(item.universityId);
    const legacy = legacyById.get(item.universityId);
    const legacyProgram = legacy?.exchange_programs?.[0];
    const fallback = legacyFallback.get(item.universityId);
    return {
      id: item.universityId,
      university_name: item.universityName,
      country: item.country ?? legacy?.country ?? "",
      city: legacy?.city ?? "",
      summary: fallback?.summary ?? legacy?.summary ?? "",
      latitude: legacy?.latitude ?? 0,
      longitude: legacy?.longitude ?? 0,
      profile_sections: fallback?.profileSections ?? legacy?.profile_sections ?? [],
      exchange_programs: [{
        id: legacyProgram?.id ?? `${item.universityId}-targeted`,
        university_id: item.universityId,
        academic_year: legacyProgram?.academic_year ?? "",
        program_name: legacyProgram?.program_name ?? "",
        course_registration_notes: fallback?.courseRegistrationNotes ?? legacyProgram?.course_registration_notes ?? "",
        language_requirements: bundle?.facts.language_requirements ?? [],
        housing_options: bundle?.facts.housing_options ?? [],
        application_deadlines: bundle?.facts.application_deadlines ?? [],
        estimated_costs: bundle?.facts.estimated_costs ?? [],
        quota_facts: bundle?.facts.quota_facts ?? [],
        course_restrictions: [],
        source_links: fallback?.sourceLinksData ?? legacyProgram?.source_links ?? [],
      }],
    };
  });
}

// Fair, apples-to-apples row-count basis for BOTH sides: total raw fact
// rows represented in memory, not a post-selection card count. Used for
// the legacy side by summing every loaded University's own fact arrays.
export function countTotalFactRows(universities: University[]): number {
  return universities.reduce((sum, university) => {
    const program = university.exchange_programs?.[0];
    if (!program) return sum;
    return sum
      + (program.language_requirements?.length ?? 0)
      + (program.housing_options?.length ?? 0)
      + (program.application_deadlines?.length ?? 0)
      + (program.estimated_costs?.length ?? 0)
      + (program.quota_facts?.length ?? 0)
      + (program.course_restrictions?.length ?? 0)
      + (program.source_links?.length ?? 0);
  }, 0);
}
