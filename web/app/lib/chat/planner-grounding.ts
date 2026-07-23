import type { QueryPlan } from "./query-plan.ts";

// query-plan.ts's validateQueryPlan already grounds regions/countries/
// numbers(ielts/gpa/quota)/limit against the question text. It does NOT
// ground housingAvailable, housingGuaranteed, semesters, majors,
// officialSourceRequired, numericCostRequired, or requestedFields -- those
// were taken from Solar's raw output as-is (see docs/decisions.md, flagged
// during the Phase 2.5 merge-function audit as "found, not fixed"). This
// module is the fix: a second, independent grounding pass over exactly
// those fields, feeding the Targeted Query Builder (Phase 3A, shadow-only --
// NOT wired into the real response path, which still uses
// applyValidatedPlannerPlan/query-plan.ts's own validation unchanged).
export type ConstraintProvenance = "current_turn" | "conversation_context" | "default" | "planner_ungrounded";

export type GroundedField<T> = {
  value: T;
  provenance: ConstraintProvenance;
};

export type GroundedPlan = {
  includedRegions: GroundedField<string[]>;
  excludedRegions: GroundedField<string[]>;
  includedCountries: GroundedField<string[]>;
  excludedCountries: GroundedField<string[]>;
  housingAvailable: GroundedField<boolean | undefined>;
  housingGuaranteed: GroundedField<boolean | undefined>;
  semesters: GroundedField<string[]>;
  majors: GroundedField<string[]>;
  officialSourceRequired: GroundedField<boolean | undefined>;
  requireClearCost: GroundedField<boolean | undefined>;
  requestedFields: GroundedField<string[]>;
  limit: GroundedField<number | undefined>;
  issues: string[];
};

const HOUSING_AVAILABLE_PATTERN = /기숙|숙소|주거|housing|accommodation|dorm|residence/i;
// "{0,3}" tolerates a short particle/gap between 배정 and 보장 (e.g. "배정이
// 보장") without becoming loose enough to match unrelated text between them
// -- see the matching fix in constraints.ts's requireHousingGuaranteed.
const HOUSING_GUARANTEED_PATTERN = /기숙사?\s*(?:배정[^\n]{0,3}\s*)?(?:보장|확약)|housing[^\n]{0,24}guaranteed|guaranteed[^\n]{0,24}(?:housing|accommodation)/i;
const SEMESTER_PATTERN = /봄|spring|가을|autumn|fall/i;
const OFFICIAL_SOURCE_PATTERN = /공식|출처|official|source|링크|근거/i;
const COST_PATTERN = /비용|금액|예산|환산|생활비|학비|등록금|cost|budget|fee|tuition/i;
const EXPLICIT_COUNT_PATTERN = /(\d+)\s*(개|곳|schools?|universities?)|(\d+)\s*(cheapest|lowest|best|recommended|추천)|(?:recommend|show|pick|select|top)\s*(?:the\s*)?(\d+)|(\d+)\s*(?:개|곳|군데|학교|대학)/i;

// Mirrors detectMajor's keyword sets (constraints.ts) -- deliberately
// duplicated rather than imported: that function returns a single normalized
// major id from a question, while this needs to check whether a given
// Planner-claimed major string is independently grounded in the SAME
// question, which is a different question ("is this specific claim
// supported?" vs "what's the one best guess?").
const MAJOR_KEYWORDS: Record<string, RegExp> = {
  engineering: /컴퓨터|소프트웨어|software|computer|공학|engineering|\bcs\b|\bit\b/,
  business: /경영|경제|business|management|economics/,
  humanities: /인문|사회|humanities|social/,
  science: /자연과학|과학|science|biology|chemistry|physics/,
  arts: /예술|디자인|건축|art|design|architecture/,
};

// Maps a requestedFields entry to the question-text signal that justifies
// asking for it. "universities" (general info) has no dedicated topic
// keyword -- it's always allowed, since every question is at minimum a
// request for basic university info.
const REQUESTED_FIELD_PATTERNS: Record<string, RegExp | null> = {
  universities: null,
  language_requirements: /어학|영어|language|ielts|toefl|cefr|english/i,
  housing_options: HOUSING_AVAILABLE_PATTERN,
  estimated_costs: COST_PATTERN,
  application_deadlines: /마감|일정|deadline|application|nomination/i,
  quota_facts: /정원|쿼터|인원|quota/i,
  course_restrictions: /수강\s*제한|전공\s*제한|선수\s*과목|restricted|restriction|prerequisite/i,
  source_links: OFFICIAL_SOURCE_PATTERN,
};

function textOf(question: string, conversationText?: string) {
  return {
    current: question.normalize("NFKC"),
    context: conversationText?.normalize("NFKC") ?? "",
  };
}

function groundBoolean(
  claimed: boolean | undefined,
  pattern: RegExp,
  current: string,
  context: string,
  issueCode: string,
  issues: string[],
): GroundedField<boolean | undefined> {
  if (claimed === undefined) return { value: undefined, provenance: "default" };
  if (pattern.test(current)) return { value: claimed, provenance: "current_turn" };
  if (pattern.test(context)) return { value: claimed, provenance: "conversation_context" };
  issues.push(issueCode);
  return { value: undefined, provenance: "planner_ungrounded" };
}

function groundStringList(
  claimed: string[],
  pattern: RegExp,
  current: string,
  context: string,
  issuePrefix: string,
  issues: string[],
): GroundedField<string[]> {
  if (!claimed.length) return { value: [], provenance: "default" };
  if (pattern.test(current)) return { value: claimed, provenance: "current_turn" };
  if (pattern.test(context)) return { value: claimed, provenance: "conversation_context" };
  for (const item of claimed) issues.push(`${issuePrefix}:${item}`);
  return { value: [], provenance: "planner_ungrounded" };
}

