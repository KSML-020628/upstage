# Solar Pro 3 usage notes

Working notes on how this project actually calls Upstage's API, and the
evidence behind the current config. Keep this updated when the numbers below
change -- don't let it drift into guesswork like the things it corrects.

## Groundedness Check -- cancelled

Investigated as a candidate integration; cancelled. Confirmed via a live
`GET /v1/models` call (2026-07-23) that no groundedness-series model exists
in the account's available models:

```
solar-pro3, solar-pro3-260323, solar-pro2, solar-pro2-251215,
solar-mini, solar-mini-250422, syn-pro, syn-pro-251021
```

This is consistent with an earlier finding this session that the current
`langchain-upstage` package no longer exports any groundedness-related class,
and that Upstage's own agent-facing API reference
(`console.upstage.ai/api/docs/for-agents/raw`) documents only Chat
Completions, Embeddings, document processing, and agent APIs -- no dedicated
Groundedness Check endpoint. Do not re-propose this without first checking
whether Upstage has reintroduced it.

## SOLAR_PLANNER_MODE

Default is `active` (see `resolvePlannerMode()` in
`app/lib/chat/planner-integration.ts`). `shadow` is an explicit opt-out that
skips the planner call entirely (no Solar cost) and searches on the
regex-based `detectConstraints()` result alone. Previously the default was
`shadow`, but the planner call still ran on every in-scope request and its
result was simply discarded -- full Solar cost, zero effect on the answer.

Verified with 3 real questions after flipping the default (see
`[chat-v2] planner-plan` / `[chat-v2] selection` logs) that the planner's
output genuinely reaches the final filters in `active` mode:

- "아이엘츠 6.0으로 갈 수 있는 유럽 대학 알려줘" -> `differences: ["limit:4->5"]`,
  the planner's suggested result count was applied.
- "University of Sheffield의 교환학생 어학 조건을 알려줘" ->
  `targetResolution: "solar_planner"`, the planner (not the regex name
  matcher) resolved which university to search.
- "핀란드 대학 중 기숙사 정보가 있고 IELTS 6.5로 지원 가능한 곳을 알려줘" ->
  `differences: ["intent:housing->general", "limit:4->5"]`, the planner
  corrected the regex's naive "housing" intent guess to "general" (a
  combined housing+language recommendation), and it was applied.

## reasoning_effort: full 4-level x 5-question x 3-repeat measurement (2026-07-23)

This is the deciding measurement for `SOLAR_REASONING_EFFORT`. Run against a
local dev server, one level at a time (server restarted between levels),
current code (post the [1] clarification-gate fix above, so all 5 questions
reach the real planner+reasoner pipeline instead of being intercepted by a
regex gate). `max_tokens` was 16,000 (planner) / 20,000 (reasoner) throughout
-- the same values used in production. Questions:

1. "IELTS 6.0으로 지원 가능한 유럽 대학 3개"
2. "학점 3.5인데 기숙사 보장되는 곳만 알려줘"
3. "University of Helsinki 어학 조건이랑 마감일 같이 보여줘"
4. "아시아 빼고 2026-05-01 이후 마감인 대학"
5. "헬싱키랑 브리스톨 마감일 비교해줘"

### Per-call results

Times are planner / reasoner elapsed ms measured server-side around each
`fetch` call. "fallback" = `fallbackUsed` in the response (reasoner did not
produce usable output; the deterministic template answered instead).

**minimal** (reasoning disabled; `hasReasoningField: false`, 0 reasoning
tokens on every call, confirmed from the raw API response)

| q | rep1 (planner/reasoner) | rep2 | rep3 | fallback |
|---|---|---|---|---|
| 1 | 1819/6259 | 1828/5515 | 1638/6384 | none |
| 2 | 1723/6216 | 1820/5225 | 2909/5860 | none |
| 3 | 1916/3312 | 1729/2728 | 1779/3313 | none |
| 4 | 3320/5852 | 2310/n/a (0 cards*) | 1658/1213 | none |
| 5 | 1934/3615 | 1803/3118 | 1983/3344 | none |

