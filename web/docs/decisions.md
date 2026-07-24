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
