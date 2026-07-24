import { NextResponse } from "next/server";
import type { University } from "../types";
import { presentConditionCheck } from "../display/present-fact";
import { makeCard } from "./cards";
import {
  earliestMatchingDeadlineTime,
  estimateSemesterCost,
  evaluateUniversity,
  minimumGpaRequirement,
  passesStructuredFilters,
  quotaValue,
  scoreUniversity,
} from "./filters";
import type { ChatMessage, CostEstimate, EvaluatedUniversity, QueryConstraints, RankedCandidate } from "./types";
import { isAmericasUniversity, isAsianUniversity, isEuropeanUniversity, matchesCountry, normalizeSearchText } from "./utils";

function significantNameTokens(value: string) {
  return normalizeSearchText(value)
    .split(/\s+/)
    .filter((token) => token.length >= 4 && !["university", "school", "college", "institute", "national"].includes(token));
}

function targetUniversityScore(university: University, question: string) {
  const q = normalizeSearchText(question);
  const name = normalizeSearchText(university.university_name);
  const city = normalizeSearchText(university.city);
  if (!q || !name) return 0;
  if (q.includes(name)) return 100;

  const tokens = significantNameTokens(university.university_name);
  if (tokens.length >= 2 && tokens.every((token) => q.includes(token))) return 92;
  if (tokens.length >= 1 && tokens.some((token) => q.includes(token)) && /university|school|college|대학|학교/.test(q)) return 72;
  if (city && city.length >= 5 && q.includes(city) && tokens.some((token) => q.includes(token))) return 68;
  return 0;
}

export function findTargetUniversities(universities: University[], question: string) {
  const ranked = universities
    .map((university) => ({ university, score: targetUniversityScore(university, question) }))
    .filter((item) => item.score >= 70)
    .sort((a, b) => b.score - a.score);
  const exact = ranked.filter((item) => item.score >= 90);
  return (exact.length ? exact : ranked)
    .map((item) => item.university)
    .slice(0, 3);
}

export function isFollowupReference(question: string) {
  return /방금\s*(?:추천한|말한)|이\s*(?:학교|대학)들?|그\s*(?:학교|대학)들?|위\s*(?:학교|대학)들?|앞서\s*(?:추천한|언급한)|추천한\s*(?:학교|대학)들?|(?:둘|셋|넷|그|이)\s*중(?:에|에서)?|(?:첫|두|세)\s*번째\s*(?:학교|대학)|거기|그곳|그\s*(?:학교|대학)|어디가\s*더|어느\s*(?:곳|학교|대학)이?\s*더|조건이\s*더\s*(?:적|낮|쉬)|라고\s*했는데|왜\s+.+(?:추천|나와)|those\s*(?:universities|schools)|these\s*(?:universities|schools)|which\s+one/i.test(question.normalize("NFKC"));
}

export function followupComparisonLimit(question: string) {
  const normalized = question.normalize("NFKC").toLowerCase();
  if (/둘\s*중/.test(normalized)) return 2;
  if (/셋\s*중/.test(normalized)) return 3;
  if (/넷\s*중/.test(normalized)) return 4;
  return undefined;
}

export function previousContextUniversities(universities: University[], messages: ChatMessage[]) {
  const previousAssistant = [...messages].reverse().find((message) => message.role === "assistant")?.content ?? "";
  if (!previousAssistant) return [];
  return universities.filter((university) => {
    const normalizedAnswer = normalizeSearchText(previousAssistant);
    const normalizedName = normalizeSearchText(university.university_name);
    return normalizedName.length > 4 && normalizedAnswer.includes(normalizedName);
  });
}

export function explicitUnknownInstitution(question: string, exactTargets: University[]) {
  if (exactTargets.length) return undefined;
  const normalized = question.normalize("NFKC");
  const match = normalized.match(/\b([A-Z][A-Za-z'&.-]*(?:\s+[A-Z][A-Za-z'&.-]*){0,6}\s+(?:University|College|School|Institute))\b/);
  return match?.[1];
}

export function unknownInstitutionResponse(name: string, universityCount: number) {
  const answer = `현재 등록된 ${universityCount}개 교환대학에서 **${name}**을(를) 찾지 못했습니다. 비슷한 이름의 다른 대학을 대신 추천하지 않았습니다.`;
  return NextResponse.json({
    answer,
    shortAnswer: answer,
    detailedAnswer: ["### 등록 대학 검색 결과", "", answer].join("\n"),
    cards: [],
    sources: [],
    matched: [],
    partially_matched: [],
    excluded_count: 0,
    unknown_fields: ["university"],
    searchMode: "등록 대학명 정확 일치 검사 결과 없음",
  });
}

