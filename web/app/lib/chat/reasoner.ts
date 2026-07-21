import type { EvidencePacket } from "./evidence-packet";

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

function numericTokens(text: string) {
  return text.match(/\d+(?:[,.]\d+)*/g)?.map((item) => item.replace(/,/g, "")) ?? [];
}

function validateReasonerOutput(value: unknown, packet: EvidencePacket): { output: ReasonerOutput | null; issues: string[] } {
  const issues: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return { output: null, issues: ["reasoner_output_not_object"] };
  const raw = value as Record<string, unknown>;
  const shortAnswer = typeof raw.shortAnswer === "string" ? raw.shortAnswer.trim().slice(0, 500) : "";
  if (!shortAnswer || /https?:\/\//i.test(shortAnswer)) return { output: null, issues: ["unsafe_short_answer"] };
  const evidenceText = JSON.stringify(packet);
  const allowedNumbers = new Set([...numericTokens(evidenceText), ...numericTokens(packet.question)]);
  if (numericTokens(shortAnswer).some((token) => !allowedNumbers.has(token))) return { output: null, issues: ["ungrounded_number"] };

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
    const explanation = typeof row.explanation === "string" ? row.explanation.trim().slice(0, 260) : "";
    if (/https?:\/\//i.test(explanation) || numericTokens(explanation).some((token) => !allowedNumbers.has(token))) {
      issues.push("unsafe_explanation");
      continue;
    }
    recommendations.push({ universityId, reasonFactIds: ids(row.reasonFactIds), cautionFactIds: ids(row.cautionFactIds), explanation });
  }
  const tabs = new Set(["summary", "requirements", "deadlines", "housing", "cost", "restrictions", "sources"]);
  const suggestedDetailTab = tabs.has(String(raw.suggestedDetailTab))
    ? String(raw.suggestedDetailTab) as ReasonerOutput["suggestedDetailTab"]
    : "summary";
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

export async function runSolarReasoner(args: { apiKey: string; model: string; packet: EvidencePacket }): Promise<ReasonerRun> {
  if (!args.packet.universities.length) return { output: null, usedSolar: false, issues: ["empty_evidence_packet"] };
  try {
    const response = await fetch("https://api.upstage.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${args.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: args.model,
        temperature: 0.1,
        max_tokens: 1000,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "Explain only the supplied evidence. Return JSON only. Never create a number, URL, university, or fact ID. Partial means additional verification is required." },
          { role: "user", content: `Write a concise Korean answer. Return {shortAnswer,recommendations:[{universityId,reasonFactIds,cautionFactIds,explanation}],unknownFields,suggestedDetailTab}. EVIDENCE_PACKET=${JSON.stringify(args.packet)}` },
        ],
      }),
      signal: AbortSignal.timeout(35_000),
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
