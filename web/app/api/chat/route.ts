import { NextResponse } from "next/server";
import type { University } from "../../lib/types";
import { createEvidencePacket } from "../../lib/chat/evidence-packet";
import { runSolarPlanner, type PlannerRun } from "../../lib/chat/query-plan";
import { catalogToKnownUniversityNames, getUniversityCatalog } from "../../lib/chat/university-catalog";
import { groundPlannerFields } from "../../lib/chat/planner-grounding";
import {
  countTotalFactRows,
  fetchLegacyFallbackFields,
  hydrateUniversitiesFromCatalog,
  queryRelevantUniversityFacts,
  resolveCandidateUniversityIds,
} from "../../lib/chat/targeted-query";
import { computeShadowParity, logShadowParity } from "../../lib/chat/shadow-parity";
import { attemptTargetedFastPath } from "../../lib/chat/targeted-primary";
import { runSolarReasoner } from "../../lib/chat/reasoner";
import { universityNamesFromAliases } from "../../lib/chat/university-aliases";
import { findCardsMissingFromAnswer, isPromptInjectionRequest } from "../../lib/chat/chat-policy";
import {
  deterministicClassifiedAnswer,
  deterministicDeadlineAnswer,
  deterministicDirectCostAnswer,
  deterministicFactAnswer,
  deterministicGeneralAnswer,
  deterministicRequestedFieldsAnswer,
  deterministicRestrictionAnswer,
  collectSources,
  restrictionEvidence,
  responsePresentation,
  sanitizeGeneratedAnswer,
  searchMode,
} from "../../lib/chat/answers";
import { attachRecommendationExplanations, composeShortAnswer } from "../../lib/chat/short-answer";
import {
  detectConstraints,
  detectConversationConstraints,
  isConservativeChitchat,
  isCostOfLivingIndexQuestion,
  isRemovedCostRecommendation,
} from "../../lib/chat/constraints";
import {
  applyValidatedPlannerPlan,
  followupOrdinal,
  plannerDifferences,
  resolvePlannerMode,
  resolveReasoningEffort,
} from "../../lib/chat/planner-integration";
import {
  costOfLivingResponse,
  describeConditionsForClarification,
  clarificationResponse,
  needsFollowupScopeClarification,
  needsTargetClarification,
  removedCostFeatureResponse,
  safePromptInjectionResponse,
  unsupportedDataResponse,
} from "../../lib/chat/responses";
import {
  explicitUnknownInstitution,
  findTargetUniversities,
  followupComparisonLimit,
  isFollowupReference,
  previousContextUniversities,
  selectCards,
  selectClassifiedCards,
  unknownInstitutionResponse,
} from "../../lib/chat/selection";
import { hasActionableSearchConditions, hasRecommendationConditions } from "../../lib/chat/search-conditions";
import { getChatUniversities, refreshCurrencyRatesInBackground } from "../../lib/chat/supabase-facts";
import type { ChatMessage, Intent, QueryConstraints, ResultCard } from "../../lib/chat/types";

export const runtime = "nodejs";

const MAX_MESSAGES = 8;
const MAX_MESSAGE_LENGTH = 2000;
const RATE_LIMIT_WINDOW_MS = 60_000;
// The bucket key falls back to a single shared "anonymous" id whenever
// x-forwarded-for is absent (isRateLimited below) -- true for every request
// against a local `next dev` server, since there's no reverse proxy setting
// that header. That collapses ALL local requests (real users during
// development, and qa-runner's 32-scenario regression suite) into one
// bucket, so qa-runner's sequential run started hitting 429s partway through
// even at a deliberate 800ms delay between requests (confirmed live: the
// standard `node qa-runner.mjs` run stalled on 429 retries for roughly two
// thirds of its 32 turns). The strict per-client limit is a production
// abuse guard, not something qa-runner's single, trusted, sequential process
// should be measured against -- explicitly relaxed here for anything that
// isn't a production build, rather than making qa-runner slow enough to
// stay under it (which would still be one shared bucket, just slower).
const RATE_LIMIT_REQUESTS = Number(process.env.CHAT_RATE_LIMIT_REQUESTS)
  || (process.env.NODE_ENV === "production" ? 10 : 1000);

// Phase 3A.2: the Targeted Query Builder's shadow comparison is off by
// default in every environment, including this one -- it must be turned on
// deliberately (CHAT_TARGETED_SHADOW_ENABLED=true), not merely by having a
// validatedPlan available. Even when enabled, CHAT_TARGETED_SHADOW_SAMPLE_RATE
// (0-1, default 1) caps what fraction of eligible requests actually pay the
// extra query cost, so production observation doesn't mean doubling query
// load on every single chat request.
const SHADOW_ENABLED = process.env.CHAT_TARGETED_SHADOW_ENABLED === "true";
const SHADOW_SAMPLE_RATE = Math.min(1, Math.max(0, Number(process.env.CHAT_TARGETED_SHADOW_SAMPLE_RATE) || 1));

// Phase 3B step 1: unlike the shadow flags above, this one can change what
// a real user sees, so it defaults doubly safe -- both the flag AND the
// canary rate must be explicitly set for any real traffic to be routed to
// the Targeted Query Builder. Flipping CHAT_TARGETED_PRIMARY_ENABLED=true
// alone (with no rate configured) still sends 0% of eligible traffic
// through it, unlike the shadow sample rate's default-1 posture -- primary-
// path traffic needs both dials turned deliberately, not just one.
const TARGETED_PRIMARY_ENABLED = process.env.CHAT_TARGETED_PRIMARY_ENABLED === "true";
const TARGETED_PRIMARY_CANARY_RATE = Math.min(1, Math.max(0, Number(process.env.CHAT_TARGETED_PRIMARY_CANARY_RATE) || 0));

