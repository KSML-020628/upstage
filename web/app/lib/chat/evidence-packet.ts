import type { QueryPlan } from "./query-plan";

export type EvidenceFact = {
  factId: string;
  universityId: string;
  fieldKey: string;
  displayValue: string;
  sourceUrl?: string;
  sourceTitle?: string;
  sourceType?: string;
  evidenceQuote?: string;
};

export type EvidenceUniversity = {
  universityId: string;
  universityName: string;
  country: string;
  city: string;
  verdict: "matched" | "partial";
  conditionSummary: string[];
  // condition_checks[].key values whose state is "unknown" for this
  // university -- e.g. "housing_guaranteed". Lets the reasoner's validation
  // check that a "partial" verdict's caution disclosure is actually about
  // the topic that's unresolved, not just any unrelated caution fact (see
  // reasoner.ts's unknown-upgrade guard).
  unresolvedConditionKeys: string[];
  facts: EvidenceFact[];
};

export type EvidencePacket = {
  question: string;
  queryPlan: QueryPlan | null;
  universities: EvidenceUniversity[];
  unknownFields: string[];
};

type CardFact = {
  fact_id?: string;
  field_key?: string;
  label?: string;
  value?: string;
  source_url?: string;
  source_title?: string;
  source_type?: string;
  evidence_quote?: string;
};

type EvidenceCard = {
  university_id: string;
  university_name: string;
  country: string;
  city: string;
  match_status?: "matched" | "partial";
  highlights?: string[];
  unknown_fields?: string[];
  condition_checks?: Array<{ key: string; label: string; state: string; detail: string }>;
  fact_bundle?: CardFact[];
};

export function createEvidencePacket(question: string, queryPlan: QueryPlan | null, cards: EvidenceCard[]): EvidencePacket {
  const seenFacts = new Set<string>();
  const universities = cards.filter((card) => card.match_status !== undefined).map((card) => {
    const facts = (card.fact_bundle ?? []).flatMap((fact, index) => {
      const factId = fact.fact_id || `${card.university_id}:${fact.field_key || "fact"}:${index}`;
      const key = `${card.university_id}:${factId}`;
      if (seenFacts.has(key)) return [];
      seenFacts.add(key);
      return [{
        factId,
        universityId: card.university_id,
        fieldKey: fact.field_key || "fact",
        displayValue: fact.value || fact.label || "",
        sourceUrl: fact.source_url,
        sourceTitle: fact.source_title,
        sourceType: fact.source_type,
        evidenceQuote: fact.evidence_quote?.slice(0, 500),
      }];
    });
    return {
      universityId: card.university_id,
      universityName: card.university_name,
      country: card.country,
      city: card.city,
      verdict: card.match_status === "matched" ? "matched" as const : "partial" as const,
      conditionSummary: (card.condition_checks ?? []).map((check) => `${check.label}: ${check.state} (${check.detail})`).slice(0, 12),
      unresolvedConditionKeys: (card.condition_checks ?? []).filter((check) => check.state === "unknown").map((check) => check.key),
      facts,
    };
  });
  return {
    question,
    queryPlan,
    universities,
    unknownFields: [...new Set(cards.flatMap((card) => card.unknown_fields ?? []))],
  };
}
