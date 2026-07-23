import { NextResponse } from "next/server";
import {
  NUMBEO_SNAPSHOT_DATE,
  costIndexCountry,
  costIndexCountryLabel,
  costOfLivingIndex,
  loadCostOfLivingSnapshot,
} from "../cost-of-living";
import { hasRecommendationConditions } from "./selection";
import type { Intent, QueryConstraints } from "./types";
import { cleanText, detectCountries } from "./utils";

export function outOfScopeResponse() {
  return NextResponse.json({
    answer: "교환대학의 지원 조건, 어학 성적, 일정, 기숙사, 비용처럼 등록된 교환학생 정보에 대해서만 답할 수 있습니다.",
    cards: [],
    sources: [],
    searchMode: "범위 밖 질문 거절",
  });
}

export function clarificationResponse(question: string) {
  const prompt = cleanText(question, "어느 대학의 어떤 정보를 확인할까요? 대학명이나 검색 조건을 알려주세요.");
  return NextResponse.json({
    answer: prompt,
    shortAnswer: prompt,
    detailedAnswer: ["### 질문을 조금만 구체화해 주세요", "", prompt].join("\n"),
    cards: [],
    sources: [],
    matched: [],
    partially_matched: [],
    excluded_count: 0,
    unknown_fields: [],
    searchMode: "명확화 질문",
  });
}

// A question with no "그중"/"거기" marker but that still reads as its own
// complete recommendation request (its own region/score/major/housing/
// deadline condition) is genuinely ambiguous right after a turn that set up
// different conditions: does it replace them, or layer on top? Silently
// picking one either drops the earlier conditions the user may still want,
// or leaks them into a question that never asked for them (the bug this was
// added to prevent). Asking once is cheaper than guessing wrong either way.
const SCOPE_RESET_MARKERS = /처음부터|새로\s*(?:검색|찾아|추천)|전체\s*(?:대학)?(?:에서|를 대상으로)|이전\s*조건\s*(?:무시|빼고|없이)|조건\s*(?:다시|리셋)/i;

export function describeConditionsForClarification(constraints: QueryConstraints): string {
  const parts: string[] = [];
  if (constraints.requireEurope) parts.push("유럽");
  if (constraints.requireAsia) parts.push("아시아");
  if (constraints.requireAmericas) parts.push("아메리카");
  if (constraints.countries.length) parts.push(constraints.countries.join("/"));
  if (constraints.languageTest && constraints.languageScore !== undefined) parts.push(`${constraints.languageTest} ${constraints.languageScore}`);
  if (constraints.gpa !== undefined) parts.push(`GPA ${constraints.gpa}`);
  if (constraints.major) parts.push(constraints.major);
  if (constraints.requireHousing) parts.push("기숙사 정보 있음");
  if (constraints.requireHousingGuaranteed) parts.push("기숙사 배정 보장");
  if (constraints.deadlineSemester) parts.push(constraints.deadlineSemester === "spring" ? "봄학기" : "가을학기");
  return parts.join(" · ");
}

export function hasGeographicScope(constraints: QueryConstraints) {
  return Boolean(
    constraints.requireEurope || constraints.requireAsia || constraints.requireAmericas || constraints.countries.length,
  );
}

// Narrowly scoped to the one condition mergeConversationConstraints refuses to
// carry forward on its own (geographic scope -- see its comment for why).
// Any client that has ever gotten a successful recommendation will keep
// sending that turn's contextUniversityIds on every later message, including
// a fully self-contained next question, so "there is a previous turn" alone
// is not a useful ambiguity signal (an earlier, broader version of this check
// asked on every back-to-back recommendation question, including ones that
// restate their own complete region -- a real false positive found via
// qa-runner's group B, where each question is independent but happens to
// share the word "유럽"). Only ask when the *current* question omits any
// region/country of its own right after a turn that had one -- that specific
// gap is where "should this stay scoped to before, or search everywhere?" is
// actually unclear.
export function needsFollowupScopeClarification(
  question: string,
  hasContext: boolean,
  priorConstraints: QueryConstraints | undefined,
  currentConstraints: QueryConstraints,
): boolean {
  if (!hasContext || !priorConstraints) return false;
  if (SCOPE_RESET_MARKERS.test(question.normalize("NFKC"))) return false;
  if (!hasGeographicScope(priorConstraints) || hasGeographicScope(currentConstraints)) return false;
  return hasRecommendationConditions(priorConstraints) && hasRecommendationConditions(currentConstraints);
}

export function needsTargetClarification(
  intent: Intent,
  exactTargetCount: number,
  plannerTargetCount: number,
  question: string,
) {
  const directFactIntent = new Set<Intent>(["deadline", "language", "housing", "quota", "source", "restriction"]);
  if (!directFactIntent.has(intent) || exactTargetCount > 0 || plannerTargetCount > 0) return false;

  const normalized = question.normalize("NFKC").toLowerCase();
  const asksForCollection = /추천|비교|순위|가장|빠른|이른|낮은|높은|어디|어느\s*(?:대학|학교)|대학.{0,12}(?:찾|보여|알려|추천)|학교.{0,12}(?:찾|보여|알려|추천)|있는\s*(?:대학|학교)|가능한\s*(?:대학|학교)|몇\s*곳|top\s*\d+|recommend|compare|rank|which\s*(?:universities|schools)/i.test(normalized);
  const hasScopedDeadlinePeriod = intent === "deadline"
    && /\b20\d{2}\b/.test(normalized)
    && /가을|봄|autumn|fall|spring/.test(normalized);
  return !asksForCollection && !hasScopedDeadlinePeriod;
}