// Inverse of constraints.ts's REQUEST_FIELD_TO_INTENT -- the Phase 3A.1
// shadow query needs to know which fact table the PRIMARY intent alone
// implies, since cards.ts's own requestedFactBundle() always fetches that
// field regardless of whether constraints.requestedFields lists it.
const INTENT_TO_REQUESTED_FIELD: Partial<Record<Intent, string>> = {
  general: "universities",
  language: "language_requirements",
  housing: "housing_options",
  cost: "estimated_costs",
  deadline: "application_deadlines",
  quota: "quota_facts",
  restriction: "course_restrictions",
  source: "source_links",
};

const requestBuckets = new Map<string, { count: number; resetAt: number }>();

function isChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    (item.role === "user" || item.role === "assistant") &&
    typeof item.content === "string" &&
    item.content.trim().length > 0 &&
    item.content.length <= MAX_MESSAGE_LENGTH
  );
}

function isRateLimited(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const clientId = forwarded || "anonymous";
  const now = Date.now();
  const bucket = requestBuckets.get(clientId);

  if (!bucket || bucket.resetAt <= now) {
    requestBuckets.set(clientId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }

  bucket.count += 1;
  if (requestBuckets.size > 500) {
    for (const [key, value] of requestBuckets) {
      if (value.resetAt <= now) requestBuckets.delete(key);
    }
  }
  return bucket.count > RATE_LIMIT_REQUESTS;
}

async function v2Response(args: {
  requestId: string;
  question: string;
  cards: ResultCard[];
  detailedAnswer: string;
  planner: PlannerRun;
  factTablesDegraded: boolean;
  runReasoner: boolean;
  shortAnswerOverride?: string;
  extra?: Record<string, unknown>;
}) {
  const apiKey = process.env.UPSTAGE_API_KEY;
  const model = process.env.UPSTAGE_CHAT_MODEL || "solar-pro3";
  const evidenceCards = args.cards.map((card) => ({ ...card, match_status: card.match_status ?? "matched" as const }));
  const packet = createEvidencePacket(args.question, args.planner.validatedPlan, evidenceCards);
  // Simple single-target lookups ("Sheffield IELTS 몇점이야?") don't need the
  // reasoner's comparative narrative -- the deterministic template already
  // says everything there is to say, so skip a Solar call (and its latency)
  // that would only ever get discarded. See docs/decisions.md.
  const emptyStats = { generated: 0, accepted: 0, rejected: 0 };
  // This is the ONLY runSolarReasoner call site in this file -- reasonerCallCount
  // is tracked explicitly and logged below so that's independently auditable
  // from real request logs, same as plannerCallCount in handleChatRequest.
  const willCallReasoner = Boolean(apiKey) && args.runReasoner;
  const reasonerCallCount = willCallReasoner ? 1 : 0;
  const reasoner = willCallReasoner
    ? await runSolarReasoner({ apiKey: apiKey!, model, packet, reasoningEffort: resolveReasoningEffort() })
    : { output: null, usedSolar: false, issues: [apiKey ? "reasoner_not_needed" : "missing_api_key"], recommendationStats: emptyStats };
  const presentation = responsePresentation(args.detailedAnswer, args.cards);
  // Only the reasoner's own text needs this pass -- presentation.shortAnswer
  // is always a deterministic template and never contains a placeholder like
  // "XXX"/"TBD" to begin with.
  const narrative = reasoner.output?.shortAnswer ? sanitizeGeneratedAnswer(reasoner.output.shortAnswer) : "";
  const cardsWithExplanation = attachRecommendationExplanations(args.cards, reasoner.output?.recommendations ?? []);

  const { shortAnswer, source: shortAnswerSource } = composeShortAnswer({
    cards: cardsWithExplanation,
    narrative,
    shortAnswerOverride: args.shortAnswerOverride,
    deterministicShortAnswer: presentation.shortAnswer,
  });

  console.info("[chat-v2] pipeline", {
    planner: args.planner.usedSolar,
    plannerMode: resolvePlannerMode(),
    plannerIssues: args.planner.issues,
    evidenceUniversities: packet.universities.length,
    evidenceFacts: packet.universities.reduce((sum, item) => sum + item.facts.length, 0),
    reasoner: reasoner.usedSolar,
    reasonerIssues: reasoner.issues,
    reasonerCallCount,
  });
  // Split into three distinct observability signals instead of one
  // "reasonerDisplayed" bit -- they can legitimately disagree (e.g. Solar's
  // free-text narrative gets suppressed by a partial-match name-leak guard
  // while per-university explanations still attach fine, or a validated
  // explanation is attached but its card falls outside this response's final
  // card set), and collapsing them hid which stage actually lost the value.
  const attachedRecommendationCount = reasoner.output?.recommendations.filter((item) => item.explanation).length ?? 0;
  const cardExplanationsDisplayed = cardsWithExplanation.filter((card) => card.ai_explanation).length;
  console.info("[chat-v2] short-answer-source", {
    requestId: args.requestId,
    source: shortAnswerSource,
    reasonerCalled: args.runReasoner && Boolean(apiKey),
    reasonerAccepted: reasoner.usedSolar,
    shortNarrativeDisplayed: shortAnswerSource === "server_plus_solar" || shortAnswerSource === "solar_reasoner",
    cardExplanationsAttached: attachedRecommendationCount,
    cardExplanationsDisplayed,
  });
  // Solar's actual adoption rate for the stricter per-cited-fact grounding
  // added in Phase 2.5 -- rejectionReasons is the subset of issues tagged
  // with a universityId (":<id>"), i.e. actual per-recommendation rejections,
  // not packet-level issues like "unsafe_short_answer" or "reasoner_not_needed".
  console.info("[chat-v2] reasoner-recommendations", {
    requestId: args.requestId,
    recommendationsGenerated: reasoner.recommendationStats.generated,
    recommendationsAccepted: reasoner.recommendationStats.accepted,
    recommendationsRejected: reasoner.recommendationStats.rejected,
    rejectionReasons: reasoner.issues.filter((issue) => issue.includes(":")),
    fallbackExplanationsUsed: cardsWithExplanation.length - cardExplanationsDisplayed,
  });

  return NextResponse.json({
    ...presentation,
    shortAnswer,
    cards: cardsWithExplanation,
    sources: collectSources(cardsWithExplanation),
    unknown_fields: packet.unknownFields,
    suggestedDetailTab: reasoner.output?.suggestedDetailTab,
    solarUsed: { planner: args.planner.usedSolar, reasoner: reasoner.usedSolar },
    plannerMode: resolvePlannerMode(),
    fallbackUsed: !reasoner.usedSolar,
    factTablesDegraded: args.factTablesDegraded,
    pipelineStages: ["planning", "searching", "validating", "reasoning"],
    ...args.extra,
  });
}

// Phase 3B step 2: this is the SAME response-construction branching that
// always ran at the end of handleChatRequest, extracted unchanged so BOTH
// the fast, no-full-load Targeted path and the legacy full-load fallback
// path can call it -- neither needs the raw universities[] array, only the
// already-built cards/classified/constraints/intent, so extraction requires
// no behavior change, just a shared call site instead of one inline block.
async function buildFinalResponse(args: {
  requestId: string;
  question: string;
  intent: Intent;
  constraints: QueryConstraints;
  cards: ResultCard[];
  classified: ReturnType<typeof selectClassifiedCards> | undefined;
  planner: PlannerRun;
  factTablesDegraded: boolean;
  runReasoner: boolean;
}) {
  const { requestId, question, intent, constraints, cards, classified, planner, factTablesDegraded, runReasoner } = args;

  if (!cards.length) {
    return NextResponse.json({
      answer: "### 검색 결과\n\n질문 조건을 모두 확인할 수 있는 대학을 찾지 못했습니다.\n\n- 미확인 값을 조건 충족으로 간주하지 않았습니다.\n- 조건을 줄이거나 특정 대학을 지정하면 확인된 정보부터 안내할 수 있습니다.",
      cards: [],
      sources: [],
      searchMode: "Supabase 구조화 필드 필터링 결과 없음",
    });
  }

  if (classified) {
    const detailedAnswer = constraints.requestedFields.length > 1
      ? [
          deterministicClassifiedAnswer(classified.matched, classified.partiallyMatched),
          deterministicRequestedFieldsAnswer(cards, constraints.requestedFields),
        ].join("\n\n")
      : deterministicClassifiedAnswer(classified.matched, classified.partiallyMatched);
    // deterministicClassifiedAnswer always names every matched/partial card,
    // so this should never find anything -- it exists to catch a future
    // change to that template silently dropping a card's name, which would
    // otherwise ship unnoticed (chat-policy.ts warns against unused
    // safeguards; this is the same check kept from becoming one).
    const missingFromAnswer = findCardsMissingFromAnswer(cards, detailedAnswer);
    if (missingFromAnswer.length) {
      console.warn("[chat-v2] card missing from classified answer text", missingFromAnswer.map((card) => card.university_id));
    }
    return v2Response({
      question,
      cards,
      detailedAnswer,
      planner,
      factTablesDegraded,
      requestId,
      runReasoner,
      extra: {
        matched: classified.matched,
        partially_matched: classified.partiallyMatched,
        excluded_count: classified.excluded.length,
        searchMode: "Supabase 구조화 조건 판정(충족/부분 확인/미충족)",
      },
    });
  }

  if (intent === "source") {
    const sources = collectSources(cards);
    const detailedAnswer = sources.length
      ? [
          "### 공식 출처",
          "",
          ...sources.map((source) => `- **${source.university_name || "대학"}**: [${source.title}](${source.url})`),
        ].join("\n")
      : ["### 공식 출처", "", "현재 등록된 자료에서 연결 가능한 공식 출처를 찾지 못했습니다."].join("\n");
    const shortAnswer = sources.length
      ? sources.slice(0, 3).map((source) => `- [${source.university_name || source.title} 공식 출처](${source.url})`).join("\n")
      : "현재 등록된 자료에서 연결 가능한 공식 출처를 찾지 못했습니다.";
    // shortAnswerOverride always wins in composeShortAnswer, so the
    // reasoner's narrative can never surface here -- calling it anyway
    // would just be a wasted Solar round-trip for a pure source lookup.
    return v2Response({
      question,
      cards,
      detailedAnswer,
      shortAnswerOverride: shortAnswer,
      planner,
      factTablesDegraded,
      requestId,
      runReasoner: false,
      extra: { searchMode: "Supabase 저장 공식 출처 직접 조회" },
    });
  }

  if (constraints.requestedFields.length > 1) {
    const detailedAnswer = deterministicRequestedFieldsAnswer(cards, constraints.requestedFields);
    return v2Response({
      question, cards, detailedAnswer, planner, factTablesDegraded, requestId, runReasoner,
      extra: { searchMode: "Supabase requestedFields 복합 근거 조회" },
    });
  }

  if (intent === "cost") {
    const detailedAnswer = deterministicDirectCostAnswer(cards);
    return v2Response({
      question, cards, detailedAnswer, planner, factTablesDegraded, requestId, runReasoner,
      extra: { searchMode: "Supabase 비용 fact 직접 조회(비교·추정 없음)" },
    });
  }

  if (intent === "deadline") {
    const detailedAnswer = deterministicDeadlineAnswer(cards);
    return v2Response({
      question, cards, detailedAnswer, planner, factTablesDegraded, requestId, runReasoner,
      extra: { searchMode: "Supabase application_deadlines 필드 정렬 + 서버 검증 답변" },
    });
  }


  if (intent === "restriction") {
    const supportedCards = cards.filter((card) => restrictionEvidence([card]).length > 0);
    const detailedAnswer = deterministicRestrictionAnswer(supportedCards);
    return v2Response({
      question, cards: supportedCards, detailedAnswer, planner, factTablesDegraded, requestId, runReasoner,
      extra: { searchMode: "Supabase 수강 제한 근거 직접 조회" },
    });
  }

  if (intent === "housing" || intent === "language") {
    const detailedAnswer = deterministicFactAnswer(cards, intent);
    return v2Response({
      question, cards, detailedAnswer, planner, factTablesDegraded, requestId, runReasoner,
      extra: { searchMode: searchMode(intent) },
    });
  }
  const detailedAnswer = deterministicGeneralAnswer(cards);
  return v2Response({
    question, cards, detailedAnswer, planner, factTablesDegraded, requestId, runReasoner,
    extra: { searchMode: searchMode(intent) },
  });
}

async function handleChatRequest(request: Request) {
  if (isRateLimited(request)) {
    return NextResponse.json({ error: "질문이 너무 빠르게 반복되고 있습니다. 잠시 뒤 다시 시도해 주세요." }, { status: 429 });
  }
  refreshCurrencyRatesInBackground();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "올바른 요청 형식이 아닙니다." }, { status: 400 });
  }

  const rawMessages = (body as { messages?: unknown })?.messages;
  if (!Array.isArray(rawMessages)) {
    return NextResponse.json({ error: "대화 내용이 필요합니다." }, { status: 400 });
  }

  const messages = rawMessages.filter(isChatMessage).slice(-MAX_MESSAGES);
  const contextUniversityIds = Array.isArray((body as { contextUniversityIds?: unknown })?.contextUniversityIds)
    ? ((body as { contextUniversityIds: unknown[] }).contextUniversityIds)
        .filter((value): value is string => typeof value === "string")
        .slice(0, 8)
    : [];
  const sessionId = typeof (body as { sessionId?: unknown })?.sessionId === "string"
    ? String((body as { sessionId: string }).sessionId).slice(0, 80)
    : "unknown";
  if (!messages.length || messages.at(-1)?.role !== "user") {
    return NextResponse.json({ error: "질문을 입력해 주세요." }, { status: 400 });
  }
  const question = messages.at(-1)?.content ?? "";
  if (isPromptInjectionRequest(question)) return safePromptInjectionResponse();

  try {
    const requestId = crypto.randomUUID().slice(0, 8);
    if (isCostOfLivingIndexQuestion(question)) return costOfLivingResponse(question);
    // Product policy must win even when the active planner classifies the
    // question as out of scope or changes its intent.
    if (isRemovedCostRecommendation(question)) {
      return removedCostFeatureResponse();
    }
    const explicitFollowup = contextUniversityIds.length > 0 && isFollowupReference(question);
    // Only fold prior turns' conditions in when this turn explicitly signals
    // it's a continuation ("그중", "거기", ...). A plain new question with no
    // such marker is a topic change and must be evaluated on its own -- carrying
    // an earlier turn's requirements into it would silently narrow an
    // unrelated question (e.g. an earlier "기숙사 있는 곳만" leaking into a later,
    // unrelated "아이엘츠 6.0 대학 알려줘" that never mentioned housing).
    const detectedConstraints = explicitFollowup ? detectConversationConstraints(messages) : detectConstraints(question);
    const legacyConstraints: QueryConstraints = explicitFollowup
      ? { ...detectedConstraints, inScope: true }
      : detectedConstraints;
    const apiKey = process.env.UPSTAGE_API_KEY;
    const plannerMode = resolvePlannerMode();
    // Only a conservative chit-chat guard blocks the Planner call outright --
    // legacyConstraints.inScope (a much broader regex keyword list) used to
    // gate this, so a real question with no matching keyword ("Hanken 붙을
    // 수 있을까?", a real partner university with no "지원"/"대학"/"마감"
    // word nearby) never got a chance to have the Planner classify it at
    // all, regardless of how well Solar itself would have handled it.
    const isChitchatOnly = isConservativeChitchat(question);
    // Phase 3B step 2: the Planner call (and every check up through the
    // fast-path attempt below) uses the lightweight catalog, never the full
    // legacy load -- getChatUniversities() only runs if this request falls
    // through to the legacy fallback further down.
    //
    // This is the ONLY runSolarPlanner call site in this whole file (there
    // is no second call anywhere in the fallback flow below -- the fallback
    // reuses this same `planner` value, it never re-invokes Solar). This
    // count is tracked explicitly and logged so that claim is independently
    // auditable from real request logs, not just from reading the code.
    const willCallPlanner = Boolean(apiKey) && !isChitchatOnly && plannerMode === "active";
    const plannerCallCount = willCallPlanner ? 1 : 0;
    const catalog = await getUniversityCatalog();
    const planner: PlannerRun = willCallPlanner
      ? await runSolarPlanner({
          apiKey: apiKey!,
          model: process.env.UPSTAGE_CHAT_MODEL || "solar-pro3",
          question,
          knownUniversityNames: catalogToKnownUniversityNames(catalog),
          reasoningEffort: resolveReasoningEffort(),
        })
      : {
          rawPlan: null,
          validatedPlan: null,
          issues: [!apiKey ? "missing_api_key" : plannerMode !== "active" ? "shadow_mode_skipped" : "chitchat_guard"],
          usedSolar: false,
        };
    // The Planner's own classification is authoritative over the regex's
    // when it's available -- previously the final inScope always came from
    // the regex value regardless of what the Planner concluded, so calling
    // the Planner at all never actually changed whether an in-scope-but-
    // regex-missed question got answered.
    const finalInScope = planner.validatedPlan
      ? planner.validatedPlan.intent !== "out_of_scope"
      : legacyConstraints.inScope;
    const constraints = plannerMode === "active"
      ? { ...applyValidatedPlannerPlan(legacyConstraints, planner.validatedPlan), inScope: finalInScope }
      : legacyConstraints;
    const intent = constraints.intent;
    console.info("[chat-v2] planner-plan", {
      requestId,
      // Never the raw sessionId (a client-generated identifier that can
      // correlate a real user's requests across turns/logs) -- only
      // whether one was sent at all.
      sessionKeyPresent: sessionId !== "unknown",
      mode: plannerMode,
      usedSolar: planner.usedSolar,
      issues: planner.issues,
      differences: plannerDifferences(legacyConstraints, planner.validatedPlan),
      filters: {
        europe: constraints.requireEurope,
        asia: constraints.requireAsia,
        americas: constraints.requireAmericas,
        countries: constraints.countries,
        excludedCountries: constraints.excludedCountries,
      },
      contextUniversityIds,
      explicitFollowup,
    });
    console.info("[chat-v2] scope-disagreement", {
      requestId,
      regexInScope: legacyConstraints.inScope,
      plannerIntent: planner.validatedPlan?.intent ?? null,
      finalInScope: constraints.inScope,
      disagreementType:
        !legacyConstraints.inScope && constraints.inScope
          ? "regex_false_negative"
          : legacyConstraints.inScope && !constraints.inScope
            ? "regex_false_positive"
            : null,
    });

    // Phase 3B step 2: resolve a single-university target via the catalog
    // (alias match, then Planner-named match) -- never the legacy regex/
    // token matcher (findTargetUniversities), which needs full University
    // objects the catalog doesn't have. If this comes up empty, the fast
    // path below is simply not eligible; the legacy fallback further down
    // still runs the regex matcher exactly as it always has.
    const aliasNames = universityNamesFromAliases(question);
    const catalogIdByName = new Map(catalog.map((item) => [item.universityName, item.universityId]));
    const aliasTargetIds = aliasNames.map((name) => catalogIdByName.get(name)).filter((id): id is string => Boolean(id));
    const plannerCanResolveTargets = planner.validatedPlan
      && planner.validatedPlan.intent !== "university_recommendation"
      && planner.validatedPlan.intent !== "out_of_scope";
    const plannerTargetIds = plannerCanResolveTargets
      ? planner.validatedPlan!.universityNames.map((name) => catalogIdByName.get(name)).filter((id): id is string => Boolean(id))
      : [];
    const catalogExactTargetIds = aliasTargetIds.length ? aliasTargetIds : plannerTargetIds;
    // Same condition usePreviousResults (further down, in the legacy
    // fallback) computes -- entirely derivable without any University data,
    // so follow-up context can rule out the fast path before a full load.
    const hasExplicitGeography = constraints.requireEurope || constraints.requireAsia || constraints.requireAmericas || constraints.countries.length > 0;
    const hasFollowupContext = Boolean((explicitFollowup || planner.validatedPlan?.followupReference.enabled) && !hasExplicitGeography);
    // A session id lets the same real user land on the same side of the
    // canary split across their whole conversation (see
    // targeted-primary.ts's stableCanaryBucket). When the client sends none,
    // this is null, not a substitute per-request id -- a per-request key
    // isn't "stable" by definition, so using one would make an anonymous
    // client's canary assignment change on every single message, exactly
    // the inconsistency stable sampling exists to prevent.
    // attemptTargetedFastPath treats null as a hard exclusion from canary
    // (always Legacy), never a fallback to Math.random()-equivalent
    // per-request rolling.
    const canaryKey = sessionId !== "unknown" ? sessionId : null;
    const fastPath = await attemptTargetedFastPath({
      enabled: TARGETED_PRIMARY_ENABLED,
      canaryRate: TARGETED_PRIMARY_CANARY_RATE,
      canaryKey,
      intent,
      catalogExactTargetIds,
      hasFollowupContext,
      planner,
      finalInScope,
      question,
      constraints,
      catalog,
    });
    const legacyLoadSkipped = fastPath.selectedPath === "targeted_primary";
    console.info("[chat-v2] targeted-primary", {
      requestId,
      selectedPath: fastPath.selectedPath,
      fallbackReason: fastPath.fallbackReason,
      intent,
      targetedAttempted: fastPath.targetedAttempted,
      targetedSucceeded: fastPath.targetedSucceeded,
      legacyLoadTriggered: !legacyLoadSkipped,
      legacyLoadSkipped,
      plannerCallCount,
    });
    if (fastPath.selectedPath === "targeted_primary" && fastPath.cards) {
      const cards = fastPath.cards;
      const runReasoner = cards.length >= 2 || hasRecommendationConditions(constraints) || explicitFollowup;
      return buildFinalResponse({
        requestId, question, intent, constraints, cards,
        classified: undefined, planner, factTablesDegraded: false, runReasoner,
      });
    }

    // Legacy fallback (lazy load): reached only when the fast path above
    // wasn't eligible or fell back (both already logged) -- everything
    // from here down is the pre-Phase-3B-step-2 flow, unchanged, just
    // starting from a full load that now only happens when it's actually
    // needed.
    const legacyQueryStart = Date.now();
    const { universities, factTablesDegraded } = await getChatUniversities();
    const legacyQueryMs = Date.now() - legacyQueryStart;
    if (factTablesDegraded) {
      console.warn("[chat-v2] running degraded", { requestId, reason: "fact_tables_unavailable" });
    }
    // Computed once and reused by both the early unknown-institution check
    // below and the main exactTargets resolution further down -- the planner
    // has already run by this point, so both checks must see its resolved
    // targets, not just the alias/legacy-regex matchers. The early check
    // used to only look at alias+legacy targets, so a question whose only
    // recognizable university came from the planner (not an alias or the
    // regex name matcher) could be wrongly reported as an unknown
    // institution even though the planner had already resolved it.
    const aliasTargets = aliasNames
      .map((name) => universities.find((university) => university.university_name === name))
      .filter((university): university is University => Boolean(university));
    const plannerTargets = plannerCanResolveTargets
      ? planner.validatedPlan!.universityNames
          .map((name) => universities.find((university) => university.university_name === name))
          .filter((university): university is University => Boolean(university))
      : [];
    const legacyTargets = findTargetUniversities(universities, question);
    const exactTargets = aliasTargets.length ? aliasTargets : plannerTargets.length ? plannerTargets : legacyTargets;
    const earlyUnknownInstitution = explicitUnknownInstitution(question, exactTargets);
    if (earlyUnknownInstitution) return unknownInstitutionResponse(earlyUnknownInstitution, universities.length);

    // Solar's own clarificationNeeded self-flag is unreliable in exactly the
    // case that matters most: it never once resolved a Korean nickname like
    // "셰필드" into its own universityNames (always empty), so it sometimes
    // reports "I don't know which university" even on a request our OWN
    // alias/legacy matching had already resolved correctly (measured 6/10
    // identical calls -- see docs/decisions.md). Only honor Solar's self-
    // reported clarification when we don't already have a resolved target.
    if (planner.validatedPlan?.clarificationNeeded && !exactTargets.length) {
      console.info("[chat-v2] clarification", { requestId, source: "solar_planner" });
      return clarificationResponse(
        planner.validatedPlan.clarificationQuestion || "어느 대학의 어떤 정보를 확인할까요? 대학명이나 검색 조건을 알려주세요.",
      );
    }
    if (!constraints.inScope) return unsupportedDataResponse(constraints.unsupportedReason);

    const targetClarification = needsTargetClarification(
      intent,
      exactTargets.length,
      planner.validatedPlan?.universityNames.length ?? 0,
      question,
      hasActionableSearchConditions(constraints),
    );
    if (targetClarification.overriddenByPlanner) {
      // Never the raw question text -- see [chat-v2] planner-plan's own
      // comment for why (a client-supplied/user-authored string that can
      // identify the user or reveal what they asked).
      console.info("[chat-v2] target-clarification overridden by planner", { requestId, intent });
    }
    if (!explicitFollowup && targetClarification.needsClarification) {
      console.info("[chat-v2] clarification", { requestId, source: "server_rule", intent });
      const labels: Partial<Record<typeof intent, string>> = {
        deadline: "어느 대학의 지원 마감일을 확인할까요? 대학명을 알려주세요.",
        language: "어느 대학의 어학 조건을 확인할까요? 대학명을 알려주세요.",
        housing: "어느 대학의 기숙사 정보를 확인할까요? 대학명을 알려주세요.",
        quota: "어느 대학의 파견 정원을 확인할까요? 대학명을 알려주세요.",
        source: "어느 대학의 공식 출처를 확인할까요? 대학명을 알려주세요.",
        restriction: "어느 대학의 수강 제한을 확인할까요? 대학명을 알려주세요.",
      };
      return clarificationResponse(labels[intent] || "어느 대학의 어떤 정보를 확인할까요? 대학명을 알려주세요.");
    }
    // (explicitUnknownInstitution was already checked above against this same
    // exactTargets right after it was resolved -- checking again here would
    // always agree, now that both checks share one target resolution.)
    if (!explicitFollowup && !exactTargets.length) {
      const priorUserTurns = messages.slice(0, -1).filter((message) => message.role === "user");
      const priorConstraints = priorUserTurns.length
        ? detectConversationConstraints(messages.slice(0, -1))
        : undefined;
      // Pass the planner-merged constraints (not the raw regex-only
      // detectedConstraints) for the current turn -- same principle as
      // needsTargetClarification above: if the planner already resolved a
      // geographic scope the regex missed, that's authoritative and this
      // gate must see it, not a second, stale opinion. priorConstraints is
      // necessarily regex-only (there is no stored planner output for past
      // turns to reconstruct).
      const regexOnlyVerdict = needsFollowupScopeClarification(question, contextUniversityIds.length > 0, priorConstraints, detectedConstraints);
      const plannerAwareVerdict = needsFollowupScopeClarification(question, contextUniversityIds.length > 0, priorConstraints, constraints);
      if (regexOnlyVerdict !== plannerAwareVerdict) {
        // Never the raw question text -- see [chat-v2] planner-plan's own
        // comment.
        console.info("[chat-v2] followup-scope-clarification overridden by planner", { requestId });
      }
      if (plannerAwareVerdict) {
        console.info("[chat-v2] clarification", { requestId, source: "followup_scope_ambiguous" });
        const priorSummary = describeConditionsForClarification(priorConstraints!);
        return clarificationResponse(
          `방금 말씀하신 조건${priorSummary ? `("${priorSummary}")` : ""}을 유지한 채 좁혀서 찾을까요, 아니면 새 조건으로 전체 대학에서 다시 찾을까요?\n` +
            `예: "그중 ...만 알려줘" (조건 유지) 또는 "처음부터 ... 대학 알려줘" (새로 검색)`,
        );
      }
    }
    const explicitContextTargets = contextUniversityIds
      .map((id) => universities.find((university) => university.id === id))
      .filter((university): university is University => Boolean(university));
    const previousTargets = explicitContextTargets.length
      ? explicitContextTargets
      : previousContextUniversities(universities, messages.slice(0, -1));
    const ordinal = planner.validatedPlan?.followupReference.ordinal ?? followupOrdinal(question);
    const comparisonLimit = followupComparisonLimit(question);
    // hasFollowupContext (computed above, before the fast-path attempt) is
    // the exact same formula as this flow's own usePreviousResults --
    // reused here rather than redeclared.
    const usePreviousResults = hasFollowupContext;
    const followupTargets = usePreviousResults
      ? ordinal && previousTargets[ordinal - 1]
        ? [previousTargets[ordinal - 1]]
        : comparisonLimit
          ? previousTargets.slice(0, comparisonLimit)
          : previousTargets
      : [];
    const candidateUniversities = followupTargets.length
      ? followupTargets
      : exactTargets.length
        ? exactTargets
        : universities;
    const useClassification = !exactTargets.length && hasRecommendationConditions(constraints) && intent !== "cost" && intent !== "deadline";
    const classified = useClassification ? selectClassifiedCards(candidateUniversities, constraints, question) : undefined;
    const cards = classified ? [...classified.matched, ...classified.partiallyMatched] : selectCards(candidateUniversities, constraints, question);
    console.info("[chat-v2] selection", {
      requestId,
      candidateScope: followupTargets.length ? "previous_results" : exactTargets.length ? "resolved_targets" : "all_universities",
      targetResolution: aliasTargets.length ? "korean_alias" : plannerTargets.length ? "solar_planner" : legacyTargets.length ? "legacy_name_match" : "none",
      resolvedTargetIds: exactTargets.map((university) => university.id),
      candidateCount: candidateUniversities.length,
      contextCandidateIds: followupTargets.map((university) => university.id),
      finalCardIds: cards.map((card) => card.university_id),
      matchedIds: classified?.matched.map((card) => card.university_id) ?? [],
      partialIds: classified?.partiallyMatched.map((card) => card.university_id) ?? [],
    });
    // A single-target direct lookup ("Sheffield IELTS 몇점이야?") has nothing
    // for the reasoner to compare or synthesize -- the deterministic template
    // already says everything there is to say, so skip a Solar call whose
    // narrative would only ever be discarded. Multi-card results, genuinely
    // conditional searches, and follow-ups (which often revisit/narrow a
    // multi-card set) are exactly the cases with something worth explaining.
    const runReasoner = cards.length >= 2 || hasRecommendationConditions(constraints) || explicitFollowup;

    // Phase 3A/3A.1 shadow run (see docs/decisions.md): a Planner-first
    // Targeted Query Builder executes alongside the real, unchanged legacy
    // pipeline ABOVE this line, purely for comparison logging and latency
    // measurement. Its result is NEVER used for the actual response -- not
    // for cards, not for shortAnswer, and a failure here must never surface
    // to the user, hence the isolating try/catch that only ever logs.
    //
    // Phase 3A.1: the candidate ID set is now, whenever possible, the SAME
    // exactTargets/followupTargets our own alias/legacy-name resolution
    // already computed above (not a re-resolution against the catalog) --
    // and the hydrated targeted University[] is run through the exact same
    // selectCards/selectClassifiedCards the legacy path just used, with the
    // exact same constraints. No separate targeted-only evaluator or ranker
    // exists anywhere in this codebase.
    //
    // Phase 3A.2: gated on SHADOW_ENABLED (default off everywhere) and
    // finalInScope, not just planner.validatedPlan -- an out-of-scope
    // question (chitchat, off-topic, or the Planner itself classifying
    // intent as "out_of_scope") has no meaningful legacy cards/constraints
    // to compare against, so running the shadow query for it was pure
    // wasted query load with no useful parity signal. The sample rate
    // further caps what fraction of eligible requests actually run it.
    if (SHADOW_ENABLED && planner.validatedPlan && finalInScope && Math.random() < SHADOW_SAMPLE_RATE) {
      try {
        const targetedStart = Date.now();
        let targetedCards: ResultCard[] = [];
        let targeted: Awaited<ReturnType<typeof queryRelevantUniversityFacts>> | null = null;
        let targetedError: string | undefined;
        try {
          // Reuse the catalog already loaded above (before the Phase 3B
          // fast-path attempt) -- getUniversityCatalog() has its own
          // in-memory cache, so re-fetching here was already cheap, but
          // there's no reason to even do that when this scope already has
          // the same catalog in hand.
          const grounded = groundPlannerFields({ question, validatedPlan: planner.validatedPlan });
          // makeCard/requestedFactBundle (cards.ts) always fetches the
          // PRIMARY intent's own field regardless of requestedFields -- a
          // plain "IELTS 6.0 유럽 대학 추천해줘" (intent: language) never
          // populates constraints.requestedFields at all, since the intent
          // itself is what drives which fact table matters. Without this,
          // the targeted query fetched zero tables for exactly these
          // single-intent recommendation questions (fetchedTables: [],
          // queryCount: 0) even though a real candidate set was resolved.
          const intentField = INTENT_TO_REQUESTED_FIELD[intent];
          const groundedRequestedFields = [...new Set([
            ...(intentField ? [intentField] : []),
            ...(grounded.requestedFields.value.length ? grounded.requestedFields.value : constraints.requestedFields),
          ])];

          const providedUniversityIds = followupTargets.length
            ? followupTargets.map((university) => university.id)
            : exactTargets.length
              ? exactTargets.map((university) => university.id)
              : undefined;

          const { ids: candidateIds, source: candidateSource } = await resolveCandidateUniversityIds({
            plan: planner.validatedPlan,
            catalog,
            providedUniversityIds,
            // Use the FINAL merged constraints (the same object the common
            // evaluator below will check), not a separately re-grounded
            // value -- candidate narrowing must never be stricter than what
            // the evaluator itself would accept, or recall could drop below
            // 100%.
            groundedHousingAvailable: constraints.requireHousing,
            groundedHousingGuaranteed: constraints.requireHousingGuaranteed,
            groundedLanguageTest: constraints.languageTest,
          });

          targeted = await queryRelevantUniversityFacts(candidateIds, groundedRequestedFields, candidateSource);

          // Only hydrate the RESOLVED candidates -- passing the whole
          // catalog here (a real bug caught by the Phase 3A.1 live re-test:
          // Q10/Q11 both deterministically substituted 4 arbitrary
          // universities for the single, correctly-resolved Sheffield ID)
          // fed 53 mostly-empty University objects into the common
          // evaluator, which then scored/selected among ALL of them instead
          // of just the intended candidate.
          const candidateIdSet = new Set(candidateIds);
          const candidateCatalogItems = catalog.filter((item) => candidateIdSet.has(item.universityId));
          const legacyById = new Map(universities.map((university) => [university.id, university]));
          // Scoped, per-candidate fetch (not the full legacy load) for the
          // two fields with no dedicated fact table -- see
          // fetchLegacyFallbackFields' own comment in targeted-query.ts.
          const legacyFallback = await fetchLegacyFallbackFields(candidateIds);
          const targetedUniversities = hydrateUniversitiesFromCatalog(candidateCatalogItems, targeted.factBundles, legacyById, legacyFallback.data);
          // Fold the fallback query's real DB cost into the same metrics
          // used for the fair legacy-vs-targeted row/query-count comparison
          // -- it's real Targeted-side query load, not something to leave
          // invisible in that comparison.
          targeted = {
            ...targeted,
            queryCount: targeted.queryCount + legacyFallback.queryCount,
            fetchedTables: legacyFallback.rowCount ? [...targeted.fetchedTables, "canonical_facts"] : targeted.fetchedTables,
            rowCountsByTable: legacyFallback.rowCount
              ? { ...targeted.rowCountsByTable, canonical_facts: legacyFallback.rowCount }
              : targeted.rowCountsByTable,
          };
          // Common evaluator reuse: identical selectCards/selectClassifiedCards
          // call the legacy path made above, just fed the targeted-hydrated
          // University[] instead of the fully-loaded one.
          const targetedClassified = useClassification
            ? selectClassifiedCards(targetedUniversities, constraints, question)
            : undefined;
          targetedCards = targetedClassified
            ? [...targetedClassified.matched, ...targetedClassified.partiallyMatched]
            : selectCards(targetedUniversities, constraints, question);
        } catch (error) {
          targetedError = error instanceof Error ? error.message : String(error);
        }
        const targetedQueryMs = Date.now() - targetedStart;
        logShadowParity(computeShadowParity({
          requestId,
          intent,
          legacyCards: cards,
          targetedCards,
          targeted,
          targetedError,
          legacyQueryMs,
          legacyTotalFactRows: countTotalFactRows(universities),
          targetedQueryMs,
        }));
      } catch (shadowError) {
        // The comparison/logging step itself must be just as inert as the
        // query it's comparing -- a bug here must never turn into a 500 for
        // the user (this whole block sits inside handleChatRequest's own
        // try/catch, which otherwise WOULD turn an uncaught throw here into
        // exactly that).
        console.error("[chat-v2] targeted-query-shadow failed", shadowError);
      }
    }

    // Phase 3B step 2: the pre-load fast-path attempt (above, before
    // getChatUniversities() ever ran) already tried the Targeted Query
    // Builder if this request was eligible for it. Reaching this point
    // means either it wasn't eligible (already logged) or it was attempted
    // and fell back (also already logged) -- re-attempting Targeted again
    // now, after paying for the full legacy load, would be pure waste.
    return buildFinalResponse({ requestId, question, intent, constraints, cards, classified, planner, factTablesDegraded, runReasoner });
  } catch (error) {
    console.error("Chat route error", error);
    return NextResponse.json({ error: "챗봇 요청 처리 중 오류가 발생했습니다." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!request.headers.get("accept")?.includes("application/x-ndjson")) {
    return handleChatRequest(request);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (value: unknown) => {
        if (!closed) controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
      };
      send({ type: "status", stage: "planning", message: "질문의 조건을 분석하고 있습니다." });
      const timers = [
        setTimeout(() => send({ type: "status", stage: "searching", message: "등록된 대학 데이터를 검색하고 있습니다." }), 700),
        setTimeout(() => send({ type: "status", stage: "validating", message: "후보 대학의 조건과 출처를 확인하고 있습니다." }), 1700),
        setTimeout(() => send({ type: "status", stage: "reasoning", message: "검증된 결과를 정리하고 있습니다." }), 2800),
      ];
      void handleChatRequest(request)
        .then(async (response) => {
          const data = await response.json();
          send({ type: "result", status: response.status, data });
        })
        .catch((error) => {
          console.error("[chat-v2] stream failed", error);
          send({ type: "error", message: "챗봇 요청 처리 중 오류가 발생했습니다." });
        })
        .finally(() => {
          timers.forEach(clearTimeout);
          closed = true;
          controller.close();
        });
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}
