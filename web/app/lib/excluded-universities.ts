// Universities that must never surface anywhere in the service, keyed by
// their exact canonical `universities.id` -- never by name substring match
// (a name-based exclusion could silently also drop an unrelated university
// with a similar name). Applied at every independent Supabase read path
// that loads university rows (app/lib/supabase.ts's getUniversities/
// getUniversity, app/lib/chat/university-catalog.ts's getUniversityCatalog)
// so every downstream consumer (search, map/list, chatbot single-lookup
// and recommendation paths, compare, detail page, direct API) inherits the
// exclusion without needing its own filter.
//
// North Park University (06e08924-f32d-4f73-962b-3b138f195e62): example/
// demo data added during development, not a real partner university this
// service should represent. The row still exists in the production
// database as of this commit -- direct DB deletion could not be executed
// from this environment (see docs/decisions.md for the exact SQL to run
// manually). This runtime exclusion is the only enforcement until that
// manual deletion happens; removing it from this set without also having
// deleted the underlying rows would make North Park reappear.
export const EXCLUDED_UNIVERSITY_IDS: ReadonlySet<string> = new Set([
  "06e08924-f32d-4f73-962b-3b138f195e62",
]);

export function isExcludedUniversityId(id: string): boolean {
  return EXCLUDED_UNIVERSITY_IDS.has(id);
}
