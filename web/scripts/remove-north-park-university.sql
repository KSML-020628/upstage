-- Manual production deletion: North Park University (example/demo data).
--
-- This environment's Claude Code session could not execute DELETE
-- statements directly against the Supabase database (blocked by the
-- platform's own safety guardrails for destructive database operations).
-- A code-level runtime exclusion (app/lib/excluded-universities.ts) hides
-- this university from every user-facing path in the meantime, but the
-- underlying rows still exist in the production database until this SQL
-- is run manually by someone with direct database access (e.g. via the
-- Supabase SQL editor).
--
-- Verified before writing this script (read-only queries against the
-- live database, via SUPABASE_SERVICE_ROLE_KEY):
--   - Exact canonical id: 06e08924-f32d-4f73-962b-3b138f195e62
--   - universities: 1 row
--   - canonical_facts: 1 row (field_key = ui_profile_json)
--   - language_requirements / housing_facts / application_deadlines /
--     cost_facts / extracted_facts: 0 rows each
-- No other university's data is touched by these statements -- every
-- WHERE clause below filters on this exact id only, never a name
-- substring match.

BEGIN;

DELETE FROM canonical_facts
WHERE university_id = '06e08924-f32d-4f73-962b-3b138f195e62';

DELETE FROM universities
WHERE id = '06e08924-f32d-4f73-962b-3b138f195e62';

COMMIT;

-- Verification (should both return 0 rows):
-- SELECT * FROM universities WHERE id = '06e08924-f32d-4f73-962b-3b138f195e62';
-- SELECT * FROM universities WHERE name ILIKE '%North Park%';
-- SELECT * FROM canonical_facts WHERE university_id = '06e08924-f32d-4f73-962b-3b138f195e62';
--
-- After this runs, app/lib/excluded-universities.ts's entry for this id
-- becomes redundant (safe to remove in a later, separate change) but is
-- not itself harmful to leave in place -- it will simply never match
-- anything once the rows are gone.
