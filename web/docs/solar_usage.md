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

## Measured latency (reasoning_effort=minimal, the default)

Same 3 questions, full `/api/chat` round trip including the Supabase fetch,
planner call, and reasoner call, against a local dev server:

| question | total time |
|---|---|
| 아이엘츠 6.0 유럽 대학 | 6.4s |
| Sheffield 어학 조건 | 4.2s |
| 핀란드 기숙사+IELTS 6.5 | 2.5s |

## Timeout budget

`query-plan.ts`'s planner call and `reasoner.ts`'s reasoner call run
**sequentially** in the same request (planner first, in `handleChatRequest`;
reasoner second, in `v2Response`). Their `AbortSignal.timeout` values and
`vercel.json`'s `functions["app/api/chat/route.ts"].maxDuration` must be
sized together, or the platform can hard-kill the function before either
Solar call's own timeout fires -- the user sees a raw platform timeout page
instead of this app's graceful deterministic-template fallback.

Current budget: planner 20s + reasoner 25s = 45s worst case, inside the 60s
`maxDuration`. Real measured latency above is 2-6s; this is headroom for a
slow response, not a target.

`reasoning_effort` above the default `minimal` changes this materially --
tested with `medium`/`high` and found:

- `reasoning_effort=high` on the planner repeatedly exceeded even a (then-)
  90s `AbortSignal.timeout` and fell back to the regex path anyway, after
  burning 90-116s and a wasted Solar call.
- Reasoning token usage varies call to call at the same effort level even at
  `temperature: 0` (383 vs 899 tokens seen for an identical prompt) -- this
  isn't a one-time edge case.
- No answer-quality improvement has been measured to justify the added
  cost/latency.

Do not raise `SOLAR_REASONING_EFFORT` above `minimal` without re-measuring
end-to-end latency and re-deriving the timeout/maxDuration budget above --
the 20s/25s/60s numbers here assume `minimal`.