**low** (reasoning disabled; same as minimal -- `low` and `minimal` both
disable reasoning per Upstage's spec, confirmed identical here)

| q | rep1 | rep2 | rep3 | fallback |
|---|---|---|---|---|
| 1 | 2488/10355 | 1665/10333 | 1801/10098 | none |
| 2 | 1976/5695 | 1813/5603 | 1807/5797 | none |
| 3 | 2227/2075 | 1858/3873 | 1983/2482 | none |
| 4 | 1820/1014 | 1779/1689 (only 1 card*) | 1842/984 | none |
| 5 | 2006/3116 | 1788/3499 | 2470/2340 | none |

**medium** (reasoning enabled; `hasReasoningField: true`, 397-1959 reasoning
tokens observed)

| q | rep1 | rep2 | rep3 | fallback |
|---|---|---|---|---|
| 1 | 6696/15613 | 20019/n/a (0 cards*) | 11996/n/a (0 cards*) | none of these 3 |
| 2 | 8498/25017 | 6549/16036 | 7404/16314 | **rep1: reasoner timeout** |
| 3 | 5487/5863 | 4506/6595 | 5260/5369 | none |
| 4 | 8202/25007 | 5571/25004 | 6876/25013 | **all 3: reasoner timeout** |
| 5 | 7902/9426 | 9497/12207 | 4693/10743 | none |

**high** (reasoning enabled; `hasReasoningField: true`, 385-1611 reasoning
tokens observed)

| q | rep1 | rep2 | rep3 | fallback |
|---|---|---|---|---|
| 1 | 20018/n/a (0 cards*) | 4750/25008 | 5896/19501 | **rep2: reasoner timeout** |
| 2 | 6747/25017 | 9347/25017 | 10236/15562 | **rep1, rep2: reasoner timeout** |
| 3 | 8727/8612 | 5156/8419 | 6926/5832 | none |
| 4 | 9935/25021 | 8358/25007 | 10835/25008 | **all 3: reasoner timeout** |
| 5 | 6286/11362 | 7807/8741 | 6660/16756 | none |

\* "0 cards" / "only 1 card instead of 5" on q4 happened at **every** effort
level including `minimal`, not just at higher effort -- this is the planner's
own run-to-run non-determinism on this particular question (excluded-region
+ deadline-comparator combination), the same class of issue as the
`ieltsMax`/`ieltsMinimumSubscore` bug found and fixed earlier this session.
Worth a follow-up look at q4's prompt handling specifically, independent of
the reasoning_effort decision below.

### Aggregate findings

- **Reliability**: 0/15 fallbacks at `minimal`, 0/15 at `low`, **4/14** valid
  attempts (28.6%) at `medium`, **6/14** valid attempts (42.9%) at `high`.
  Every single fallback was `"The operation was aborted due to timeout"` --
  **zero json_schema parsing failures observed across all 60 calls**, at any
  effort level. The strict schema itself is reliable; the only failure mode
  is the reasoner (never the planner, in this run) not finishing inside the
  25s budget when reasoning is enabled.
- **Latency**: planner alone goes from ~1.6-3.3s (`minimal`) to ~4.5-20s
  (`medium`/`high`, occasionally hitting its own 20s cap). Reasoner goes from
  ~1.2-6.4s to frequently pinning at the 25s cap.
- **No reasoning field leak**: confirmed structurally (`query-plan.ts` and
  `reasoner.ts` only ever read `.message.content`, never `.message.reasoning`
  -- there is no code path that could forward it) and empirically (inspected
  a successful `high`-effort response body directly; `shortAnswer` and
  `detailedAnswer` contained only the expected structured Korean template
  text, no reasoning trace).
- **No answer-quality difference observed**: `plannerIssues` (which
  conditions got grounded/rejected) were identical for the same question
  across all 4 effort levels -- e.g. q2's `["gpaScale_not_grounded",
  "limit_clamped"]` appeared at `minimal`, `low`, and `medium` alike. The
  planner extracts the same conditions regardless of effort; what changes is
  latency and failure rate, not extraction accuracy. Combined with the fact
  that the actually-displayed answer is built by the deterministic templates
  in `answers.ts` (the reasoner's own text is only ever used for a sanitized,
  validated `shortAnswer` in specific branches), there is no user-visible
  quality gain measured at any effort level above `minimal`.

### Decision: keep `SOLAR_REASONING_EFFORT=minimal` as the default

0% failure rate vs. 29-43% at medium/high (with the current, already-generous
20s/25s budget), no measured quality benefit, and the one real difference
(reasoning tokens spent) never reaches the user either way. Raising effort
here would only trade reliability and latency for nothing observable.

### Timeout / maxDuration: unchanged

Worst-case *total* time across all 60 calls was 35.9s (`high`, q4 rep3),
still under the 45s (20s + 25s) planner+reasoner budget and the 60s
`maxDuration` in `vercel.json`. The 20s/25s/60s numbers were sized as
headroom for exactly this kind of occasional slow call, not as a target --
they don't need to change. If `SOLAR_REASONING_EFFORT` is ever raised above
`minimal` in the future, re-run this same measurement first: at `medium`/
`high` the reasoner already pins at its 25s cap on a meaningful fraction of
calls, so any further latency growth (larger evidence packets, a slower API
day) would need a larger budget than what's configured today.
