import type { EvidencePacket, EvidenceUniversity } from "./evidence-packet";

export type ReasonerOutput = {
  shortAnswer: string;
  recommendations: Array<{
    universityId: string;
    reasonFactIds: string[];
    cautionFactIds: string[];
    explanation: string;
  }>;
  unknownFields: string[];
  suggestedDetailTab: "summary" | "requirements" | "deadlines" | "housing" | "cost" | "restrictions" | "sources";
};

export type RecommendationStats = {
  generated: number;
  accepted: number;
  rejected: number;
};

export type ReasonerRun = {
  output: ReasonerOutput | null;
  usedSolar: boolean;
  issues: string[];
  recommendationStats: RecommendationStats;
};

function extractJson(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Reasoner did not return JSON");
  return JSON.parse(cleaned.slice(start, end + 1));
}

export function numericTokens(text: string) {
  return text.match(/\d+(?:[,.]\d+)*/g)?.map((item) => item.replace(/,/g, "")) ?? [];
}

// A recommendation's explanation may only cite numbers that appear in the
// SPECIFIC facts it cited (reasonFactIds/cautionFactIds) -- not every fact
// this university happens to have (a same-university IELTS fact's number
// could otherwise "ground" a sentence actually describing the TOEFL fact,
// or vice versa), and never the student's own stated number from the
// question. The question number is the student's *query constraint*, not a
// fact about this university -- allowing it as grounding let a partial
// university's true, different requirement get silently replaced by
// whatever score the student asked about (see docs/decisions.md).
function citedFactNumbers(university: EvidenceUniversity, factIds: string[]): Set<string> {
  const cited = university.facts.filter((fact) => factIds.includes(fact.factId));
  return new Set(numericTokens(JSON.stringify(cited.map((fact) => fact.displayValue))));
}

function topicPrefix(key: string): string {
  return key.split("_")[0];
}

export function validateReasonerOutput(value: unknown, packet: EvidencePacket): { output: ReasonerOutput | null; issues: string[]; recommendationStats: RecommendationStats } {
  const issues: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { output: null, issues: ["reasoner_output_not_object"], recommendationStats: { generated: 0, accepted: 0, rejected: 0 } };
  }
  const raw = value as Record<string, unknown>;

  // The top-level narrative and the per-university recommendations are
  // validated independently -- a bad/ungrounded shortAnswer must not throw
  // away otherwise-good per-university explanations (see docs/decisions.md).
  // This narrative can legitimately compare multiple universities in the
  // packet, so it's grounded against the whole packet rather than one
  // university's own facts.
  const rawShortAnswer = typeof raw.shortAnswer === "string" ? raw.shortAnswer.trim().slice(0, 500) : "";
  const packetNumbers = new Set([...numericTokens(JSON.stringify(packet)), ...numericTokens(packet.question)]);
  const shortAnswerValid = Boolean(rawShortAnswer)
    && !/https?:\/\//i.test(rawShortAnswer)
    && numericTokens(rawShortAnswer).every((token) => packetNumbers.has(token));
  if (!rawShortAnswer) issues.push("empty_short_answer");
  else if (!shortAnswerValid) issues.push("unsafe_short_answer");
  const shortAnswer = shortAnswerValid ? rawShortAnswer : "";

  const byUniversity = new Map(packet.universities.map((item) => [item.universityId, item]));
  const rawRecommendations = Array.isArray(raw.recommendations) ? raw.recommendations : [];
  const recommendations: ReasonerOutput["recommendations"] = [];
  let rejected = 0;
  for (const item of rawRecommendations) {
    if (!item || typeof item !== "object") { rejected += 1; continue; }
    const row = item as Record<string, unknown>;
    const universityId = typeof row.universityId === "string" ? row.universityId : "";
    const university = byUniversity.get(universityId);
    if (!university) { issues.push(`unknown_recommendation_university:${universityId || "empty"}`); rejected += 1; continue; }

    const allowedFactIds = new Set(university.facts.map((fact) => fact.factId));
    const ids = (input: unknown) => Array.isArray(input) ? input.filter((id): id is string => typeof id === "string" && allowedFactIds.has(id)) : [];
    const reasonFactIds = ids(row.reasonFactIds);
    const cautionFactIds = ids(row.cautionFactIds);

    const explanation = typeof row.explanation === "string" ? row.explanation.trim().slice(0, 260) : "";
    if (!explanation) { rejected += 1; continue; }
    const groundedNumbers = citedFactNumbers(university, [...reasonFactIds, ...cautionFactIds]);
    if (/https?:\/\//i.test(explanation) || numericTokens(explanation).some((token) => !groundedNumbers.has(token))) {
      issues.push(`unsafe_explanation:${universityId}`);
      rejected += 1;
      continue;
    }
    // "partial" means the server itself could not confirm every queried
    // condition for this university. An explanation that cites reasons but
    // discloses no caution *about the actual unresolved topic* reads as an
    // unqualified match -- i.e. Solar upgraded an unconfirmed/unknown
    // condition to a positive claim. A cautionFactId about some unrelated
    // topic (e.g. cost) does not count -- that's a bypass, not a real
    // disclosure of what's actually still unknown (e.g. housing guarantee).
    // Drop just this one recommendation (the card's own server-determined
    // facts are untouched) rather than let that stand.
    if (university.verdict === "partial") {
      const unresolvedTopics = new Set(university.unresolvedConditionKeys.map(topicPrefix));
      const cautionTopics = new Set(
        cautionFactIds
          .map((id) => university.facts.find((fact) => fact.factId === id)?.fieldKey)
          .filter((key): key is string => Boolean(key))
          .map(topicPrefix),
      );
      const disclosesRelevantCaution = unresolvedTopics.size > 0
        ? [...unresolvedTopics].some((topic) => cautionTopics.has(topic))
        : cautionFactIds.length > 0;
      if (!disclosesRelevantCaution) {
        issues.push(`unknown_upgraded_to_positive:${universityId}`);
        rejected += 1;
        continue;
      }
    }
    recommendations.push({ universityId, reasonFactIds, cautionFactIds, explanation });
  }
  const tabs = new Set(["summary", "requirements", "deadlines", "housing", "cost", "restrictions", "sources"]);
  const suggestedDetailTab = tabs.has(String(raw.suggestedDetailTab))
    ? String(raw.suggestedDetailTab) as ReasonerOutput["suggestedDetailTab"]
    : "summary";
  const recommendationStats: RecommendationStats = { generated: rawRecommendations.length, accepted: recommendations.length, rejected };

  // Only give up entirely when there's truly nothing usable -- a rejected
  // narrative with valid per-university recommendations (or vice versa)
  // still returns a real output, so route.ts can use whichever half worked.
  if (!shortAnswer && !recommendations.length) return { output: null, issues, recommendationStats };

  return {
    output: {
      shortAnswer,
      recommendations,
      unknownFields: Array.isArray(raw.unknownFields) ? raw.unknownFields.filter((item): item is string => typeof item === "string").slice(0, 12) : [],
      suggestedDetailTab,
    },
    issues,
    recommendationStats,
  };
}

