import type { DateComparator } from "./chat-policy";

// Canonical language-test names, shared by every place that produces or
// consumes QueryConstraints.languageTest (constraints.ts's regex detector,
// planner-integration.ts's merge of the Solar planner's plan, and
// filters.ts's matching/scoring logic). A mismatched string here (e.g.
// "IELTS" instead of "IELTS Academic") silently makes matchesLanguageTest
// find zero rows for every university, so languageEvaluation can never
// return "met" -- only "unknown" -- without ever throwing or logging
// anything wrong. Typing languageTest as this union instead of a bare
// string turns that class of bug into a compile error.
export const LANGUAGE_TEST_ALIASES = {
  "IELTS Academic": ["ielts"],
  "TOEFL iBT": ["toefl"],
  "Cambridge CAE/CPE": ["cambridge", "cae", "cpe"],
  "PTE Academic": ["pte", "pearson"],
  "Duolingo English Test": ["duolingo"],
  "Oxford ELLT": ["oxford", "ellt"],
} as const;
export type LanguageTestName = keyof typeof LANGUAGE_TEST_ALIASES;

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export type ChatSource = {
  fact_id?: string;
  title: string;
  url: string;
  university_name?: string;
  source_type?: string;
  is_official?: boolean;
  field_key?: string;
  evidence_quote?: string;
};

export type FactEvidence = {
  fact_id?: string;
  table: string;
  field_key: string;
  label: string;
  value: string;
  source_url?: string;
  source_title?: string;
  source_type?: string;
  evidence_quote?: string;
  confidence?: unknown;
  review_status?: unknown;
};

export type ResultCard = {
  university_id: string;
  university_name: string;
  country: string;
  city: string;
  summary: string;
  badges: string[];
  highlights: string[];
  action_label: string;
  action_url: string;
  source_url?: string;
  source_title?: string;
  source_type?: string;
  source_fact_id?: string;
  source_field_key?: string;
  evidence_quote?: string;
  fact_bundle?: FactEvidence[];
  match_status?: "matched" | "partial";
  condition_checks?: ConditionCheck[];
  unknown_fields?: string[];
  // Populated from the (already schema-validated, fact-ID-checked) Solar
  // reasoner's per-university recommendation, when one exists for this card.
  // Purely additive commentary alongside the server-determined facts above --
  // never a substitute for them. See app/api/chat/route.ts's v2Response.
  ai_explanation?: string;
  explanation_fact_ids?: string[];
  caution_fact_ids?: string[];
};

export type ConditionState = "met" | "unknown" | "failed";

export type ConditionCheck = {
  key: string;
  label: string;
  state: ConditionState;
  detail: string;
};

export type EvaluatedUniversity = {
  university: import("../types").University;
  checks: ConditionCheck[];
  status: "matched" | "partial" | "excluded";
};

export type Intent = "housing" | "language" | "cost" | "deadline" | "quota" | "restriction" | "source" | "general";

export type QuotaMode = "minimum" | "exists" | "missing" | "sort_desc";
export type DeadlineSemester = "autumn" | "spring";
export type DeadlineType = "application" | "nomination";

// A condition group a follow-up turn can explicitly ask to drop (e.g. "어학
// 성적 상관없이" after a prior turn set an IELTS score). Carried on the
// *current* turn's constraints, consumed by mergeConversationConstraints --
// see its comment for why "not mentioned this turn" and "explicitly asked
// to remove this turn" have to be distinguishable at all.
export type ClearableConditionField = "language" | "gpa" | "major" | "housing" | "budget" | "quota";

export type QueryConstraints = {
  intent: Intent;
  topN: number;
  // Whether topN came from an actual count in the user's own text (e.g.
  // "3개") rather than the arbitrary default of 4 -- distinguishes "the user
  // asked for exactly 4" from "the user didn't say a count", which the bare
  // number 4 alone can't (see planner-integration.ts's topN merge: the old
  // `legacy.topN !== 4` check silently treated its own default as "no
  // explicit count", which also meant a real explicit "4개" was
  // indistinguishable from no count at all).
  explicitTopN: boolean;
  requireEurope: boolean;
  requireAsia: boolean;
  requireAmericas: boolean;
  inScope: boolean;
  requireHousing: boolean;
  requireHousingGuaranteed: boolean;
  requireAll: boolean;
  requireOfficialSource: boolean;
  requireClearCost: boolean;
  countries: string[];
  excludedCountries: string[];
  excludeAsia: boolean;
  languageTest?: LanguageTestName;
  languageScore?: number;
  languageSubscore?: number;
  budgetKrwSemester?: number;
  gpa?: number;
  major?: string;
  quotaMin?: number;
  quotaMode?: QuotaMode;
  requireGpaKnown?: boolean;
  sortGpaLowest?: boolean;
  requireQuotaKnown?: boolean;
  requireHousingMissing?: boolean;
  sortDeadlineEarliest?: boolean;
  deadlineAcademicYear?: number;
  deadlineSemester?: DeadlineSemester;
  deadlineType?: DeadlineType;
  deadlineSpringOnly?: boolean;
  deadlineRequireClearYear?: boolean;
  deadlineComparator?: DateComparator;
  deadlineDate?: string;
  unsupportedReason?: "cost_of_living_index";
  requestedFields: string[];
  explicitClears: ClearableConditionField[];
};

export type CostComponent = {
  category: "tuition" | "housing" | "living";
  krw: number;
  label: string;
  row: Record<string, unknown>;
  source?: ChatSource;
};

export type CostEstimate = {
  normalizedKrw: number;
  label: string;
  sourceUrl?: string;
  sourceTitle?: string;
  sourceType?: string;
  evidenceQuote?: string;
  categoryCount: number;
  components: CostComponent[];
};

export type RankedCandidate = {
  university: import("../types").University;
  score: number;
  cost?: CostEstimate;
};

export type FactTableBundle = {
  costs: Record<string, unknown>[];
  housing: Record<string, unknown>[];
  languages: Record<string, unknown>[];
  deadlines: Record<string, unknown>[];
  quotas: Record<string, unknown>[];
};
