# Architecture decisions

## Solar planner results are authoritative over server regex heuristics

**Principle**: if the Solar planner returns a valid plan, a server-side regex
rule does not get to invalidate it. The regex rule is a fallback for when the
planner is unavailable or returned nothing usable -- not a second opinion
that can override a planner result that does exist.

**Why this is written down**: on 2026-07-23, flipping `SOLAR_PLANNER_MODE`'s
default from `shadow` to `active` (see `docs/solar_usage.md`) exposed a bug
that had the same *symptom* as the old shadow-mode waste (Solar's work
getting thrown away) but a different *cause*: `needsTargetClarification`'s
`asksForCollection` regex was intercepting the request and returning a
clarification prompt, discarding a planner result that had already run
successfully and already contained a real search condition. Patching
`asksForCollection` with more patterns would only have hidden the next
phrasing it doesn't cover (the same bug class as the C1-C7 regex issues from
the earlier code review) -- the actual defect was that the gate never
consulted the planner result in the first place.

**How this is enforced**: `plannerHasSearchConditions()` in
`app/lib/chat/planner-integration.ts` checks whether the planner's plan
carries a real region/country/language/GPA/housing/quota/major condition.
`needsTargetClarification()` (`app/lib/chat/responses.ts`) takes this as a
parameter and short-circuits to "no clarification needed" when it's true,
before ever consulting its own regex. It also reports `overriddenByPlanner`
so the caller can log when the regex and the planner would have disagreed
(`app/api/chat/route.ts` logs `[chat-v2] target-clarification overridden by
planner`) -- watch this log for how often this actually happens in practice.

The same principle was applied to `needsFollowupScopeClarification()`: its
call site in `route.ts` now passes the planner-merged `constraints` for the
*current* turn instead of the raw regex-only `detectedConstraints` (prior
turns are necessarily regex-only -- there is no stored planner output to
reconstruct them from). The route computes both the regex-only and
planner-aware verdicts and logs `[chat-v2] followup-scope-clarification
overridden by planner` when they diverge.

## Audit: other gates that could ignore the planner

Full audit of every early-return / "should we short-circuit" decision point
in `app/api/chat/route.ts` and the modules it calls, checking whether each
one consults the planner's result when one exists.

**Fixed this pass:**

- `needsTargetClarification` -- described above.
- `needsFollowupScopeClarification` -- described above.
- The early `explicitUnknownInstitution` check (right after the planner
  call) was resolving targets from only the Korean-alias and regex-name
  matchers, not the planner's own resolved `universityNames` -- even though
  the planner had already run earlier in the same function. A question whose
  only recognizable university came from the planner (not an alias or the
  regex matcher) could have been wrongly reported as "unknown institution."
  Fixed by resolving `exactTargets` (alias -> planner -> regex, in that
  priority order) once, before this check, and reusing it for both this
  check and the later target-clarification/selection logic. This also
  removed a second, now-always-redundant `explicitUnknownInstitution` call
  further down that used to run against a differently-computed target list.

**Found, not fixed (real cost/architecture tradeoff, needs an explicit
decision, not a "just defer to planner" fix):**

- **`constraints.inScope` is never planner-aware, and worse, the planner call
  itself is gated behind it.** `detectConstraints()`'s regex-based
  `isExchangeQuestion()` sets `legacyConstraints.inScope`, and
  `runSolarPlanner()` is only called when `legacyConstraints.inScope` is
  true (`route.ts`, the planner invocation). If regex misclassifies an
  in-scope question as out-of-scope, the planner never runs at all --there
  is no planner opinion to consult afterward, unlike the two gates fixed
  above where the planner had already run and its result was simply
  ignored. `QueryPlan.intent` does have an `"out_of_scope"` value the planner
  could use to weigh in, but doing so would mean calling Solar on every
  message regardless of what the regex thinks, including genuinely
  off-topic chitchat ("오늘 서울 날씨 알려줘") that the regex currently
  filters out for free. That's a real cost tradeoff (a Solar call on every
  message vs. only on ones the regex already thinks are relevant), not a
  free correctness fix -- do not change this without deciding whether that
  cost is acceptable first.

**Checked, not a bug (intentionally planner-independent by design):**

- `isPromptInjectionRequest` -- a security gate. Must not defer to the model
  being asked about, on principle.
- `isCostOfLivingIndexQuestion` / `costOfLivingResponse` -- routes to an
  entirely separate feature (a different data source, not represented in
  `QueryPlan`'s schema at all) and runs before the planner is even called.
  There is no planner opinion to ignore.
- `isRemovedCostRecommendation` -- already explicitly documented in
  `route.ts` as a deliberate product-policy override: "Product policy must
  win even when the active planner classifies the question as out of scope
  or changes its intent." A conscious decision, not an oversight.
- `isFollowupReference` / `explicitFollowup` -- the one place this matters
  most (`usePreviousResults`, deciding whether to search within a prior
  turn's results) already ORs the regex signal with
  `planner.validatedPlan?.followupReference.enabled`. `explicitFollowup`
  alone still gates whether conversation-memory constraints get folded in
  and whether the two clarification checks run at all, so a planner-detected
  followup that the regex misses could still be treated as a fresh topic
  change in those specific paths. Not fixed this pass -- flagged as a
  candidate follow-up, lower observed impact than the two gates above.

## Phase 3A: Targeted Query Builder runs shadow-only, real path untouched

**Principle**: a Planner-first Targeted Query Builder (`app/lib/chat/
targeted-query.ts`) runs ALONGSIDE the existing full-load pipeline, purely
for comparison logging (`[chat-v2] targeted-query-shadow`) and latency
measurement -- its result is never used for the actual response. This is
enforced by isolating the whole shadow block in its own try/catch inside
`app/api/chat/route.ts` (a shadow failure only logs, never affects the
response) and by never assigning its output to `cards`/`shortAnswer`.

**Why this phase exists**: to validate, with real measurements against the
live DB, whether a lightweight `UniversityCatalogItem` catalog
(`university-catalog.ts`, id/name/aliases/country/region only -- no facts)
plus an allowlist-based per-field query builder can support the same
answers the current "load everything" pipeline (`getChatUniversities()`)
produces, before committing to a real primary-path migration.

**What the 2026-07-24 shadow run against 12 real query types found**:
- `resolveTargetUniversityIds` (targeted-query.ts) can only narrow the
  university-ID set two ways: an exact `universityNames` match, or a
  region/country filter using the catalog's own thin fields. It has **no**
  equivalent of the legacy pipeline's actual constraint matching (language
  score comparison, GPA conversion, quota threshold, topN ranking) --
  neither does anything in Phase 3A attempt to build one, since the
  instructions scope this phase to DB-access parity, not decision-logic
  parity. For any recommendation-style question with no named university
  and no region/country filter (language-score-only, housing-guarantee-only,
  major-only), the fallback is "the whole catalog" -- far broader than the
  handful of cards the legacy path actually settles on. This is the single
  dominant cause of the `mismatch` parityStatus results in the Phase 3A
  report (10 of 12 dedicated test questions): not a bug in the query
  builder, but a real, expected scope boundary of what a catalog-only
  targeting strategy can do without also re-implementing selection logic
  against the fetched facts.
- `course_restrictions` and `source_links` have no dedicated fact table in
  today's schema -- both are only ever populated from the full
  `ui_profile_json` blob (see the Phase 3A pipeline investigation). The
  allowlist reports these as `no_dedicated_fact_table:<field>` rather than
  fetching the blob (which would defeat "targeted"); a real primary-path
  migration would need either a schema change or an accepted exception for
  these two fields.
- Row-count and latency comparisons in the shadow log are NOT strictly
  apples-to-apples yet: `legacyFetchedRowCount` counts only the rows that
  ended up in the final answer cards' `fact_bundle` (a post-selection
  count), while `targetedFetchedRowCount` counts raw DB rows fetched
  pre-selection -- comparing them directly overstates how much "more" the
  targeted query fetches. `legacyQueryMs` measures only `getChatUniversities
  ()`'s own completion time, which is frequently a Next.js fetch-cache hit
  (`revalidate: 300`) within a fast test run, not a representative cold-load
  time. Any Phase 3B latency claim needs its own, deliberately cold-cache
  measurement of both paths.

## Phase 3A.1: reuse resolved target IDs, common evaluator, 2-stage candidates

**Principle carried over from Phase 3A, now enforced structurally**: the
Targeted Query Builder never re-implements matching/ranking. Both
`getChatUniversities()` (legacy) and `hydrateUniversitiesFromCatalog()`
(targeted) build the identical `University[]` Domain Model, and
`app/api/chat/route.ts`'s shadow block runs the SAME `selectCards`/
`selectClassifiedCards`/`evaluateUniversity`/`passesStructuredFilters`
functions on both -- no `targeted-only` evaluator exists anywhere in this
codebase.

**Fix 1 -- reuse already-resolved target IDs directly.** Phase 3A's
`resolveTargetUniversityIds` only knew how to re-resolve a named university
via catalog matching, so "셰필드 기숙사" (an alias `route.ts` had already
resolved to Sheffield via `exactTargets`/`followupTargets`) fell through to
a full-catalog scan. `resolveCandidateUniversityIds` (targeted-query.ts)
now takes `providedUniversityIds` -- the same IDs `route.ts` already
resolved via alias/legacy-name/follow-up matching -- and uses them directly
as the stage-1 candidate set, skipping catalog resolution entirely whenever
they exist.

