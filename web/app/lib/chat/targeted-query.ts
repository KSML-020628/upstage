import type { QueryPlan } from "./query-plan.ts";
import type { UniversityCatalogItem } from "./university-catalog.ts";
import {
  normalizeCostFact,
  normalizeDeadlineFact,
  normalizeHousingFact,
  normalizeLanguageFact,
  normalizeQuotaFact,
  requestFactRows,
  requestOptionalFactRows,
} from "./supabase-facts.ts";

export type UniversityFactBundle = {
  universityId: string;
  universityName: string;
  country?: string;
  // Keyed by requestedFields name (language_requirements/housing_options/
  // application_deadlines/estimated_costs/quota_facts), not raw table name --
  // matches the vocabulary the Planner and the rest of the chat pipeline
  // already use, so a caller never has to know the underlying table names.
  facts: Record<string, Record<string, unknown>[]>;
};

export type TargetedQueryResult = {
  universityIds: string[];
  fetchedTables: string[];
  rowCountsByTable: Record<string, number>;
  factBundles: UniversityFactBundle[];
  errors: string[];
};

// Allowlist: requestedFields value -> [DB table, normalizer, optional?]. No
// other table is ever queried, and only for the university IDs explicitly
// passed in -- Solar never sees or builds a query string; this Object is the
// only thing that decides what gets fetched.
const FIELD_TABLE_ALLOWLIST: Record<
  string,
  { table: string; select: string; normalize: (row: Record<string, unknown>) => Record<string, unknown>; optional?: boolean } | null
> = {
  universities: null, // base catalog info only, no extra table
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
  // No dedicated fact table exists for these two today -- both are only
  // ever populated from the full ui_profile_json blob (see the Phase 3A
  // pipeline investigation), which the Targeted Query Builder must NOT
  // fetch (that would defeat the entire point of "targeted"). Requesting
  // either surfaces as a non-fatal error entry, not a thrown exception --
  // this is a real, found gap in today's schema, not a bug in this builder.
  course_restrictions: null,
  source_links: null,
};

// Pure, network-free allowlist decision -- exported so tests can verify
// "a table not implied by requestedFields is never queried" without needing
// to mock Supabase network calls.
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

export function resolveTargetUniversityIds(plan: QueryPlan, catalog: UniversityCatalogItem[]): UniversityCatalogItem[] {
  if (plan.universityNames.length) {
    const byName = new Map(catalog.map((item) => [item.universityName, item]));
    return plan.universityNames.flatMap((name) => {
      const item = byName.get(name);
      return item ? [item] : [];
    });
  }
  // No specific university named (a recommendation/collection query) --
  // "targeted" here means targeted COLUMNS (only the requested fact tables)
  // and, when the plan carries a region/country condition, targeted ROWS
  // too (filtered using only the thin catalog's own country/region field,
  // never touching fact data to decide which universities are in scope).
  const regions = new Set([...(plan.hardFilters.regions ?? [])].map((r) => r.toLowerCase()));
  const excludedRegions = new Set([...(plan.hardFilters.excludedRegions ?? [])].map((r) => r.toLowerCase()));
  const countries = new Set((plan.hardFilters.countries ?? []).map((c) => c.toLowerCase()));
  const excludedCountries = new Set((plan.hardFilters.excludedCountries ?? []).map((c) => c.toLowerCase()));
  return catalog.filter((item) => {
    if (regions.size && !(item.region && regions.has(item.region))) return false;
    if (excludedRegions.size && item.region && excludedRegions.has(item.region)) return false;
    if (countries.size && !(item.country && countries.has(item.country.toLowerCase()))) return false;
    if (excludedCountries.size && item.country && excludedCountries.has(item.country.toLowerCase())) return false;
    return true;
  });
}

export async function queryRelevantUniversityFacts(
  plan: QueryPlan,
  catalog: UniversityCatalogItem[],
): Promise<TargetedQueryResult> {
  const errors: string[] = [];
  const targets = resolveTargetUniversityIds(plan, catalog);
  const universityIds = targets.map((item) => item.universityId);

  const requestedFields = plan.requestedFields.length ? plan.requestedFields : ["universities"];
  const fetchedTables: string[] = [];
  const rowCountsByTable: Record<string, number> = {};
  const rowsByField = new Map<string, Map<string, Record<string, unknown>[]>>(); // field -> universityId -> rows

  for (const field of requestedFields) {
    const entry = FIELD_TABLE_ALLOWLIST[field];
    if (entry === undefined) { errors.push(`unallowlisted_field:${field}`); continue; }
    if (entry === null) { if (field !== "universities") errors.push(`no_dedicated_fact_table:${field}`); continue; }
    if (!universityIds.length) continue;
    try {
      const rows = entry.optional
        ? await requestOptionalFactRows(entry.table, universityIds, entry.select)
        : await requestFactRows(entry.table, universityIds, entry.select);
      fetchedTables.push(entry.table);
      rowCountsByTable[entry.table] = rows.length;
      const byUniversity = new Map<string, Record<string, unknown>[]>();
      for (const row of rows) {
        const universityId = typeof row.university_id === "string" ? row.university_id : undefined;
        if (!universityId) continue;
        const normalized = entry.normalize(row);
        byUniversity.set(universityId, [...(byUniversity.get(universityId) ?? []), normalized]);
      }
      rowsByField.set(field, byUniversity);
    } catch (error) {
      errors.push(`fetch_failed:${entry.table}:${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const factBundles: UniversityFactBundle[] = targets.map((item) => ({
    universityId: item.universityId,
    universityName: item.universityName,
    country: item.country,
    facts: Object.fromEntries(
      [...rowsByField.entries()].map(([field, byUniversity]) => [field, byUniversity.get(item.universityId) ?? []]),
    ),
  }));

  return { universityIds, fetchedTables, rowCountsByTable, factBundles, errors };
}
