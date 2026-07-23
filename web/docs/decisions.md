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