const REASONER_OUTPUT_JSON_SCHEMA = {
  type: "object",
  properties: {
    shortAnswer: { type: "string" },
    recommendations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          universityId: { type: "string" },
          reasonFactIds: { type: "array", items: { type: "string" } },
          cautionFactIds: { type: "array", items: { type: "string" } },
          explanation: { type: "string" },
        },
        required: ["universityId", "reasonFactIds", "cautionFactIds", "explanation"],
        additionalProperties: false,
      },
    },
    unknownFields: { type: "array", items: { type: "string" } },
    suggestedDetailTab: {
      type: "string",
      enum: ["summary", "requirements", "deadlines", "housing", "cost", "restrictions", "sources"],
    },
  },
  required: ["shortAnswer", "recommendations", "unknownFields", "suggestedDetailTab"],
  additionalProperties: false,
} as const;

export async function runSolarReasoner(args: {
  apiKey: string;
  model: string;
  packet: EvidencePacket;
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
}): Promise<ReasonerRun> {
  const emptyStats: RecommendationStats = { generated: 0, accepted: 0, rejected: 0 };
  if (!args.packet.universities.length) return { output: null, usedSolar: false, issues: ["empty_evidence_packet"], recommendationStats: emptyStats };
  try {
    const response = await fetch("https://api.upstage.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${args.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: args.model,
        temperature: 0.1,
        max_tokens: 20_000,
        reasoning_effort: args.reasoningEffort ?? "minimal",
        response_format: {
          type: "json_schema",
          json_schema: { name: "reasoner_output", strict: true, schema: REASONER_OUTPUT_JSON_SCHEMA },
        },
        messages: [
          {
            role: "system",
            content:
              "Explain only the supplied evidence. Return JSON only. Never create a number, URL, university, or fact ID that is not in the evidence packet. "
              + "reasonFactIds and cautionFactIds must list EVERY fact whose value your explanation mentions -- if your explanation touches multiple topics (e.g. both a language score and a deadline), cite a fact for EACH topic, not just one of them; an uncited topic in the explanation is treated as fabricated even if the sentence is otherwise accurate. "
              + "Every number you write in a recommendation's explanation MUST come from a fact whose factId you listed in that SAME recommendation's reasonFactIds or cautionFactIds -- "
              + "never reuse a number from a different fact, a different university, or from the question text, even if it looks related (e.g. do not swap an IELTS score for a TOEFL score, and do not restate the student's own target score as if it were this university's official requirement). "
              + "If a university's verdict is 'partial', you must include in cautionFactIds a fact about whichever specific condition is still unconfirmed, and your explanation must not state or imply that unconfirmed condition is met. "
              + "When in doubt, write about fewer topics but cite all of them correctly, rather than covering more topics with an incomplete citation list.",
          },
          {
            role: "user",
            content:
              "Write a concise Korean answer. For each recommendation, list in reasonFactIds/cautionFactIds every fact your explanation for that university actually mentions, and mention only numbers that appear in the facts you cited for it. "
              + `Return {shortAnswer,recommendations:[{universityId,reasonFactIds,cautionFactIds,explanation}],unknownFields,suggestedDetailTab}. EVIDENCE_PACKET=${JSON.stringify(args.packet)}`,
          },
        ],
      }),
      // Runs after the planner in the same request (see query-plan.ts's
      // comment) -- 20s (planner) + 25s (this) = 45s, safely inside the 60s
      // Vercel maxDuration set in vercel.json even in the worst case where
      // both time out. Real measured latency at reasoning_effort=minimal is
      // 2-6s for the whole request; see docs/solar_usage.md.
      signal: AbortSignal.timeout(25_000),
    });
    if (!response.ok) throw new Error(`reasoner_http_${response.status}`);
    const json = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const raw = extractJson(json.choices?.[0]?.message?.content ?? "");
    const validated = validateReasonerOutput(raw, args.packet);
    return { output: validated.output, usedSolar: Boolean(validated.output), issues: validated.issues, recommendationStats: validated.recommendationStats };
  } catch (error) {
    console.error("[chat-v2] reasoner fallback", error instanceof Error ? error.message : error);
    return { output: null, usedSolar: false, issues: ["reasoner_failed"], recommendationStats: emptyStats };
  }
}