**Fix 2 -- Bristol deadline mismatch was a real, pre-existing production
bug, not a Targeted-vs-legacy artifact.** Investigated by comparing raw
`application_deadlines` rows for Bristol directly against Supabase: every
Bristol row has `deadline_date: null`, with the actual date only present in
a Korean-formatted `deadline_text` (e.g. "2026년 5월 3일"). `deadlineRowTime()`
(then inlined in `filters.ts`, now extracted to `app/lib/chat/
deadline-dates.ts`) only parsed ISO-formatted dates, so it silently
returned `undefined` for every Bristol row, and any year-filtered deadline
query rejected all of them -- in BOTH the legacy and the (then-nonexistent)
targeted path; this was never a shadow-only artifact. Fixed by adding
Korean (`parseKoreanDate`) and English-longform (`parseEnglishDate`) date
fallbacks, verified against real data (69 total `deadline_date IS NULL`
rows, 44 of them Korean-formatted) and confirmed live: Bristol's 2026
deadline query now returns 1 card on both paths.

**Fix 3 -- critical bug: full catalog passed to hydration silently
substituted wrong universities.** `hydrateUniversitiesFromCatalog` was
called with the full ~53-item catalog instead of the resolved candidate IDs
only, so `selectCards`/`selectClassifiedCards` scored and ranked among all
53 mostly-empty hydrated objects instead of just the intended candidate(s).
Confirmed via 3x repeat testing that the real (legacy) response was stable
(always exactly 1 card, Sheffield) while the shadow's `targetedUniversityIds`
deterministically substituted 4 different, wrong universities each run --
ruling out Solar nondeterminism as the cause. Fixed by filtering the catalog
down to `candidateCatalogItems` (only the resolved candidate IDs) before
calling `hydrateUniversitiesFromCatalog` (`route.ts`'s shadow block). This
single fix resolved every single-university and two-university-compare test
question (Q1-Q5, Q8, Q10, Q11) to `parityStatus: "exact"`.

**Fix 4 -- 2-stage candidate search for recommendation-style queries, and
why a strict boolean SQL filter breaks recall.** For queries with no named
university (e.g. "기숙사 배정이 보장되는 대학을 추천해줘"),
`resolveCandidateUniversityIds` narrows candidates by intersecting a
catalog region/country filter with a fact-table search
(`candidateIdsFromHousing`/`candidateIdsFromLanguage`). The first version of
the housing-guarantee filter used `housing_guaranteed=eq.true`, which
looked exact (a plain boolean check) but was NOT: `evaluateUniversity`
(filters.ts:622-628) treats a university whose only housing rows have
`housing_guaranteed: null` as an "unknown" partial match, which still
surfaces in the shown card list (the `partiallyMatched` bucket, per this
file's own three-state display rule). A strict `eq.true` filter silently
dropped every null-only university from the candidate set before hydration
ever ran it through the real evaluator -- confirmed live against "기숙사
배정이 보장되는 대학을 추천해줘": 3 of the 7 legacy-shown universities had
`housing_guaranteed: null` on every one of their `housing_facts` rows. Fixed
by widening the SQL filter to `or=(housing_guaranteed.eq.true,
housing_guaranteed.is.null)` -- over-inclusive by design (a university with
only null+false rows can slip in as a false positive), which is safe
because stage 2's hydration + the real evaluator correctly rejects it
afterward; only under-inclusion breaks recall. Verified live: candidate
recall for this query is now 100% (all 7 legacy IDs confirmed present in
the stage-1 candidate set via direct query, independent of the final
top-N ranking).

**Residual, structural limitation (not fixed, documented instead): legacy
and the structured fact tables are two independent, unsynced data
sources.** `getChatUniversities()` (`app/lib/supabase.ts:237`) reads
`housing_options` from the `ui_profile_json` blob / `canonical_facts`
(`field_key = 'housing_options'`), while the Targeted Query Builder reads
the separate, newer `housing_facts` TABLE. For the same real-world
university these two pipelines can disagree on row count (confirmed live:
identical `housing_guaranteed` classification for several universities, but
different row counts between the blob array and the structured table rows).
`scoreUniversity`'s housing-intent score is `housing_options.length * 4`
(filters.ts:84), so once the classification (met/unknown/failed) genuinely
agrees between legacy and targeted, the shared ranker can still produce a
DIFFERENT top-N cut across the two paths purely from this row-count
difference feeding score ties -- e.g. for the housing-guarantee
recommendation question, one exact-match and one extra university swapped
places in the final 7-card cut even though the candidate SET (pre-ranking)
was already provably identical. This is not a correctness bug in the
Targeted Query Builder or in candidate resolution -- it is inherent to
having two independently-extracted data sources feed the same conceptual
field, and it falls within the "semantically equivalent final cards"
tolerance (same qualifying universities, different tie-break order), not
the "candidate recall must be 100%" requirement. A full fix would require
either migrating all `housing_options`/`language_requirements`/etc. data
into the single structured fact tables (a data migration, out of scope
here) or changing `scoreUniversity` to score by qualification rather than
row count (a change to shared, already-relied-upon ranking logic, not
attempted in this phase).

**Unsupported fields fall back to legacy explicitly, not silently.**
`course_restrictions` and `source_links` still have no dedicated fact table;
`hydrateUniversitiesFromCatalog` borrows both directly from the
corresponding legacy `University` object (`legacyProgram?.course_restrictions
?? []`, `legacyProgram?.source_links ?? []`) rather than leaving them
empty and pretending the Targeted Query Builder fetched them.

## Phase 3A.1 follow-up: Q6 ranking-tie root cause, Q7 comparison bug, qa-runner rate limit

The user's own re-review of the Phase 3A.1 report rejected two things this
doc previously called "acceptable": Q6's ranking-tie mismatch (previously
filed as within the "semantically equivalent" tolerance) and Q7's
comparison-query bug (previously filed as a real but out-of-scope legacy
bug). Both were investigated further and fixed rather than left as
documented limitations -- the corrected tally is 11/12 exact,
1/12 exact_with_legacy_fallback, 0 mismatch, 0 equivalent.

**Q6's real root cause was two separate bugs, not an inherent data-source
limitation.** Direct comparison of the legacy vs. targeted scored pools
(`scoreUniversity` output for every "matched" university, both sides) showed
the classification/membership already agreed exactly (22 "matched"
universities on both sides) -- the divergence was purely in individual
scores at the tie boundary:
1. `scoreUniversity`'s housing-intent score was `housing_options.length *
   4` -- proportional to raw row count. Legacy's `housing_options` comes
   from the `ui_profile_json` blob, targeted's from the separate
   `housing_facts` table; the two can have different row counts for
   identical `housing_guaranteed`/`housing_available` values. Fixed by
   scoring on bounded qualitative signals (provided/guaranteed/verified)
   instead -- see `housingQualitySignalScore` in filters.ts.
2. Even after that fix, the ranking still didn't match, because
   `hydrateUniversitiesFromCatalog` never carried `profile_sections` over
   from the legacy University at all (not "different", just absent).
   `scoreUniversity`'s generic token-matching component reads
   `sectionText()`, which reads `profile_sections` -- so targeted's corpus
   text was silently thinner than legacy's, changing scores by 1-2 points
   for many universities. Fixed by borrowing `profile_sections` from legacy
   the same way `course_restrictions`/`source_links` already are.
3. Neither fix alone was sufficient while ties existed with no deterministic
   tie-break beyond score: `selection.ts`'s sort comparators fell back to
   `b.score - a.score` with nothing after it, so tied scores resolved by
   array input order -- and the legacy full-load list and the targeted
   candidate-filtered list are not the same array, so ties broke
   differently even once scores matched. Added a `university.id.
   localeCompare()` tie-break as the last step of every ranking comparator
   in `selectCards`/`selectClassifiedCards`.

All three together made the housing-guarantee recommendation query's final
card IDs and order come out byte-for-byte identical between legacy and
targeted (verified live, requestId `a7c8734a`).

**Q7's root cause: `UNIVERSITY_ALIASES` only ever registered Korean
nicknames.** "Sheffield와 Bristol을 어학, 기숙사, 마감일 기준으로 비교해줘"
(bare English short names, Korean particles attached directly, no
"University of" prefix, no Korean nickname, and critically no "university/
school/college/대학/학교" keyword anywhere in the sentence) resolved zero
target universities through either the alias matcher or
`findTargetUniversities`'s keyword-gated single-token heuristic
(`selection.ts`), so both `route.ts`'s own `exactTargets` resolution AND the
Targeted Query Builder's candidate resolution fell through to generic
recommendation ranking -- the REAL production response, not just the
shadow comparison, returned 4 unrelated universities. Notably, "Sheffield vs
Bristol을 비교해줘" and the Korean-nickname/official-full-name variants
already worked; only the bare-English-plus-Korean-particle phrasing failed.
Fixed by adding English short-name aliases to `UNIVERSITY_ALIASES` for
names distinctive enough to be safe (Bristol, Copenhagen, Helsinki,
Manitoba, Rostock, Sheffield) -- deliberately excluding "University of
Indonesia" ("Indonesia") and "University of Sao Paulo" ("Sao Paulo") since
a country name and a major world city name could false-positive-match a
totally unrelated question. All 4 requested phrasings verified live to
return exactly the 2 named universities; regression tests added
(`tests/university-aliases.test.ts`).

**qa-runner's standard (no `--only`) run appeared to hang/fail for reasons
unrelated to code correctness -- traced to the chat route's own rate
limiter.** `isRateLimited()` (`route.ts`) allows 10 requests per 60 seconds
per client, keyed by `x-forwarded-for`; a local `next dev` server has no
reverse proxy setting that header, so EVERY local request -- real manual
testing and qa-runner's 32-turn sequential run alike -- shares one
`"anonymous"` bucket. At `QA_DELAY_MS`'s default 1200ms, qa-runner's first
~10 turns pass and the remaining ~22 hit 429 within the same 60-second
window; `postChatWithRetry`'s single retry after a 5s wait usually lands
inside that same window too. Individually re-running each of the 7 test
groups as separate processes worked around this (each process's first ~10
requests fit under the limit) and confirmed 32/32 passed on identical code,
but that's a workaround, not a fix. Fixed by relaxing
`RATE_LIMIT_REQUESTS` to a high default outside of `NODE_ENV=production`
(overridable via `CHAT_RATE_LIMIT_REQUESTS`) -- the strict per-client limit
is a production abuse guard, not something a single, trusted, sequential
local test process should be measured against. Verified: standard `node
qa-runner.mjs` (no flags) now passes 32/32 in one continuous run.

**Row-count fairness fixed.** `countTotalFactRows()` (targeted-query.ts)
sums every fact array across ALL loaded legacy universities, giving a
raw-row-count basis for the legacy side that's comparable to
`targetedFetchedRowCount` (both now count pre-selection raw DB rows, not
post-selection card contents) -- the Phase 3A caveat about this comparison
being apples-to-oranges no longer applies to row counts. Cold/warm
cache-state tagging for latency was flagged as a Phase 3A caveat and is
still NOT implemented as of this phase -- `legacyQueryMs`/`targetedQueryMs`
are both wall-clock request-scoped measurements, but neither explicitly
tags or forces a cold vs. warm Next.js fetch-cache (`revalidate`) state, so
a latency comparison between them still should not be read as a clean
cold-cache number for either path.

## Phase 3A.2: shadow env-gate, scoped profile_sections fetch, cold/warm perf

Preparatory safety work before any Phase 3B primary-path decision -- no
primary-path change in this phase; the shadow block remains purely
comparison logging, now additionally gated so it costs nothing by default.

**Shadow execution is now off by default everywhere, not just in
production.** `CHAT_TARGETED_SHADOW_ENABLED` (default unset = disabled)
gates the entire shadow block in `route.ts`; `CHAT_TARGETED_SHADOW_SAMPLE_RATE`
(0-1, default 1 when enabled) further caps what fraction of eligible
requests actually pay the extra query cost. The gate also now checks
`finalInScope` in addition to `planner.validatedPlan` -- an out-of-scope
question (chitchat, off-topic, or the Planner classifying intent as
`out_of_scope`) has no meaningful legacy cards/constraints to compare
against, so running the shadow query for it was pure wasted query load with
zero parity signal (this was actually observed in earlier testing: the
weather/off-topic test question logged a `parityStatus: "exact"` shadow
entry with a 7-university candidate set that had nothing to do with the
question -- harmless to the real response, but meaningless log noise and
wasted queries).

**profile_sections/source_links no longer require a full legacy load.**
Previously `hydrateUniversitiesFromCatalog` borrowed both from the full
`legacyById` map derived from `getChatUniversities()`'s complete ~53-
university load -- which meant the Targeted Query Builder was never
actually independent of the full legacy load, it just looked independent
because the caller already had that full load sitting around for the real
response anyway. Added `fetchLegacyFallbackFields()` (targeted-query.ts): a
scoped `canonical_facts` query filtered to ONLY the resolved candidate IDs,
reusing the exact same derivation functions (`profileFromFacts`/
`sourceLinks`/`sectionsFromFacts`, now exported from `supabase.ts`) the
legacy loader itself uses, so a future Phase 3B primary path (no full
legacy preload) can still populate these two fields correctly.
`course_restrictions` was found to have no fact-table OR blob derivation
anywhere in this codebase today -- legacy's own `exchangeProgram()`
(`supabase.ts`) never populates it either -- so it's now a fixed empty
array on both sides rather than a "fallback" pretending to depend on
something that was never real.

**This scoped fetch has a real, non-trivial cost of its own, worth flagging
for a later optimization pass.** It selects every `field_key` for the
candidate universities' `canonical_facts` rows (needed because
`profile_sections` can be spread across an arbitrary number of
`section_NN_summary` rows with no fixed field_key list to filter on), not
just the ones profile_sections/source_links actually need. Measured live
for the housing-guarantee recommendation query (30 candidates): this one
query alone transferred 534 rows / ~1.24MB, close to the entire legacy
canonical_facts table's real size (1144 rows / ~2.3MB across all 53
universities) -- for a broad-candidate recommendation query, this fallback
fetch alone can approach the cost of the thing it's supposed to avoid. A
single-university lookup doesn't have this problem (26 rows / ~46KB for one
university). Not fixed this pass -- flagged as a concrete follow-up
(narrowing the canonical_facts select to only rows whose field_key matches
`ui_profile_json` or `/^section_\d{2}_summary$/`, evaluated server-side via
a `field_key=in.(...)` list built from a one-time discovery query, or a
`field_key=ilike.section_*` pattern if PostgREST supports it) rather than
risk an incomplete field_key list under time pressure.

**Cold/warm/row-count/query-count/byte comparison, measured on the same
basis.** "Cold" = first request after a fresh dev-server restart (empty
Next.js fetch cache, `revalidate: 300` on both `request()` in `supabase.ts`
and `supabaseServerRequest()` in `supabase-facts.ts`); "warm" = the
identical request repeated immediately after. Byte/row/query counts are
from a standalone script hitting the exact same REST endpoints and select
lists the app itself uses (not inferred).

| | Legacy (full load) | Targeted: single-university (Q1) | Targeted: recommendation, 30 candidates (Q6) |
|---|---|---|---|
| Raw DB queries | 3 (`universities` ×1, `canonical_facts` ×2 pages -- 1144 total rows exceeds the 1000/page limit) | 2 (`language_requirements` + scoped `canonical_facts` fallback) | 3 (candidate search + `housing_facts` + scoped `canonical_facts` fallback) |
| Raw DB rows | 1198 (54 + 1144) | 27 (1 + 26) | 614 (35 candidate-search + 45 + 534) |
| Data transfer | ~2.41MB | ~48KB (98% less) | ~1.28MB (47% less) |
| End-to-end, cold | 268ms | 62ms (4.3x faster) | 376ms (**1.7x slower** -- the canonical_facts fallback query dominates) |
| End-to-end, warm | 45ms | 1ms (45x faster) | 11ms (2.4x faster) |

**Reading this honestly**: for single-university lookups (by far the most
common query shape in the 12-question suite), Targeted wins decisively on
every dimension. For broad recommendation queries with a large candidate
set, Targeted still uses meaningfully fewer rows/bytes than a full legacy
load, and is still faster once warm -- but can be **slower on a cold
request specifically**, because the `canonical_facts` fallback query (the
same one flagged above as needing field_key narrowing) has to pull almost
as much data as the full legacy table would for that many candidates. This
is the direct, measured consequence of the un-narrowed fallback query, not
an inherent property of "targeted vs. full-load" -- narrowing it (per the
follow-up above) should close most of this gap. Also worth noting: the
legacy full load's cost is the *same 3 queries / ~2.41MB regardless of
question* (it always loads everything), so its cold cost is fixed and its
warm cost benefits from being one shared cache entry across every request,
while the targeted path's cache entries are scoped per distinct candidate-
ID set -- a different, new-question hits cold more often in practice than
legacy's "warm after the very first request of any kind" property, even
though each individual targeted fetch is smaller.

## Phase 3B step 1: Targeted primary for single-university lookups (canary)

**Branch**: `solar-pipeline-phase3b-canary`, off latest `origin/main` after the
Phase 3A merge (`8ffdebc`). This is the first step where the Targeted Query
Builder can actually construct a real user-facing response, not just log a
shadow comparison -- scoped as narrowly as the approval allowed.

**Scope, enforced structurally, not just by intent name**: a request is only
even considered for the Targeted primary path when `exactTargets.length ===
1` (exactly one already-resolved named university -- zero means a
recommendation query, two or more means a comparison/ranking query) AND
`followupTargets.length === 0` (no follow-up context at all, since a
follow-up-based re-ranking is explicitly held back for a later expansion)
AND `intent` is one of `general`/`language`/`housing`/`deadline`
(`TARGETED_PRIMARY_ALLOWED_INTENTS`, `targeted-primary.ts`) -- `cost`/
`quota`/`restriction`/`source` are not in this set for step 1, regardless of
target count. This directly encodes every item on the "보류" (held-back)
list from the approval: condition-based recommendations, housing-guarantee
recommendations, region-wide recommendations, compound-condition
recommendations, and multi-university comparison/ranking are all excluded
by the target-count and follow-up checks, not by trying to enumerate every
possible recommendation-shaped question.

**Feature flag defaults doubly safe, unlike the shadow flags.** Shadow
(Phase 3A.2) only ever logs a comparison, so its sample rate defaults to 1
once enabled -- a bug there costs nothing user-facing. This flag changes
what a real user sees, so `CHAT_TARGETED_PRIMARY_ENABLED` (default off)
AND `CHAT_TARGETED_PRIMARY_CANARY_RATE` (default **0**, not 1) both have to
be explicitly set for any real traffic to be routed -- flipping the enabled
flag alone still sends 0% of eligible traffic through the Targeted path.

**Fallback safety net (`resolveTargetedPrimary`, `targeted-primary.ts`)**:
every one of these falls all the way back to the caller's already-computed
legacy `cards` -- the function never returns a broken or partial result,
only "use the targeted cards" or "keep using legacy":
- `targeted_error` -- any exception anywhere in candidate resolution,
  fetching, or hydration (single try/catch around the whole attempt)
- `unsupported_field` -- if the requested fields include
  course_restrictions/source_links (no dedicated fact table). Phase
  3A.1/3A.2's shadow work built a scoped legacy-fallback-composited value
  for these fields for *comparison* purposes, but this canary step falls
  all the way back to legacy instead of shipping a partially-composited
  result to a real user as if the Targeted path had produced it
  independently -- a stricter bar than the shadow path's, deliberately
- `empty_result` -- if candidate/hydration/selection produces zero cards
- `validation_failed` -- if candidate resolution doesn't return exactly the
  one already-confirmed target ID back (should be structurally impossible
  given `providedUniversityIds` is a direct passthrough in
  `resolveCandidateUniversityIds`, but checked explicitly rather than
  assumed, since an assumption silently violated is exactly how a step like
  this ships a wrong answer to a real user)
- `flag_disabled` / `intent_not_eligible` / `followup_not_eligible` /
  `not_single_target` / `no_validated_plan` / `out_of_scope` /
  `canary_miss` -- never attempted at all (not a failure, just out of this
  step's scope or the canary roll)

`selectedPath` (`targeted_primary` | `legacy_fallback` | `legacy_default`)
and `fallbackReason` are logged (`[chat-v2] targeted-primary`) on every
request that reaches this point in the pipeline, regardless of outcome.

**Live verification**: with the flag on (canary rate 1), captured full
responses for all 4 allowed single-university intents and diffed them
byte-for-byte against the same 4 requests with the flag off (default) --
card IDs, fact bundles, and the final answer text matched exactly for all
4. Ran the full 32-scenario qa-runner suite with the flag on: still 32/32
pass, with 10 requests actually routed through `targeted_primary`, 9
correctly excluded as multi-target (recommendation/comparison), 3 correctly
excluded as follow-ups, 2 correctly excluded by intent (cost/source-only
questions) -- zero unexpected fallbacks. 158 unit tests pass (9 new, for
the eligibility gate specifically -- the success path reuses
`resolveCandidateUniversityIds`/`queryRelevantUniversityFacts`/
`hydrateUniversitiesFromCatalog`/`selectCards`, already covered by Phase 3A's
own test suite).

**Not done in this step (explicitly out of scope per the approval)**: no
main merge, no recommendation-style query conversion, no follow-up-based
re-ranking, no removal of the full legacy load (legacy remains the
mandatory fallback source and is still loaded on every request regardless
of which path serves the final response).

## Phase 3B step 2: Targeted runs before Legacy, full load only on fallback

**Branch**: `solar-pipeline-phase3b-step2`, off latest `origin/main` after the
Phase 3B step 1 merge (`90e5635`). Scope is unchanged from step 1 (single-
university `general`/`language`/`housing`/`deadline` lookups only,
recommendation/comparison/follow-up queries untouched) -- this step changes
*when* the full legacy load happens, not *what* qualifies for the Targeted
path.

**The actual architecture change**: step 1 ran the Targeted Query Builder
*after* `getChatUniversities()` had already loaded everything, so a
successful Targeted result still cost a full load either way. Step 2 moves
target resolution and the Targeted attempt *before* the full load --
`getChatUniversities()` is now only called lazily, inside the fallback
branch, and never runs at all for a request that the Targeted path serves
successfully. Verified live: for an eligible single-university request with
the flag on, the `[chat-v2] selection` log line (which only exists inside
the full-load fallback code path) never appears at all -- direct proof the
full load genuinely didn't happen, not just that its result went unused.

**How target resolution works without a full load.** Alias matching
(`universityNamesFromAliases`) and Planner-named matching are resolved
against the lightweight catalog (`getUniversityCatalog()`, already used
elsewhere in the Targeted Query Builder) instead of the full
`University[]` array -- both only ever needed a name-to-id lookup, which
the catalog already provides. The Planner's own `knownUniversityNames` list
now comes from `catalogToKnownUniversityNames(catalog)` instead of
`universities.map(u => u.university_name)`; both are built from the same
`universities` table with the same `order=name.asc`, so this is not a
behavior change to what the Planner sees. The legacy regex/token matcher
(`findTargetUniversities`) is NOT reproduced against the catalog -- it needs
full University objects (city, for one scoring branch) the catalog doesn't
have. If catalog-only resolution (alias + Planner) comes up empty, the fast
path is simply not eligible; the fallback flow still runs
`findTargetUniversities` exactly as it always has, so recall is unaffected.
Follow-up-context eligibility (`hasFollowupContext`) is entirely derivable
from `explicitFollowup`/`planner.validatedPlan?.followupReference.enabled`/
`hasExplicitGeography` -- none of which need `University[]` either.

**Single-university identity without a full load.** The fast path's
hydration step needs `city`/`summary`/`profile_sections`/`source_links`/
`academic_year`/`program_name` for its one candidate -- previously sourced
from a full-load `legacyById` map (step 1) or a separate scoped
`canonical_facts` query (`fetchLegacyFallbackFields`, Phase 3A.2). Found
that `getUniversity(id)` already existed in `supabase.ts` (used by the
university detail page) and already does exactly this: one row from
`universities` plus one scoped `canonical_facts` fetch, hydrated through
the same `hydrateUniversity()` the full loader uses per-row. Reused it
directly instead of adding a new function or paying for two separate scoped
fetches (`fetchLegacyFallbackFields` + a separate identity query) for the
same one university. `hydrateUniversitiesFromCatalog` was updated to fall
back to `legacyById`'s own `profile_sections`/`source_links` when the
separate `legacyFallback` map has no entry for a given id, so it now works
correctly for both calling conventions: a full-load-adjacent `legacyById`
with an empty `legacyFallback` (this step), or an empty `legacyById` with a
populated scoped `legacyFallback` (shadow / step 1, which still run
alongside a full load).

**Bug found and fixed during this step: the canary hash had poor avalanche
behavior for sequential/near-identical keys.** The first `stableCanaryBucket`
implementation (raw djb2 accumulation, no finalizer) mapped `"session-1"`
through `"session-10"` to nearly-sequential bucket values (7815, 7816, 7817,
... differing by exactly 1) -- confirmed live: 10 sequential session ids all
landed on the same side of a 50% canary split instead of roughly half and
half. Root cause: djb2's accumulator for two strings sharing a prefix and
differing only in the last character produces outputs that are also nearly
identical, since the shared-prefix computation is literally the same
arithmetic up to the final step. Fixed by adding a Murmur3-style finalizer
(fmix32: xor-shift, multiply, xor-shift, multiply, xor-shift) after the
djb2 loop, which scrambles the bits so a one-character difference no longer
produces a near-identical bucket -- verified against 1000 sequential keys
landing at a real ~54/46 split, and confirmed live against the actual
running server (10 sequential session ids split 5/5 after the fix, versus
10/0 before it). Regression test added
(`tests/targeted-primary.test.ts`) asserting a roughly even split across
1000 sequential keys, not just that *some* variation exists.

**Session-based (not purely per-request) determinism, verified live.** The
canary key is the client-sent `sessionId` when present, falling back to the
request's own id only when the client sent none -- 5 consecutive requests
with the same session id landed on the same side of a 50% split every time
(both before and after the hash fix); 10 different session ids produced a
real mix, not a coincidental all-one-side result (confirmed exactly by the
bug above, before the fix).

**Measured deliverables** (32-scenario qa-runner run, flag on, canary rate
1, corrected hash):

| | Count | Note |
|---|---|---|
| Reached the fast-path decision point | 31 of 32 | 1 request exits earlier via an out-of-scope early return, same category as Phase 3A.2's weather-question finding -- never reaches this code at all |
| `targeted_primary` (legacy load skipped) | 10 | ~31% of all 32 requests, ~32% of the 31 that reached the decision point |
| `not_single_target` (recommendation/comparison, never attempted) | 15 | |
| `followup_not_eligible` (never attempted) | 4 | |
| `intent_not_eligible` (cost/source-only, never attempted) | 2 | |
| `unsupported_field` (attempted, fell back) | 0 in this run; confirmed separately in a dedicated manual test | a direct "Sheffield 공식 출처" request reliably produces `legacy_fallback`/`unsupported_field` and a correct final answer |

**Response parity, re-verified for this step specifically**: captured full
responses for all 4 allowed intents with the flag on (full load skipped)
vs. off (full load, as before) and diffed them -- card ids, fact bundles,
and the exact final answer text matched for all 4, same as step 1, this
time with the full load provably not happening on the flag-on side at all.

**Cold/warm end-to-end latency -- read honestly, not as "faster overall."**
Measured the same single-university request cold (fresh server restart)
and warm (immediate repeat) for both paths:

| | Cold | Warm |
|---|---|---|
| Fast path (flag on, legacy load skipped) | ~4.9s | ~3.8s |
| Legacy full load (flag off) | ~5.4s | ~4.1s |

The gap is real but modest (roughly half a second either way) because
**Solar API latency (Planner + Reasoner round trips) dominates total
request time for both paths** -- the DB-query-level saving this phase
targets is real and much larger in relative terms (Phase 3A.2 already
measured 2 queries/~48KB for a scoped single-university fetch vs. 3
queries/~2.41MB for the full load; this step reuses that same scoped-query
shape via `getUniversity()`), but it's a small fraction of end-to-end
wall-clock time next to two sequential LLM calls. Do not describe this step
as a user-facing latency win -- its actual, verified value is removing the
full-load dependency structurally (proven by the missing `[chat-v2]
selection` log) and validating fallback correctness, not reducing response
time.

**Not done in this step**: no main merge, no recommendation-style query
conversion, no production flag activation (still 0/off by default,
requires separate approval), no change to the shadow block's own behavior
(still independently gated, still runs its own full-load comparison when
enabled).

### Follow-up review found two real gaps before this could go anywhere near production

**1. sessionId-absent requests were silently falling back to a fresh
per-request key, defeating stable sampling.** The original `canaryKey`
computation was `sessionId !== "unknown" ? sessionId : requestId` --
`requestId` is a fresh `crypto.randomUUID()` generated at the top of every
single request, so an anonymous client (no `sessionId` sent) would get a
brand-new, unrelated canary key on every message, making their canary
assignment effectively random per-request despite `stableCanaryBucket`
itself being fully deterministic. This defeated the entire point of moving
off `Math.random()`. Fixed: `attemptTargetedFastPath` now takes
`canaryKey: string | null`; `null` (no client-sent `sessionId`) is a hard
exclusion from canary (`fallbackReason: "no_stable_canary_key"`, always
Legacy), never a substitute per-request roll. Verified live: qa-runner
(which sends no `sessionId` at all) now correctly shows
`no_stable_canary_key` for every otherwise-eligible single-university
request instead of `targeted_primary`; a request with a real, stable
`sessionId` still goes through `targeted_primary` as before and still
lands on the same side of the split across repeated requests with that
same id.

**2. The claim "fallback reuses the existing Planner call, no second
invocation" needed to be independently auditable from logs, not just
asserted from reading the code.** Added `plannerCallCount`/
`reasonerCallCount` (both are 0 or 1, since `runSolarPlanner`/
`runSolarReasoner` each have exactly one call site in the whole file --
tracked explicitly rather than left implicit) and explicit
`targetedAttempted`/`targetedSucceeded`/`legacyLoadTriggered`/
`legacyLoadSkipped` fields on `[chat-v2] targeted-primary`, so a
production dashboard can compute Targeted success rate, legacy load skip
rate, and fallback rate directly from the log without re-deriving them
from `selectedPath`. Verified live against the three cases that matter:
Targeted success -> `plannerCallCount: 1`, `legacyLoadSkipped: true`;
`no_stable_canary_key` (no session) -> `plannerCallCount: 1`,
`legacyLoadTriggered: true`; attempted-then-fell-back
(`unsupported_field`) -> `plannerCallCount: 1`, `legacyLoadTriggered: true`
-- all three exactly matching the expected "Planner always exactly once"
invariant, confirmed from real request logs, not just from the fact that
there is only one `runSolarPlanner` call site in the source.

Full response parity (cards/fact_bundle/answer text) for all 4 allowed
intents re-verified after these fixes, with a real `sessionId` on the
flag-on side -- unaffected, since these changes are purely about
eligibility gating and observability, not the actual resolution/hydration
logic.

## Don't normalize language_requirements.test_type into a fixed enum

**Principle**: `presentLanguage()` (`app/lib/display/present-fact.ts`) shows
`test_type` as-is rather than mapping it onto a small canonical set like
`"IELTS Academic" | "TOEFL iBT" | "TOEIC" | ...`.

**Why**: an external review correctly identified that the university detail
page showed every language requirement row as a generic "ENGLISH" title
regardless of test (root cause: the presenter's label was built from
`language`, not `test_type` -- fixed 2026-07-23, verified against all 124
real `language_requirements` rows: 92 had this exact bug, 0 after). The
review's proposed fix also included normalizing `test_type` into a fixed
enum via string matching (`normalizeLanguageTestType()`). Checked the real
data before adopting that part: `test_type` is free text, and a large
fraction of real rows are **compound** ("TOEFL/IELTS/CEFR", "TOEFL, IELTS,
TOEIC, Cambridge, Duolingo", "IELTS or TOEFL" -- meaning *any one* of these
is accepted). Forcing those into a single canonical value would silently
claim a university only accepts one specific test when it actually accepts
several -- a real information loss the review's own examples didn't surface
because they were all single-test rows. Only 4/124 rows have no `test_type`
at all; those now say "시험 종류 확인 필요" instead of guessing, per the
review's own principle of not inventing a test from a bare score.

## Phase 3B step 3: production canary pre-preparation and verification

**Scope**: no code behavior change to the actual targeted-vs-legacy
resolution/hydration path -- this step only added observability fields
(`targetedEligible`, `canarySelected`, `targetedQueryMs`, `sessionKeyPresent`,
`exactTargetCount`, `requestId`/`totalResponseMs` on the pipeline log, and an
unconditional `[chat-v2] legacy-load` log that was previously only visible
when the separate `SHADOW_ENABLED` shadow-comparison flag was on) and ran an
extensive verification pass. Production env vars remain **untouched**:
`CHAT_TARGETED_PRIMARY_ENABLED` defaults to `false`, `CHAT_TARGETED_PRIMARY_CANARY_RATE`
defaults to `0` -- verified this step changes nothing about that default
behavior (qa-runner's 32/32 pass with no env vars set at all, and every one
of its `[chat-v2] targeted-primary` logs shows `fallbackReason:
"flag_disabled"`).

**`targetedEligible` vs `canarySelected`**: added to make "this request
structurally qualifies for Targeted" (every gate except the canary roll
passed) independently distinguishable from "the deterministic hash roll
actually picked it". Every structural exclusion (wrong intent, follow-up
context, not exactly one resolved target, no validated plan, out of scope,
no stable session key, flag disabled) reports `targetedEligible: false` --
there was never a roll to make for those. Only `canary_miss` reports
`targetedEligible: true, canarySelected: false`: this request would have
gone Targeted if the roll had gone the other way. Verified via a 7-case
unit-test sweep and live against configs B/C/D/E below.

**Live staging simulation (5 configs, 9 canonical queries: 4 allowed --
single named university + general/language/housing/deadline intent -- and 5
excluded -- recommendation, multi-university comparison, follow-up
re-ranking, official-source request, out-of-scope weather)**:

| Config | ENABLED | RATE | Result |
| --- | --- | --- | --- |
| A | false | 1 | All requests `flag_disabled`, regardless of rate -- confirms `ENABLED=false` overrides `RATE` unconditionally. |
| B | true | 0 | Allowed queries: `canary_miss` (`targetedEligible: true`). Excluded queries: their own structural reason (`not_single_target`, `followup_not_eligible`, etc.) -- never `canary_miss`, since they never reach the roll. |
| C | true | 0.01 | A pre-computed bucket-69 session (selected at 0.01) got `targeted_primary` on all 4 allowed queries; bucket-257 and bucket-1306 sessions both got `canary_miss`. Matches the 10,000-session distribution exactly. |
| D | true | 0.05 | Same bucket-69 AND bucket-257 sessions (both <500) now `targeted_primary`; bucket-1306 still `canary_miss` -- confirms threshold scaling is exact, not approximate, at the single-session level. |
| E | true | 1 | All 4 allowed queries `targeted_primary`. The "공식 출처" (official source) excluded query is structurally eligible at the intent-classification level (`intent: "language"`, not `"source"`) -- it is only correctly kept off Targeted by the `unsupported_field` safety net downstream, confirmed live (`fallbackReason: "unsupported_field"`). This makes that safety net load-bearing for source-flavored queries, not just a defensive backstop. |

Same `sessionId` was confirmed stable across every allowed+excluded query
within a config (never flips mid-session), and confirmed stable across
configs C -> D for the same session as the rate crossed its bucket
threshold (bucket-69 selected at both 0.01 and 0.05; bucket-257 miss at
0.01, selected at 0.05; bucket-1306 miss at both) -- exactly the deterministic
behavior `stableCanaryBucket` is supposed to produce, not resampled per
request.

**Response parity**: forced-Legacy (`ENABLED=false`) vs forced-Targeted
(`ENABLED=true, RATE=1`) responses for all 4 allowed queries, same
`sessionId`, compared on `answer` text and each card's
`university_id`/`university_name`/`fact_bundle` -- byte-identical in all 4
cases.

**Kill switch**: live-verified both mechanisms independently. Starting from
a config where a specific session was actively canary-selected
(`targeted_primary`), restarting with `ENABLED=false` (RATE left at 1)
immediately reverted that same session to `flag_disabled`; restarting
instead with `RATE=0` (ENABLED left at true) immediately reverted it to
`canary_miss`. Both produced a normal HTTP 200 with a non-empty `answer`
and cards -- no code deploy involved, only an env var value + process
restart, which is the same mechanism a Vercel env var change + redeploy
would use. No-`sessionId` requests were separately confirmed to always
resolve to `no_stable_canary_key` (Legacy) even at `RATE=1`.

**Not live-reproduced this step (reported honestly rather than guessed)**:
`targeted_error`, `empty_result`, and the `validation_failed` branch that
depends on `resolveCandidateUniversityIds` diverging from the already-resolved
target (as opposed to its other trigger, `getUniversity()` returning
`undefined`) were not spontaneously produced by any of the 9 canonical
queries across ~50 live requests this step. Verified via code inspection
instead: (1) `resolveCandidateUniversityIds` is always called with
`providedUniversityIds: [targetId]` from this path, which short-circuits
before any filtering logic runs, so the candidate-mismatch trigger for
`validation_failed` is effectively unreachable via this call site today --
only the `!identity` trigger (a catalog entry whose id has no matching
`canonical_facts` rows, a data-hygiene edge case) is realistically
reachable; (2) the entire Targeted attempt body is wrapped in one
try/catch with no gaps, so any real exception becomes `targeted_error`
rather than an unhandled crash; (3) `empty_result` fires only if
`selectCards` returns zero cards for the single resolved target, which
requires the Planner-extracted hard filters (country/region) to actually
contradict the target's own country -- not something the 9 canonical
queries do. Deliberately did not fabricate live reproductions of these by
corrupting real catalog/database data. `unsupported_field` (the one
failure-branch reason that WAS live-reachable via a canonical query) was
confirmed live in configs C, D, and E.

**Not done in this step** (explicitly out of scope, per instruction):
production env vars left untouched (`vercelProductionEnvStatus:
"unverified"` -- no tool access to the actual Vercel dashboard this step;
only local `.env.local`-driven dev servers were used to simulate each
config), no merge to main, no recommendation/comparison/follow-up
expansion of the Targeted path, no removal of the Legacy path.

### Follow-up review found the "68 tests" report was a reporting artifact, plus two real gaps

**1. The step-3 completion report said 43+25=68 tests, but `npm test`
actually runs 174 across 9 sub-scripts covering all 14 `tests/*.test.ts`
files.** The 68 figure was never a real gap in test coverage -- it came
from only reading the tail of a truncated terminal capture (the earlier
`test:presenter`/`test:chat`/`test:reasoner`/`test:queryplan`/`test:scope`/
`test:searchconditions`/`test:aliases` sub-runs had already scrolled past
the visible window). Re-run and tallied every sub-script's own summary
line individually: 38+14+18+11+17+3+5+43+25 = 174 tests across 44 suites,
all passing -- confirmed against a baseline of 166 (the count before this
step's own 8 new distribution/gate tests were added to
`targeted-primary.test.ts`). Nothing is missing from the `npm test` chain;
every file in `tests/*.test.ts` is invoked by exactly one of the 9
sub-scripts.

**2. `targeted_error`/`empty_result`/`validation_failed` needed to be
reproduced for real, not just reasoned about from code.** Added a
dependency-injection seam (`TargetedPrimaryDeps` in `targeted-primary.ts`)
-- `resolveCandidateUniversityIds`/`queryRelevantUniversityFacts`/
`getUniversity`/`selectCards` can each be overridden per-call, defaulting
to the real implementations. route.ts's real, production call site never
passes overrides. A test-only header (`x-test-inject-targeted-fault`) is
only ever read when a dedicated env var, `CHAT_TEST_FAULT_INJECTION=true`,
is explicitly set -- **this var must never be added to Vercel's production
environment variables.** Deliberately not gated on `NODE_ENV === "test"`:
`next dev`/`next build`/`next start` force `NODE_ENV` to
`"development"`/`"production"` themselves regardless of what's passed on
the command line, so that gate could never actually be exercised against a
real running server. (A prior attempt to test this by importing route.ts
directly under plain `node --test` also failed outright --
`next/server`'s bare-specifier import can't be resolved by Node's strict
ESM loader outside Next's own bundler, the same constraint already
documented for `selection.ts`'s lazy import in `targeted-primary.ts` --
so this had to be verified live against a running dev server, the same
way as every other check in this document, not as a `node --test` unit
test.)

Live-verified via real HTTP requests against a dev server started with
`CHAT_TARGETED_PRIMARY_ENABLED=true`, `RATE=1`, `CHAT_TEST_FAULT_INJECTION=true`:
all three injected faults produced HTTP 200 with a real, non-empty Legacy
answer and cards, `targetedAttempted: true`, `targetedSucceeded: false`,
`legacyLoadTriggered: true`, `legacyLoadSkipped: false`, the exact expected
`fallbackReason` (`targeted_error:test-injected-targeted-error`,
`empty_result`, `validation_failed`), and `plannerCallCount: 1` (never
re-invoked). A control request with no injected fault still succeeded via
`targeted_primary` on the same server, confirming the harness itself is
valid rather than one that always falls back. Separately restarted the
server WITHOUT `CHAT_TEST_FAULT_INJECTION` set (otherwise identical) and
confirmed the same header is completely ignored -- the request still goes
through `targeted_primary` normally, proving the injection path is truly
inert by default.

**3. The pre-existing `[chat-v2] planner-plan` log wrote the raw client-sent
`sessionId`, not just its presence.** Found while checking the frontend
sessionId investigation's "로그에는 sessionId 원문을 남기지 않는가"
requirement -- this log line predates Phase 3B entirely but had never been
audited against that specific bar. Fixed: replaced the raw `sessionId`
field with `sessionKeyPresent: sessionId !== "unknown"`, the same boolean
signal `[chat-v2] targeted-primary` already uses. Verified live: sending
requests shaped exactly like `ChatbotWidget.tsx`'s real `fetch` call
(`Accept: application/x-ndjson`, same body fields) with real UUIDs, then
grepping the full server log for those literal UUID strings, found zero
matches in either log line.

**Frontend `ChatbotWidget.tsx` sessionId behavior** (`app/ui/ChatbotWidget.tsx`):
`sessionId` is `useState(() => crypto.randomUUID())` -- generated once per
component mount, held only in React state (no `localStorage`/
`sessionStorage`/cookie persistence anywhere in the file), and included in
every `send()` call's request body. The same value is reused for every
message within one mounted conversation (confirmed live: two sequential
widget-shaped requests with the same generated UUID both logged
`sessionKeyPresent: true` under the same conversation). The "새 대화" button
calls `resetChat()`, which calls `setSessionId(crypto.randomUUID())` --
a genuinely new, independent id. A full page reload also produces a new
sessionId (no persistence mechanism survives a reload), but this exactly
matches the existing behavior for the visible conversation itself (`messages`
state resets to the welcome screen on reload too) -- reload already meant
"start over" before this step, and sessionId regeneration is consistent
with that, not a new inconsistency introduced by canary work. Because the
real widget always sends a real UUID, `no_stable_canary_key` is not expected
to fire for genuine end-user traffic through the actual UI; it is the
correct, intended behavior only for non-UI callers that omit `sessionId`
entirely (`qa-runner.mjs`, curl, etc.).

**Full re-verification after these fixes**: `npm run build` (success),
`npm run lint` (0 errors, 1 pre-existing unrelated warning), `npm test`
(174/174, all 9 sub-scripts), `node qa-runner.mjs` against a default-env
dev server (32/32, unchanged), a live Targeted-flag-ON integration run
(`ENABLED=true, RATE=1`) against all 9 canonical queries (identical results
to the earlier config E run, including the corrected follow-up case
showing `followup_not_eligible`), and the widget-shaped sessionId
simulation above.

## Phase 3B step 4: compound-condition recommendation Targeted-primary canary

Branched from `origin/main` (Phase 3B step 2's merged state) -- Phase 3B
step 3 (production canary pre-preparation for the single-university path)
is a separate, still-unmerged branch and intentionally not a dependency of
this one. `targeted-primary.ts`, `route.ts`'s single-university fast path,
and their existing tests are untouched by this step.

**Scope**: region/country include-exclude, language test+score(+subscore),
deadline before/after/year/semester, housing available/guaranteed, major,
topN, and combinations of these -- recommendation queries only (no named
university resolved). Explicitly out of scope this step: named-university
comparisons (2+ resolved targets), follow-up re-ranking,
cost/quota/gpa/official-source-driven recommendations, and
course_restrictions-primary queries -- all of these still go through
Legacy, structurally enforced by `attemptTargetedRecommendation`'s own
eligibility gate, not left to intent alone.

**Architecture** (`app/lib/chat/targeted-recommendation.ts`): a SEPARATE
fast path from the single-university one, attempted after it (only when
the single-university path wasn't eligible or fell back), still before
`getChatUniversities()`'s full load. Candidate resolution is deliberately
narrow in what it excludes: `resolveComplexCandidateIds` only ever filters
by region/country (via the catalog's own `region`/`country` fields --
always-known, never an "unknown"-capable condition for any university), and
never narrows by language score, deadline date, housing, or major at the
SQL level. This makes candidate recall 100% **by construction** for a
request this path attempts, not something validated per-request against a
full legacy load (which would defeat the entire point of a pre-load fast
path) -- language/housing/deadline/major conditions are left for the
shared `evaluateUniversity`/`selectClassifiedCards`/`selectCards` to
classify AFTER hydration, exactly as Legacy does. No separate
Targeted-only evaluator or ranker exists anywhere in this file.

**Separate feature flags**: `CHAT_TARGETED_RECOMMENDATION_ENABLED` /
`CHAT_TARGETED_RECOMMENDATION_CANARY_RATE`, parsed identically to (but
read completely independently of) the single-university
`CHAT_TARGETED_PRIMARY_*` pair -- two separate `process.env` reads with no
shared state, so a problem in one is revertible without touching the
other (live-verified: flipping the recommendation flag off while the
single-university flag stays on doesn't touch it, by construction). The
canary key is also salted separately (`rec:${sessionId}` vs the raw
`sessionId`), so a session's two canary assignments are independent.

**Test-only fault injection**: a dependency-injection seam
(`TargetedRecommendationDeps`) mirroring Phase 3B step 3's mechanism for
the single-university path -- `resolveComplexCandidateIds`/
`queryRelevantUniversityFacts`/`fetchLegacyFallbackFields`/`selectCards`/
`selectClassifiedCards` can each be overridden per-call, defaulting to the
real implementations; route.ts's real call site never passes overrides.
Gated behind the same dedicated `CHAT_TEST_FAULT_INJECTION=true` env var
(never to be set in production) plus a request header
(`x-test-inject-recommendation-fault`), reusing the pattern already
established and documented for the single-university path.

**Live parity testing (14 canonical scenarios, Legacy-forced vs
Targeted-forced, same session per scenario)**: 12/14 matched exactly on
every deterministic card field (university_id, match_status,
condition_checks, unknown_fields, fact_bundle) -- the `answer` text itself
is excluded from this comparison since it includes the reasoner's
free-text narrative, which is not perfectly deterministic run-to-run even
for the identical question (a real LLM call). Two findings from the 2
non-matching scenarios:

**1. Real bug found and fixed**: `groundedRequestedFields` was preferring a
freshly re-computed `grounded.requestedFields.value` (from a second,
separate `groundPlannerFields` call inside this file) over the FINAL
`constraints.requestedFields` route.ts already computed -- whenever the
Planner's own raw plan claimed a broader requestedFields set than what the
question text actually grounds, this surfaced as an EXTRA fact_bundle
entry (e.g. `application_deadlines` appearing on a pure housing-guarantee
query with no deadline condition at all) that Legacy's own
`cards.ts::requestedFactBundle()` -- which always unions `primaryIntent`
with the FINAL `constraints.requestedFields`, never a separately-derived
value -- never showed for the identical constraints object. Fixed: always
union in `args.constraints.requestedFields` directly; `groundPlannerFields`
is still called (its `.issues` array is a legitimate, separate
`planner_grounding_issue` fallback trigger), just no longer used to
override which fields get fetched.

**2. Pre-existing data-shape inconsistency discovered, not introduced by
this step**: even after the fix above, scenario 4 ("기숙사 배정이 보장되는
대학을 추천해줘", no region filter -- the broadest, most scoring-sensitive
case) still shows a different pair of universities in its top-4 cutoff
between Legacy and Targeted. Both sides are independently, perfectly
stable across repeated runs (confirmed 20/20 identical on the Targeted
side) -- this is a deterministic scoring difference, not flakiness.
Root-caused live: at least one university's `ui_profile_json` blob stores
housing-guarantee status as `is_guaranteed: "Yes"` (a **string**), while
the structured `housing_facts` table stores the equivalent fact as
`housing_guaranteed: true` (a **boolean**). `scoreUniversity`'s
`housingQualitySignalScore` (and `evaluateUniversity`'s own guaranteed
check) test `row.is_guaranteed === true` -- strict equality, which never
matches the string `"Yes"`. Legacy prefers the blob's `housing_options`
over the structured table whenever the blob is non-empty (`asArray(profile
?.housing_options).length ? ... : ...` in `supabase.ts`'s
`exchangeProgram()`), so Legacy's own score for this university silently
loses the +4 "guaranteed" bonus that the SAME fact, read from the
structured table (as Targeted does), correctly grants -- shifting exactly
which universities land in a tight top-4 cutoff for a broad,
unscoped, housing-heavy query. This is a **pre-existing** latent
inconsistency between the two data sources this codebase has carried since
Phase 3A first introduced structured-table reads (the same class of issue
`computeShadowParity`'s `factValueParity` metric exists to catch, not
something Phase 3B step 4 created) -- confirmed the affected university IS
present with IDENTICAL fact_bundle content on both sides once the
candidate pool is narrowed (scenario 12, Europe-scoped, includes it
correctly in both), meaning **candidate recall and per-university
classification remain exact**; only the global, unscoped top-N ranking
cutoff can differ. Not fixed as part of this step (it is a Legacy-side
data-normalization gap unrelated to this file's own logic, and fixing it
risks changing Legacy's existing behavior for other callers without
separate, dedicated testing) -- flagged here and in the completion report
as a known, monitored caveat instead of silently ignored.

**Candidate-recall shadow observability** (`shadow-parity.ts`'s new
`computeComplexRecall`/`logComplexRecallParity`): computed inside the
existing Phase 3A shadow block (same `SHADOW_ENABLED`/`SHADOW_SAMPLE_RATE`
gate), independent of whether `CHAT_TARGETED_RECOMMENDATION_ENABLED` is
actually on -- this must be observable BEFORE ever raising the real canary
rate, not just after. Reuses `attemptTargetedRecommendation` itself
(forced `enabled: true, canaryRate: 1`) for the shadow-side computation
rather than a separate reimplementation, so the measurement can never
silently drift out of sync with the real path's own logic. Live-verified:
`candidateRecall: 1` for a real Europe+IELTS recommendation query with
shadow mode on and the real recommendation flag off.

**Repeat stability**: scenario 4 (기숙사 배정 보장, no region filter) and
scenario 7 (region+language+deadline+housing, the most condition-dense
combination) each run 20 times against the Targeted-forced path --
20/20 identical university IDs, order, and card count for both.

**Kill switch**: live-verified independently of the single-university
one -- a session actively canary-selected into `targeted_recommendation`
immediately reverted to `flag_disabled` after restarting with
`CHAT_TARGETED_RECOMMENDATION_ENABLED=false`, with a normal HTTP 200 and
the same 7 cards Legacy would produce for that query, no code deploy
involved.

**Not done in this step**: production env vars left untouched (defaults
still 0/off); no merge to main; no expansion to named-university
comparisons, follow-up re-ranking, or cost/quota/gpa/official-source
conditions; no removal of the Legacy path; the is_guaranteed
string-vs-boolean inconsistency found above was documented, not fixed.

## Phase 3B integration: merging steps 3 and 4, production fault-injection
## hard block, housing-guarantee normalization, candidate-recall hardening

Branched from `origin/main` (still Phase 3B step 2's merged state -- neither
step 3 nor step 4 had been merged yet). Merged `solar-pipeline-phase3b-
prod-canary-prep` (step 3) first (fast-forward, no conflicts against this
branch's base), then `solar-pipeline-phase3b-complex-canary` (step 4),
which conflicted in `route.ts` (5 regions: import block, the two
fault-injection-deps functions, a comment, and a trivial requestStart
comment) and `docs/decisions.md` (both branches' own new sections,
resolved by keeping both in sequence). `targeted-query.ts`,
`shadow-parity.ts`, `targeted-primary.ts`, `targeted-recommendation.ts`,
and both branches' test files auto-merged byte-identical to their source
branches (`diff --strip-trailing-cr` against each source branch's own
version came back empty) -- step 3 never touched targeted-query.ts, so
step 4's own version applied cleanly.

**Two silent-merge bugs found by re-reading the merged result, not by
git's own conflict markers** (git only flags textual overlaps -- these
were semantic breaks from two branches editing nearby-but-different lines
of the same growing function): (1) the recommendation-success call to
`buildFinalResponse` was missing the `requestStart` field step 3 had just
made required, which would have silently produced `NaN`/wrong
`totalResponseMs` for every successful complex-recommendation response --
fixed. (2) both fast paths' fault-injection blocks declared their own
`const testFaultReason` in the same function scope (a real
`Cannot redeclare block-scoped variable` TypeScript error, not silent, but
still a merge-only defect) -- the recommendation path's own variable
renamed to `recommendationTestFaultReason`.

### [2] Fault injection is now hard-blocked in production, not just gated by an env var that "should never be set"

`TEST_FAULT_INJECTION_ALLOWED` (route.ts) now requires
`process.env.NODE_ENV !== "production"` **in addition to**
`CHAT_TEST_FAULT_INJECTION === "true"` -- both the single-university and
recommendation fault-injection call sites were updated to read this one
shared, hardened constant (the single-university path had its own inline
`process.env.CHAT_TEST_FAULT_INJECTION === "true"` check pre-integration,
missing the production check entirely; now unified). Live-verified against
a REAL production build (`next build` + `next start`, which correctly sets
`NODE_ENV=production` -- unlike `next dev`, which always forces
`NODE_ENV=development` regardless of what's passed on the command line,
making this specific gate impossible to truly test under dev mode): with
`CHAT_TEST_FAULT_INJECTION=true` set AND the `x-test-inject-recommendation-
fault: targeted_error` header sent, the request still succeeded normally
via `targeted_recommendation` -- the fault was completely ignored, exactly
as required.

### [3] housing_guaranteed / is_guaranteed normalization -- shared, not Targeted-only

`normalizeTriStateFlag(value): boolean | undefined` (`app/lib/chat/
utils.ts`) is the single shared normalizer: `true/"true"/"yes"/"y"/1` ->
`true`; `false/"false"/"no"/"n"/0` -> `false` (case/whitespace-insensitive);
everything else (`null`, `undefined`, `""`, unrecognized strings/numbers)
-> `undefined` (unknown -- never coerced to `false`). Applied at the ONE
shared point both Legacy-hydrated and Targeted-hydrated `University`
objects converge -- `filters.ts`'s `housingQualitySignalScore`,
`passesStructuredFilters`, and `evaluateUniversity` -- rather than fixing
N separate data-sourcing paths; also applied in `present-fact.ts`'s
`presentHousingGuarantee` (the SAME bug existed in the university detail
page's own display logic, found while auditing this: `value === true`/
`value === false` against a possibly-string `is_guaranteed` silently fell
through to "확인 필요" for a real, known "Yes"/"No" fact). 15 new unit
tests (`tests/housing-guarantee-normalization.test.ts`) verify the
normalizer directly, that `evaluateUniversity`'s condition check is
source-shape-independent (a Legacy-shaped `is_guaranteed: "Yes"` row and a
Targeted-shaped `housing_guaranteed: true` row for the same real-world fact
produce byte-identical `condition_checks`), that `passesStructuredFilters`
recognizes both shapes, and that `presentHousingGuarantee` does too.

Confirmed via live re-test that scenario 12 ("기숙사 배정이 보장되는 유럽
대학을 추천해줘", Europe-scoped) now matches exactly between Legacy and
Targeted -- it did not before this fix (see step 4's own entry above).

**Root-causing scenario 4 further surfaced a SECOND, still-unresolved
ranking-cutoff difference** (see the 14-scenario table below) -- reported
honestly rather than claimed fixed. Direct inspection confirmed candidate
recall, match_status (matched/partial/excluded), and condition_checks are
byte-identical between Legacy and Targeted for every university in this
scenario; only which 2 of several apparently-equally-scored "matched"
universities land in the visible top-4 cutoff differs, and that
difference is itself perfectly stable/deterministic on EACH side
independently (confirmed 20/5 repeat runs on the Targeted/Legacy sides
respectively, always the same 2 winners on each side) -- meaning this is
not request-to-request noise, but a genuine, still-not-fully-identified
scoring divergence between the two paths for this one broad, unscoped,
housing-heavy query shape. Investigated and ruled out as the cause:
`housingQualitySignalScore` itself (recomputed by hand for all 4 candidate
universities on both the structured `housing_facts` table and the blob,
post-fix -- all four tie at the same 10 points on both sources), the
catalog (all 4 candidates are present), and `queryRelevantUniversityFacts`
row retrieval (directly reproduced the real 54-candidate housing fetch --
all 4 candidates' real fact rows are correctly retrieved, not silently
dropped by pagination/limits). The remaining hypothesis (an
`scoreUniversity` corpus/token-matching contribution from `summary`/
`profile_sections` differing between the two hydration paths for these
specific universities) was not confirmed within this step's time budget.
Not fixed -- flagged as a known, remaining caveat, not silently left
unmentioned.

### [4] Candidate recall: measured, not just claimed "100% by design"

The catalog's own `region` field (`deriveRegion`, university-catalog.ts) is
derived from `country` alone via the SAME shared `EUROPE_COUNTRIES`/
`ASIA_COUNTRIES`/`AMERICAS_COUNTRIES` sets `filters.ts`'s
`isEuropeanUniversity`/`isAsianUniversity`/`isAmericasUniversity` use (no
drift risk there -- confirmed only one definition exists, in `utils.ts`,
imported by both) -- **but `isEuropeanUniversity` is still strictly
broader**: it also falls back to matching known city/university-name text
(`paris|rennes|lyon|bristol|sheffield|...`) that `UniversityCatalogItem`
doesn't even carry a field for (no `city` field on the catalog item at
all). A university whose `country` the catalog can't classify into a
region, but whose city/name Legacy's own check WOULD recognize, could
previously have been silently excluded from Targeted's candidate pool by
an inclusive region filter -- a real, structural recall gap, not just a
hypothetical one, even though the CURRENT real catalog (54/54 universities)
happens to have `region` and `country` populated for every entry today
(verified live: `catalog.filter(c => !c.region).length === 0`,
`catalog.filter(c => !c.country).length === 0`).

Fixed in `filterCatalogByRegionCountry` (targeted-query.ts, shared by both
the single-university shadow candidate search and the complex-
recommendation path): an item whose `region`/`country` is UNKNOWN is now
NEVER excluded by an INCLUSIVE filter (previously it was -- `!(item.region
&& regions.has(item.region))` treated "unknown" the same as "known and not
matching"), only by an EXCLUSIVE filter matching a KNOWN, confirmed value.
Over-inclusion here can never produce a wrong final answer -- the shared
evaluator (which uses the more accurate check) still correctly filters out
any wrongly-included candidate later; only under-inclusion breaks recall.
7 new unit tests cover this directly with a catalog fixture carrying
`region: undefined`/`country: undefined` entries, confirming they survive
both inclusive and exclusive filters while a KNOWN-but-non-matching entry
is still correctly excluded (the fix is scoped to unknowns only, not a
blanket broadening).

**Actually measured `candidateRecall` (not just "1 by design")**: live,
via `[chat-v2] complex-recall-shadow` (`SHADOW_ENABLED=true`, real 54-
university dataset, real Planner calls) across 5 diverse real queries --
region-only (Europe), region+deadline (Asia-excluded + date), housing-only,
housing-guarantee-only, and country+language (UK + IELTS) -- all 5 reported
`candidateRecall: 1` (100%). This is the real, measured value against the
CURRENT dataset, not an assumption; it would need re-measurement if the
catalog's region/country completeness ever changed.

### [5] Final pipeline-completion log (not a new log name -- the existing one, enriched)

Rather than adding a parallel log, `[chat-v2] pipeline` (v2Response,
already fires at response completion with an accurate `reasonerCallCount`
-- unlike the earlier `[chat-v2] targeted-primary`/`targeted-recommendation`
decision-time logs, which fire strictly BEFORE the reasoner is ever
invoked and so can only ever report 0 for it) now also carries:
`selectedPath`, `targetedAttempted`, `targetedSucceeded`,
`legacyLoadTriggered`, `legacyLoadSkipped`, `fallbackReason`,
`plannerCallCount`, `candidateCount`, `candidateRecall`, `targetedQueryMs`,
`legacyQueryMs` (alongside its existing `requestId`/`reasonerCallCount`/
`totalResponseMs`). A `PipelineDecisionSummary` object is threaded through
`buildFinalResponse` -> `v2Response`, constructed at each of the 3 outcome
sites: single-university success (`candidateCount: 1, candidateRecall: 1`
-- one already-confirmed target, not a multi-candidate recall claim in the
same sense the recommendation path means it), recommendation success
(`candidateRecall: 1`, guaranteed by construction for a request the path
actually attempted -- the independently MEASURED value, when available, is
the separate `[chat-v2] complex-recall-shadow` log, not this field), and
Legacy fallback (picks whichever of the two fast-path results is
structurally authoritative for the request shape --
`catalogExactTargetIds.length === 0` prefers the recommendation path's own,
more specific reason over the single-university path's generic
`not_single_target`; any resolved target count prefers the other way --
`candidateRecall: null` here, since recall's "guaranteed by construction"
claim only applies to a successful attempt). Live-verified against a real
production build: a successful recommendation response's final pipeline
log showed `reasonerCallCount: 1` (correct, non-zero) alongside
`selectedPath: 'targeted_recommendation'`, `candidateCount: 34`,
`candidateRecall: 1`; a fallback response (unsupported_condition) showed
`candidateRecall: null`, `legacyQueryMs: 357` (the real value).

### [6] Full suite count after integration

`npm test` now includes 174 (step 3) + 35 (step 4) tests already counted
once each (they don't overlap -- step 3 only touched
targeted-primary.test.ts, step 4 only added targeted-recommendation.test.ts)
plus this integration step's own 15 (housing-guarantee-normalization) + 7
(candidate-recall edge cases, added inside targeted-recommendation.test.ts)
new tests. See the completion report for the exact final suite-by-suite
count and an explanation of any arithmetic difference from a naive 166+8+35
sum (the instruction's own estimate already flagged this might not land
exactly on 209, and asked for an explained count rather than a pass/fail
against that specific number).

### Live-verified flag-combination matrix

All of: both flags off, single-only on, recommendation-only on, both on,
both canary rates 0, both canary rates 1, and a request with no
`sessionId` -- confirmed each flag is read from its own independent
`process.env` var with no shared state (a session's single-university
canary assignment and its recommendation canary assignment are
independently salted, `sessionId` vs `` `rec:${sessionId}` ``), and that
disabling one flag never affects the other's own eligibility/canary
decision for the same request.

**Not done in this step**: production env vars left untouched (still
0/off by default); no merge to main; the integration branch itself was
pushed to origin, not merged; Legacy path untouched and still fully
functional (confirmed via the same 14-scenario Legacy-forced capture used
for parity comparison); the scenario 4/6 residual ranking-cutoff
difference was investigated but not fully resolved.
