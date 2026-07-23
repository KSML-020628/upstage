# Exchange Atlas

A chatbot and browsing site for SKKU (Sungkyunkwan University) students
researching outgoing exchange programs -- university requirements, language
scores, housing, deadlines, quotas, and costs -- backed by structured data in
Supabase and explained by Upstage Solar Pro 3.

## Stack

- Next.js 16 (App Router, Turbopack), React 19, TypeScript
- Supabase (Postgres via REST) for exchange-program fact tables
- Upstage Solar Pro 3 for query planning and answer explanation, with a
  deterministic (non-LLM) fallback for every answer path

## Prerequisites

- Node.js `>=22.13.0`
- A Supabase project with the exchange-program schema (universities,
  `language_requirements`, `housing_facts`, `cost_facts`,
  `application_deadlines`, `extracted_facts`, ...)
- An Upstage API key (optional -- the chatbot still answers without one,
  using only the deterministic templates)

## Quick Start

```bash
npm install
cp .env.example .env.local   # fill in Supabase + Upstage credentials
npm run dev
npm run build
```

## Environment Variables

See `.env.example` for the full list and inline explanations. Key ones:

- `SUPABASE_SERVICE_ROLE_KEY` -- without it, `/api/chat` silently falls back
  to thinner evidence (`ui_profile_json` only) with no visible warning.
- `SOLAR_PLANNER_MODE` -- `shadow` (default) calls the Solar planner but
  discards its output, using the regex-based constraint detector instead;
  `active` applies the planner's parsed conditions.
- `SOLAR_REASONING_EFFORT` -- keep at `minimal` (default) unless you've
  raised `max_tokens` in `query-plan.ts`/`reasoner.ts` and re-verified; see
  the comment in `.env.example` for measured failure modes at higher levels.

## How answers are produced

`app/api/chat/route.ts` orchestrates the request; the actual logic lives in
`app/lib/chat/`:

- `constraints.ts` -- regex-based parsing of a question into structured
  filters (region, language score, GPA, housing, deadline, quota, ...),
  plus conversation-memory folding across turns
- `filters.ts` -- evaluates a university against those filters (cost
  estimation, language/GPA/quota/deadline matching)
- `selection.ts` -- resolves which universities a question is actually
  about and ranks/classifies candidates
- `cards.ts` / `sources.ts` -- builds the evidence shown per university and
  resolves citation links
- `answers.ts` -- deterministic Korean-language answer templates (these are
  authoritative; Solar's own text is explanatory, not a source of truth)
- `query-plan.ts` / `reasoner.ts` -- the optional Solar Pro 3 calls
  (structured-output query planning and answer explanation), each with a
  manual validator that strips anything not grounded in the actual question
  or evidence

Every fact-to-string conversion goes through `app/lib/display/present-fact.ts`
-- see `CLAUDE.md` for the display-layer rules this project enforces.

## Testing

```bash
npm test              # unit tests: presenter + chat-policy
node qa-runner.mjs     # 32-scenario live regression harness against a running dev server
```

`qa-runner.mjs` drives `/api/chat` through scripted multi-turn conversations
and checks both answer correctness and display-layer hygiene (no leaked raw
data, no bilingual duplication, no unfolded ranges, ...). Run it against
`npm run dev` before merging any change to the chat pipeline. Use
`QA_DELAY_MS` to slow it down if you hit the server's own rate limiter
(10 requests/60s per IP) while testing.

## Useful Commands

- `npm run dev` -- start local development
- `npm run build` -- production build
- `npm run lint` -- eslint
- `npm run db:generate` -- generate Drizzle migrations (unused by this
  project's actual data layer, which reads Supabase directly; kept for the
  empty `db/schema.ts` scaffold inherited from the starter template)