export function groundPlannerFields(args: {
  question: string;
  conversationText?: string;
  validatedPlan: QueryPlan | null;
}): GroundedPlan {
  const issues: string[] = [];
  const { current, context } = textOf(args.question, args.conversationText);
  const plan = args.validatedPlan;

  if (!plan) {
    const empty: GroundedField<string[]> = { value: [], provenance: "default" };
    const emptyBool: GroundedField<boolean | undefined> = { value: undefined, provenance: "default" };
    return {
      includedRegions: empty,
      excludedRegions: empty,
      includedCountries: empty,
      excludedCountries: empty,
      housingAvailable: emptyBool,
      housingGuaranteed: emptyBool,
      semesters: empty,
      majors: empty,
      officialSourceRequired: emptyBool,
      requireClearCost: emptyBool,
      requestedFields: empty,
      limit: { value: undefined, provenance: "default" },
      issues,
    };
  }

  // regions/countries/limit's own number are already grounded by
  // validateQueryPlan (query-plan.ts) -- surfaced here as "current_turn" when
  // non-empty, purely for a single consistent GroundedPlan shape. Genuinely
  // re-deriving provenance for these would duplicate query-plan.ts's own
  // (already tested) grounding logic for no benefit.
  const includedRegions: GroundedField<string[]> = {
    value: plan.hardFilters.regions ?? [],
    provenance: (plan.hardFilters.regions?.length ?? 0) > 0 ? "current_turn" : "default",
  };
  const excludedRegions: GroundedField<string[]> = {
    value: plan.hardFilters.excludedRegions ?? [],
    provenance: (plan.hardFilters.excludedRegions?.length ?? 0) > 0 ? "current_turn" : "default",
  };
  const includedCountries: GroundedField<string[]> = {
    value: plan.hardFilters.countries ?? [],
    provenance: (plan.hardFilters.countries?.length ?? 0) > 0 ? "current_turn" : "default",
  };
  const excludedCountries: GroundedField<string[]> = {
    value: plan.hardFilters.excludedCountries ?? [],
    provenance: (plan.hardFilters.excludedCountries?.length ?? 0) > 0 ? "current_turn" : "default",
  };

  const housingAvailable = groundBoolean(
    plan.hardFilters.housingAvailable, HOUSING_AVAILABLE_PATTERN, current, context,
    "planner_ungrounded_housing_available", issues,
  );
  // Never conflate housingAvailable with housingGuaranteed: a question that
  // only asks whether housing exists/can be applied for must not let a
  // guarantee claim through on the same evidence -- each gets its own
  // pattern and its own grounding check.
  const housingGuaranteed = groundBoolean(
    plan.hardFilters.housingGuaranteed, HOUSING_GUARANTEED_PATTERN, current, context,
    "planner_ungrounded_housing_guaranteed", issues,
  );

  const semesters = groundStringList(
    plan.hardFilters.semesters ?? [], SEMESTER_PATTERN, current, context,
    "planner_ungrounded_semester", issues,
  );

  const claimedMajors = plan.hardFilters.majors ?? [];
  const groundedMajors = claimedMajors.filter((major) => {
    const pattern = MAJOR_KEYWORDS[major];
    if (!pattern) { issues.push(`planner_ungrounded_major:${major}`); return false; }
    if (pattern.test(current) || pattern.test(context)) return true;
    issues.push(`planner_ungrounded_major:${major}`);
    return false;
  });
  const majors: GroundedField<string[]> = {
    value: groundedMajors,
    provenance: !claimedMajors.length ? "default" : groundedMajors.length ? "current_turn" : "planner_ungrounded",
  };

  const officialSourceRequired = groundBoolean(
    plan.hardFilters.officialSourceRequired, OFFICIAL_SOURCE_PATTERN, current, context,
    "planner_ungrounded_official_source", issues,
  );
  const requireClearCost = groundBoolean(
    plan.hardFilters.numericCostRequired, COST_PATTERN, current, context,
    "planner_ungrounded_cost", issues,
  );

  const claimedFields = plan.requestedFields ?? [];
  const groundedFields = claimedFields.filter((field) => {
    const pattern = REQUESTED_FIELD_PATTERNS[field];
    if (pattern === null) return true; // "universities" -- always allowed
    if (pattern === undefined) { issues.push(`planner_unsupported_requested_field:${field}`); return false; }
    if (pattern.test(current) || pattern.test(context)) return true;
    issues.push(`planner_unsupported_requested_field:${field}`);
    return false;
  });
  const requestedFields: GroundedField<string[]> = {
    value: groundedFields,
    provenance: !claimedFields.length ? "default" : groundedFields.length ? "current_turn" : "planner_ungrounded",
  };

  // limit: query-plan.ts's validateQueryPlan already resets an ungrounded
  // Planner limit to the neutral default (4) before this ever runs, so
  // there's nothing left here to reject -- this only classifies whether the
  // CURRENT question itself carries an explicit count, for provenance
  // reporting (a limit of exactly 4 is ambiguous between "the user said 4"
  // and "no count was ever grounded" without this check).
  const explicitCount = EXPLICIT_COUNT_PATTERN.test(current);
  const limit: GroundedField<number | undefined> = explicitCount
    ? { value: plan.limit, provenance: "current_turn" }
    : EXPLICIT_COUNT_PATTERN.test(context)
      ? { value: plan.limit, provenance: "conversation_context" }
      : { value: plan.limit, provenance: "default" };

  return {
    includedRegions,
    excludedRegions,
    includedCountries,
    excludedCountries,
    housingAvailable,
    housingGuaranteed,
    semesters,
    majors,
    officialSourceRequired,
    requireClearCost,
    requestedFields,
    limit,
    issues,
  };
}
