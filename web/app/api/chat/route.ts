import { NextResponse } from "next/server";
import type { University } from "../../lib/types";
import { createEvidencePacket } from "../../lib/chat/evidence-packet";
import { runSolarPlanner, type PlannerRun } from "../../lib/chat/query-plan";
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
  authoritativeShortAnswer,
  responsePresentation,
  sanitizeGeneratedAnswer,
  searchMode,
} from "../../lib/chat/answers";
import {
  detectConstraints,
  detectConversationConstraints,
  isCostOfLivingIndexQuestion,
  isRemovedCostRecommendation,
} from "../../lib/chat/constraints";
import {
  applyValidatedPlannerPlan,
  followupOrdinal,
  plannerDifferences,
  plannerHasSearchConditions,
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
  hasRecommendationConditions,
  isFollowupReference,
  previousContextUniversities,
  selectCards,
  selectClassifiedCards,
  unknownInstitutionResponse,
} from "../../lib/chat/selection";
import { getChatUniversities, refreshCurrencyRatesInBackground } from "../../lib/chat/supabase-facts";
import type { ChatMessage, QueryConstraints, ResultCard } from "../../lib/chat/types";

export const runtime = "nodejs";

const MAX_MESSAGES = 8;
const MAX_MESSAGE_LENGTH = 2000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_REQUESTS = 10;

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
  question: string;
  cards: ResultCard[];
  detailedAnswer: string;
  planner: PlannerRun;
  factTablesDegraded: boolean;
  shortAnswerOverride?: string;
  extra?: Record<string, unknown>;
}) {
  const apiKey = process.env.UPSTAGE_API_KEY;
  const model = process.env.UPSTAGE_CHAT_MODEL || "solar-pro3";
  const evidenceCards = args.cards.map((card) => ({ ...card, match_status: card.match_status ?? "matched" as const }));
  const packet = createEvidencePacket(args.question, args.planner.validatedPlan, evidenceCards);
  const reasoner = apiKey
    ? await runSolarReasoner({ apiKey, model, packet, reasoningEffort: resolveReasoningEffort() })
    : { output: null, usedSolar: false, issues: ["missing_api_key"] };
  const presentation = responsePresentation(args.detailedAnswer, args.cards);
  // Only the reasoner's own text needs this pass -- presentation.shortAnswer
  // is always a deterministic template and never contains a placeholder like
  // "XXX"/"TBD" to begin with.
  const modelShortAnswer = reasoner.output?.shortAnswer
    ? sanitizeGeneratedAnswer(reasoner.output.shortAnswer) || presentation.shortAnswer
    : presentation.shortAnswer;
  const shortAnswer = args.shortAnswerOverride ?? authoritativeShortAnswer(args.cards, modelShortAnswer);

  console.info("[chat-v2] pipeline", {
    planner: args.planner.usedSolar,
    plannerMode: resolvePlannerMode(),
    plannerIssues: args.planner.issues,
    evidenceUniversities: packet.universities.length,
    evidenceFacts: packet.universities.reduce((sum, item) => sum + item.facts.length, 0),
    reasoner: reasoner.usedSolar,
    reasonerIssues: reasoner.issues,
  });

  return NextResponse.json({
    ...presentation,
    shortAnswer,
    cards: args.cards,
    sources: collectSources(args.cards),
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
    const { universities, factTablesDegraded } = await getChatUniversities();
    const requestId = crypto.randomUUID().slice(0, 8);
    if (factTablesDegraded) {
      console.warn("[chat-v2] running degraded", { requestId, reason: "fact_tables_unavailable" });
    }
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
    const planner: PlannerRun = apiKey && legacyConstraints.inScope && plannerMode === "active"
      ? await runSolarPlanner({
          apiKey,
          model: process.env.UPSTAGE_CHAT_MODEL || "solar-pro3",
          question,
          knownUniversityNames: universities.map((university) => university.university_name),
          reasoningEffort: resolveReasoningEffort(),
        })
      : {
          rawPlan: null,
          validatedPlan: null,
          issues: [!apiKey ? "missing_api_key" : plannerMode !== "active" ? "shadow_mode_skipped" : "out_of_scope"],
          usedSolar: false,
        };
    const constraints = plannerMode === "active"
      ? applyValidatedPlannerPlan(legacyConstraints, planner.validatedPlan)
      : legacyConstraints;
    console.info("[chat-v2] planner-plan", {
      requestId,
      sessionId,
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
    // Computed once and reused by both the early unknown-institution check
    // below and the main exactTargets resolution further down -- the planner
    // has already run by this point, so both checks must see its resolved
    // targets, not just the alias/legacy-regex matchers. The early check
    // used to only look at alias+legacy targets, so a question whose only
    // recognizable university came from the planner (not an alias or the
    // regex name matcher) could be wrongly reported as an unknown
    // institution even though the planner had already resolved it.
    const aliasNames = universityNamesFromAliases(question);
    const aliasTargets = aliasNames
      .map((name) => universities.find((university) => university.university_name === name))
      .filter((university): university is University => Boolean(university));
    const plannerCanResolveTargets = planner.validatedPlan
      && planner.validatedPlan.intent !== "university_recommendation"
      && planner.validatedPlan.intent !== "out_of_scope";
    const plannerTargets = plannerCanResolveTargets
      ? planner.validatedPlan!.universityNames
          .map((name) => universities.find((university) => university.university_name === name))
          .filter((university): university is University => Boolean(university))
      : [];
    const legacyTargets = findTargetUniversities(universities, question);
    const exactTargets = aliasTargets.length ? aliasTargets : plannerTargets.length ? plannerTargets : legacyTargets;
    const earlyUnknownInstitution = explicitUnknownInstitution(question, exactTargets);
    if (earlyUnknownInstitution) return unknownInstitutionResponse(earlyUnknownInstitution, universities.length);

    if (planner.validatedPlan?.clarificationNeeded) {
      console.info("[chat-v2] clarification", { requestId, source: "solar_planner" });
      return clarificationResponse(
        planner.validatedPlan.clarificationQuestion || "어느 대학의 어떤 정보를 확인할까요? 대학명이나 검색 조건을 알려주세요.",
      );
    }
    if (!constraints.inScope) return unsupportedDataResponse(constraints.unsupportedReason);

    const intent = constraints.intent;
    const targetClarification = needsTargetClarification(
      intent,
      exactTargets.length,
      planner.validatedPlan?.universityNames.length ?? 0,
      question,
      plannerHasSearchConditions(planner.validatedPlan),
    );
    if (targetClarification.overriddenByPlanner) {
      console.info("[chat-v2] target-clarification overridden by planner", { requestId, intent, question });
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
        console.info("[chat-v2] followup-scope-clarification overridden by planner", { requestId, question });
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
    const hasExplicitGeography = constraints.requireEurope || constraints.requireAsia || constraints.requireAmericas || constraints.countries.length > 0;
    const usePreviousResults = (explicitFollowup || planner.validatedPlan?.followupReference.enabled) && !hasExplicitGeography;
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
      return v2Response({
        question,
        cards,
        detailedAnswer,
        shortAnswerOverride: shortAnswer,
        planner,
        factTablesDegraded,
        extra: { searchMode: "Supabase 저장 공식 출처 직접 조회" },
      });
    }

    if (constraints.requestedFields.length > 1) {
      const detailedAnswer = deterministicRequestedFieldsAnswer(cards, constraints.requestedFields);
      return v2Response({
        question, cards, detailedAnswer, planner, factTablesDegraded,
        extra: { searchMode: "Supabase requestedFields 복합 근거 조회" },
      });
    }

    if (intent === "cost") {
      const detailedAnswer = deterministicDirectCostAnswer(cards);
      return v2Response({
        question, cards, detailedAnswer, planner, factTablesDegraded,
        extra: { searchMode: "Supabase 비용 fact 직접 조회(비교·추정 없음)" },
      });
    }

    if (intent === "deadline") {
      const detailedAnswer = deterministicDeadlineAnswer(cards);
      return v2Response({
        question, cards, detailedAnswer, planner, factTablesDegraded,
        extra: { searchMode: "Supabase application_deadlines 필드 정렬 + 서버 검증 답변" },
      });
    }


    if (intent === "restriction") {
      const supportedCards = cards.filter((card) => restrictionEvidence([card]).length > 0);
      const detailedAnswer = deterministicRestrictionAnswer(supportedCards);
      return v2Response({
        question, cards: supportedCards, detailedAnswer, planner, factTablesDegraded,
        extra: { searchMode: "Supabase 수강 제한 근거 직접 조회" },
      });
    }

    if (intent === "housing" || intent === "language") {
      const detailedAnswer = deterministicFactAnswer(cards, intent);
      return v2Response({
        question, cards, detailedAnswer, planner, factTablesDegraded,
        extra: { searchMode: searchMode(intent) },
      });
    }
    const detailedAnswer = deterministicGeneralAnswer(cards);
    return v2Response({
      question, cards, detailedAnswer, planner, factTablesDegraded,
      extra: { searchMode: searchMode(intent) },
    });
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
