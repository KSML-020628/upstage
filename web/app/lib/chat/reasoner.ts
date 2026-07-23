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

export type ReasonerRun = {
  output: ReasonerOutput | null;
  usedSolar: boolean;
  issues: string[];
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

// A recommendation's explanation may only cite numbers that appear in *that
// university's own* facts/condition detail, plus numbers the student
// themselves stated in the question (their own criteria are fair game to
// repeat back for any university). It must NOT be validated against the
// whole evidence packet -- that let a number from University A's facts
// silently ground a false claim attributed to University B's
// recommendation, since both were in the same multi-university packet.
function universityGroundedNumbers(university: EvidenceUniversity, question: string): Set<string> {
  const universityText = `${JSON.stringify(university.facts)} ${university.conditionSummary.join(" ")}`;
  return new Set([...numericTokens(universityText), ...numericTokens(question)]);
}

export function validateReasonerOutput(value: unknown, packet: EvidencePacket): { output: ReasonerOutput | null; issues: string[] } {
  const issues: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return { output: null, issues: ["reasoner_output_not_object"] };
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
  for (const item of rawRecommendations) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const universityId = typeof row.universityId === "string" ? row.universityId : "";
    const university = byUniversity.get(universityId);
    if (!university) { issues.push("unknown_recommendation_university"); continue; }

    const allowedFactIds = new Set(university.facts.map((fact) => fact.factId));
    const ids = (input: unknown) => Array.isArray(input) ? input.filter((id): id is string => typeof id === "string" && allowedFactIds.has(id)) : [];
    const reasonFactIds = ids(row.reasonFactIds);
    const cautionFactIds = ids(row.cautionFactIds);

    const explanation = typeof row.explanation === "string" ? row.explanation.trim().slice(0, 260) : "";
    if (!explanation) continue;
    const groundedNumbers = universityGroundedNumbers(university, packet.question);
    if (/https?:\/\//i.test(explanation) || numericTokens(explanation).some((token) => !groundedNumbers.has(token))) {
      issues.push(`unsafe_explanation:${universityId}`);
      continue;
    }
    // "partial" means the server itself could not confirm every queried
    // condition for this university. An explanation that cites reasons but
    // discloses zero caution reads as an unqualified match -- i.e. Solar
    // upgraded an unconfirmed/unknown condition to a positive claim. Drop
    // just this one recommendation (the card's own server-determined facts
    // are untouched) rather than let that stand.
    if (university.verdict === "partial" && cautionFactIds.length === 0) {
      issues.push(`unknown_upgraded_to_positive:${universityId}`);
      continue;
    }
    recommendations.push({ universityId, reasonFactIds, cautionFactIds, explanation });
  }
  const tabs = new Set(["summary", "requirements", "deadlines", "housing", "cost", "restrictions", "sources"]);
  const suggestedDetailTab = tabs.has(String(raw.suggestedDetailTab))
    ? String(raw.suggestedDetailTab) as ReasonerOutput["suggestedDetailTab"]
    : "summary";

  // Only give up entirely when there's truly nothing usable -- a rejected
  // narrative with valid per-university recommendations (or vice versa)
  // still returns a real output, so route.ts can use whichever half worked.
  if (!shortAnswer && !recommendations.length) return { output: null, issues };

  return {
    output: {
      shortAnswer,
      recommendations,
      unknownFields: Array.isArray(raw.unknownFields) ? raw.unknownFields.filter((item): item is string => typeof item === "string").slice(0, 12) : [],
      suggestedDetailTab,
    },
    issues,
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
  if (!args.packet.universities.length) return { output: null, usedSolar: false, issues: ["empty_evidence_packet"] };
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
          { role: "system", content: "Explain only the supplied evidence. Return JSON only. Never create a number, URL, university, or fact ID. Partial means additional verification is required." },
          { role: "user", content: `Write a concise Korean answer. Return {shortAnswer,recommendations:[{universityId,reasonFactIds,cautionFactIds,explanation}],unknownFields,suggestedDetailTab}. EVIDENCE_PACKET=${JSON.stringify(args.packet)}` },
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
    return { output: validated.output, usedSolar: Boolean(validated.output), issues: validated.issues };
  } catch (error) {
    console.error("[chat-v2] reasoner fallback", error instanceof Error ? error.message : error);
    return { output: null, usedSolar: false, issues: ["reasoner_failed"] };
  }
}