export function unsupportedDataResponse(reason?: QueryConstraints["unsupportedReason"]) {
  if (reason === "cost_of_living_index") {
    return NextResponse.json({
      answer:
        "현재 웹페이지 내 데이터베이스 정보로 말씀드릴 수 없는 정보입니다.\n\n- 지금 DB에는 대학별 교환학생 지원 조건, 어학 성적, 일정, 기숙사, 일부 비용 정보가 중심으로 저장되어 있습니다.\n- 한국과의 국가별 물가 지수 비교는 별도 지표 데이터가 필요합니다.\n- 이 기능을 정확히 제공하려면 Numbeo 같은 외부 물가 지표를 별도 테이블로 저장하고, 기준일과 출처를 함께 표시해야 합니다.",
      cards: [],
      sources: [],
      searchMode: "DB 미보유 데이터 요청",
    });
  }
  return outOfScopeResponse();
}

export function safePromptInjectionResponse() {
  const message = "시스템 지침, 환경변수, API 키, 원본 데이터베이스 전체 내용은 제공할 수 없습니다. 교환대학의 지원 조건이나 공식 근거를 질문해 주세요.";
  return NextResponse.json({
    answer: message,
    shortAnswer: message,
    detailedAnswer: message,
    cards: [],
    sources: [],
    unknown_fields: [],
    searchMode: "안전 정책 응답",
  });
}

export async function costOfLivingResponse(question: string) {
  const mentioned = detectCountries(question).filter((country, index, items) => items.indexOf(country) === index);
  const countries = mentioned.filter((country) => country !== "South Korea");
  if (!countries.length) {
    return clarificationResponse("비교할 국가를 알려주세요. 예: `영국과 핀란드 중 한국 대비 생활 물가가 더 낮은 나라는 어디야?`");
  }
  const snapshot = await loadCostOfLivingSnapshot();
  const rows = countries.flatMap((country) => {
    const item = costIndexCountry(country);
    const index = costOfLivingIndex(country, snapshot.indices);
    return item && index !== undefined ? [{ country, item, index }] : [];
  }).sort((a, b) => a.index - b.index);
  if (!rows.length) {
    return NextResponse.json({
      answer: "요청한 국가의 생활 물가 지수를 현재 공통 물가 데이터에서 확인하지 못했습니다.",
      shortAnswer: "요청한 국가의 생활 물가 지수를 확인하지 못했습니다.",
      detailedAnswer: "### 생활 물가 비교\n\n현재 공통 물가 데이터에 해당 국가 값이 없습니다.",
      cards: [], sources: [], matched: [], partially_matched: [], excluded_count: 0, unknown_fields: countries,
      searchMode: "공통 국가별 물가지수 조회 결과 없음",
    });
  }
  const comparison = rows.length > 1
    ? `비교한 국가 중 **${costIndexCountryLabel(rows[0].country)}**의 생활 물가 지수가 더 낮습니다.`
    : `**${costIndexCountryLabel(rows[0].country)}**의 생활 물가 지수는 한국=100 기준 **${rows[0].index.toFixed(1)}**입니다.`;
  const tableRows = rows.map(({ country, item, index }) => {
    const difference = index - 100;
    return `| ${costIndexCountryLabel(country)} | ${index.toFixed(1)} | 한국보다 ${Math.abs(difference).toFixed(1)}% ${difference >= 0 ? "높음" : "낮음"} | ${item.source} |`;
  });
  const detailedAnswer = [
    "### 생활 물가 비교", "", comparison, "",
    "| 국가 | 한국=100 지수 | 한국 대비 | 출처 |", "|---|---:|---|---|", ...tableRows, "",
    `- OECD 기준월: ${snapshot.period}${snapshot.fallback ? " (저장된 최신 확인값)" : ""}`,
    `- Numbeo 비OECD 국가 스냅샷: ${NUMBEO_SNAPSHOT_DATE}`,
    "- 국가 평균 지표이므로 도시·주거 형태에 따른 실제 지출 차이는 별도로 확인해야 합니다.",
  ].join("\n");
  return NextResponse.json({
    answer: comparison,
    shortAnswer: comparison,
    detailedAnswer,
    cards: [], matched: [], partially_matched: [], excluded_count: 0, unknown_fields: [],
    sources: [
      { title: "OECD 월별 비교물가수준", url: "https://data-explorer.oecd.org/vis?df%5Bag%5D=OECD.SDD.TPS&df%5Bid%5D=DSD_PPP_M%40DF_PP_CPL_M", source_type: "OECD", is_official: true },
      { title: "Numbeo 국가별 생활비 지수", url: "https://www.numbeo.com/cost-of-living/rankings_by_country.jsp", source_type: "Numbeo", is_official: false },
    ],
    searchMode: "웹 화면과 동일한 공통 국가별 물가지수 함수",
  });
}

export function removedCostFeatureResponse() {
  return NextResponse.json({
    answer:
      "비용 데이터의 기준이 대학마다 달라 현재 챗봇에서는 대학 간 총비용 순위, 예산 이하 추천, 한 학기 예상 비용 계산을 제공하지 않습니다.\n\n- 특정 대학의 공식 기숙사비·생활비처럼 DB에 명시된 개별 비용은 확인할 수 있습니다.\n- 금액은 원래 통화와 원래 기간(월·학기·연간) 그대로 안내합니다.\n- 예: `University of Helsinki의 공식 기숙사 비용을 알려줘.`",
    cards: [],
    sources: [],
    searchMode: "회의 결정에 따라 비용 비교·예산 추천 제외",
  });
}