export function selectCards(universities: University[], constraints: QueryConstraints, question: string) {
  const exactTargets = findTargetUniversities(universities, question);
  if (exactTargets.length) {
    return exactTargets
      .filter((university) => {
        if (constraints.requireEurope && !isEuropeanUniversity(university)) return false;
        if (constraints.requireAsia && !isAsianUniversity(university)) return false;
        if (constraints.requireAmericas && !isAmericasUniversity(university)) return false;
        if (!matchesCountry(university, constraints.countries)) return false;
        if (constraints.excludedCountries.length && matchesCountry(university, constraints.excludedCountries)) return false;
        if (constraints.excludeAsia && isAsianUniversity(university)) return false;
        return true;
      })
      .slice(0, constraints.topN)
      .map((university) => {
        return makeCard({ university, score: 100 }, constraints.intent, constraints.requestedFields);
      });
  }

  const pool = universities.filter((university) => passesStructuredFilters(university, constraints));

  if (constraints.intent === "cost" || constraints.budgetKrwSemester !== undefined) {
    const ranked = pool
      .map((university) => ({
        university,
        score: scoreUniversity(university, constraints.intent, question),
        cost: estimateSemesterCost(university, { requireClear: constraints.requireClearCost || constraints.requireOfficialSource || constraints.budgetKrwSemester !== undefined }),
      }))
      .filter((candidate): candidate is RankedCandidate & { cost: CostEstimate } => Boolean(candidate.cost))
      .sort((a, b) => {
        const costDiff = a.cost.normalizedKrw - b.cost.normalizedKrw;
        if (costDiff !== 0) return costDiff;
        const categoryDiff = b.cost.categoryCount - a.cost.categoryCount;
        return categoryDiff !== 0 ? categoryDiff : a.university.id.localeCompare(b.university.id);
      })
      .slice(0, constraints.topN);

    if (ranked.length) return ranked.map((candidate) => makeCard(candidate, constraints.intent, constraints.requestedFields));
  }

  const ranked = pool
    .map((university) => ({ university, score: scoreUniversity(university, constraints.intent, question) }))
    .filter(({ score }, index) => score > 0 || (constraints.intent === "general" && index < constraints.topN))
    .sort((a, b) => {
      // Every branch falls back to a university.id tie-break when its own
      // primary comparison is a genuine tie (same score, same quota, same
      // GPA, same deadline) -- without it, a tie resolves by array input
      // order, which the legacy full-load path and the Targeted Query
      // Builder's candidate-filtered path do not share (see filters.ts's
      // housingQualitySignalScore comment for the concrete case this fixed).
      const primary = constraints.quotaMode === "sort_desc"
        ? (quotaValue(b.university) ?? -1) - (quotaValue(a.university) ?? -1)
        : constraints.sortGpaLowest
          ? (() => {
              const aGpa = minimumGpaRequirement(a.university);
              const bGpa = minimumGpaRequirement(b.university);
              const aNormalized = aGpa ? (aGpa.value / aGpa.scale) * 4.5 : Number.MAX_SAFE_INTEGER;
              const bNormalized = bGpa ? (bGpa.value / bGpa.scale) * 4.5 : Number.MAX_SAFE_INTEGER;
              return aNormalized - bNormalized;
            })()
          : constraints.sortDeadlineEarliest
            ? earliestMatchingDeadlineTime(a.university, constraints) - earliestMatchingDeadlineTime(b.university, constraints)
            : b.score - a.score;
      return primary !== 0 ? primary : a.university.id.localeCompare(b.university.id);
    })
    .slice(0, constraints.topN);

  return ranked.map((candidate) => makeCard(candidate, constraints.intent, constraints.requestedFields));
}

export function selectClassifiedCards(universities: University[], constraints: QueryConstraints, question: string) {
  const evaluated = universities.map((university) => evaluateUniversity(university, constraints));
  const rank = (items: EvaluatedUniversity[], limit: number) =>
    items
      .map((item) => ({ item, score: scoreUniversity(item.university, constraints.intent, question) }))
      .sort((a, b) => {
        // See the matching comment in selectCards -- every branch needs a
        // deterministic university.id tie-break so a genuine tie doesn't
        // silently resolve by array input order instead.
        const primary = constraints.quotaMode === "sort_desc"
          ? (quotaValue(b.item.university) ?? -1) - (quotaValue(a.item.university) ?? -1)
          : constraints.sortGpaLowest
            ? (() => {
                const aGpa = minimumGpaRequirement(a.item.university);
                const bGpa = minimumGpaRequirement(b.item.university);
                const aNormalized = aGpa ? (aGpa.value / aGpa.scale) * 4.5 : Number.MAX_SAFE_INTEGER;
                const bNormalized = bGpa ? (bGpa.value / bGpa.scale) * 4.5 : Number.MAX_SAFE_INTEGER;
                return aNormalized - bNormalized;
              })()
            : constraints.sortDeadlineEarliest
              ? earliestMatchingDeadlineTime(a.item.university, constraints) - earliestMatchingDeadlineTime(b.item.university, constraints)
              : b.score - a.score;
        return primary !== 0 ? primary : a.item.university.id.localeCompare(b.item.university.id);
      })
      .slice(0, limit)
      .map(({ item, score }) => {
        const card = makeCard({ university: item.university, score }, constraints.intent, constraints.requestedFields);
        card.match_status = item.status === "matched" ? "matched" : "partial";
        card.condition_checks = item.checks.map((check) => ({
          ...check,
          detail: presentConditionCheck(check).value ?? "확인 필요",
        }));
        card.unknown_fields = item.checks.filter((check) => check.state === "unknown").map((check) => check.label);
        return card;
      });

  const matched = rank(evaluated.filter((item) => item.status === "matched"), Math.min(constraints.topN, 5));
  const partiallyMatched = rank(evaluated.filter((item) => item.status === "partial"), 3);
  const excluded = evaluated.filter((item) => item.status === "excluded");
  return { matched, partiallyMatched, excluded };
}
