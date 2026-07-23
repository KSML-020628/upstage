import type { ReasonerOutput } from "./reasoner";
import type { ResultCard } from "./types";

// Each recommendation was already validated in reasoner.ts (schema-shaped,
// reasonFactIds/cautionFactIds filtered to that university's own fact IDs,
// explanation checked for ungrounded numbers/URLs and unknown-state
// upgrades) -- attach it to the matching card. Cards with no accepted
// recommendation (rejected, or the reasoner recommended nothing for them)
// are returned unchanged -- they never disappear, they just fall back to
// the server's own deterministic description with no ai_explanation.
export function attachRecommendationExplanations(
  cards: ResultCard[],
  recommendations: ReasonerOutput["recommendations"],
): ResultCard[] {
  const byUniversityId = new Map(recommendations.map((item) => [item.universityId, item]));
  return cards.map((card) => {
    const recommendation = byUniversityId.get(card.university_id);
    if (!recommendation?.explanation) return card;
    return {
      ...card,
      ai_explanation: recommendation.explanation,
      explanation_fact_ids: recommendation.reasonFactIds,
      caution_fact_ids: recommendation.cautionFactIds,
    };
  });
}

export type ShortAnswerSource = "solar_reasoner" | "server_plus_solar" | "authoritative_template" | "deterministic_fallback" | "override";

// Server-determined facts for a classified (match_status-bearing) query --
// undefined when the query wasn't classified at all (a direct lookup, cost,
// deadline, ... answer), which the caller should treat as "no factual header
// to prepend", not "here's a fallback string" (that used to be this
// function's job, which meant a classified query's shortAnswer was *always*
// this template with the Solar reasoner's shortAnswer discarded outright,
// even when it had passed validation -- see composeShortAnswer below, which
// appends the reasoner's narrative after this instead of the caller
// choosing one or the other).
export function authoritativeFactsSummary(cards: ResultCard[]): string | undefined {
  const classified = cards.filter((card) => card.match_status === "matched" || card.match_status === "partial");
  if (!classified.length) return undefined;

  const matched = classified.filter((card) => card.match_status === "matched");
  const partial = classified.filter((card) => card.match_status === "partial");
  const lines: string[] = [];

  if (matched.length) {
    lines.push(`조건을 모두 충족한 대학은 **${matched.length}곳**입니다.`);
    lines.push(...matched.map((card) => `- ${card.university_name}`));
  } else {
    lines.push("현재 등록된 자료에서 모든 조건을 확인하고 충족한 대학은 없습니다.");
  }

  if (partial.length) {
    lines.push("", `추가로 **${partial.length}곳**은 일부 조건 확인이 필요합니다. 상세 결과에서 확인해 주세요.`);
  }

  return lines.join("\n");
}

// Pulled out of app/api/chat/route.ts's v2Response as a pure function so the
// partial-match name-leak rule below has a direct regression test instead of
// only being reachable through a full API request (see
// tests/reasoner-validation.test.ts).
export function composeShortAnswer(args: {
  cards: ResultCard[];
  narrative: string;
  shortAnswerOverride?: string;
  deterministicShortAnswer: string;
}): { shortAnswer: string; source: ShortAnswerSource } {
  if (args.shortAnswerOverride) return { shortAnswer: args.shortAnswerOverride, source: "override" };

  const factualHeader = authoritativeFactsSummary(args.cards);
  // CLAUDE.md: partially_matched university names must never appear in
  // shortAnswer, only their count -- but Solar's free-form narrative isn't
  // aware of that display rule and will happily name them (caught by
  // qa-runner: "...ICN Business School(프랑스), ..." for a partial-only
  // candidate). Only splice the narrative in when there's no partial match
  // for it to leak.
  const hasPartialMatches = args.cards.some((card) => card.match_status === "partial");
  const safeNarrative = hasPartialMatches ? "" : args.narrative;

  if (factualHeader) {
    return safeNarrative
      ? { shortAnswer: `${factualHeader}\n\n${safeNarrative}`, source: "server_plus_solar" }
      : { shortAnswer: factualHeader, source: "authoritative_template" };
  }
  if (args.narrative) return { shortAnswer: args.narrative, source: "solar_reasoner" };
  return { shortAnswer: args.deterministicShortAnswer, source: "deterministic_fallback" };
}
