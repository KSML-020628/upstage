import type { QueryPlan } from "./query-plan";
import type { Intent, QueryConstraints } from "./types";
import { normalizeSearchText } from "./utils";

function plannerIntent(intent: QueryPlan["intent"]): Intent | undefined {
  const map: Partial<Record<QueryPlan["intent"], Intent>> = {
    university_lookup: "general",
    university_recommendation: "general",
    language_requirement: "language",
    housing: "housing",
    cost: "cost",
    deadline: "deadline",
    quota: "quota",
    course_restriction: "restriction",
    source_request: "source",
    followup: "general",
  };
  return map[intent];
}

export function applyValidatedPlannerPlan(legacy: QueryConstraints, plan: QueryPlan | null): QueryConstraints {
  if (!plan) return legacy;
  const hard = plan.hardFilters;
  const plannedIntent = plannerIntent(plan.intent);
  const regions = (hard.regions ?? []).map(normalizeSearchText);
  const excludedRegions = (hard.excludedRegions ?? []).map(normalizeSearchText);
  const languageTest = hard.ieltsMax !== undefined ? "IELTS" : hard.toeflMax !== undefined ? "TOEFL" : legacy.languageTest;
  const languageScore = hard.ieltsMax ?? hard.toeflMax ?? legacy.languageScore;
  const resolvedIntent = legacy.intent !== "general" ? legacy.intent : (plannedIntent ?? legacy.intent);
  const requestedFields = [...new Set([...legacy.requestedFields, ...plan.requestedFields])];
  return {
    ...legacy,
    intent: resolvedIntent,
    topN: legacy.topN !== 4 ? legacy.topN : plan.limit,
    requireEurope: regions.some((item) => item === "europe") || legacy.requireEurope,
    requireAsia: regions.some((item) => item === "asia") || legacy.requireAsia,
    requireAmericas: regions.some((item) => /americas?|north america|south america/.test(item)) || legacy.requireAmericas,
    countries: legacy.countries.length ? legacy.countries : (hard.countries ?? []),
    excludedCountries: legacy.excludedCountries.length ? legacy.excludedCountries : (hard.excludedCountries ?? []),
    excludeAsia: excludedRegions.some((item) => item === "asia") || legacy.excludeAsia,
    requireHousing: hard.housingAvailable ?? hard.housingGuaranteed ?? legacy.requireHousing,
    requireHousingGuaranteed: hard.housingGuaranteed ?? legacy.requireHousingGuaranteed,
    deadlineSemester: (hard.semesters ?? []).some((item) => /spring|봄/i.test(item))
      ? "spring"
      : (hard.semesters ?? []).some((item) => /autumn|fall|가을/i.test(item))
        ? "autumn"
        : legacy.deadlineSemester,
    languageTest,
    languageScore,
    languageSubscore: hard.ieltsMinimumSubscore ?? legacy.languageSubscore,
    gpa: hard.gpaValue ?? legacy.gpa,
    quotaMin: hard.quotaMin ?? legacy.quotaMin,
    quotaMode: hard.quotaMin !== undefined ? "minimum" : legacy.quotaMode,
    major: hard.majors?.[0] ?? legacy.major,
    requireOfficialSource: hard.officialSourceRequired ?? legacy.requireOfficialSource,
    requireClearCost: hard.numericCostRequired ?? legacy.requireClearCost,
    requestedFields,
  };
}

export function plannerDifferences(legacy: QueryConstraints, plan: QueryPlan | null) {
  if (!plan) return ["planner_unavailable"];
  const differences: string[] = [];
  const plannedIntent = plannerIntent(plan.intent);
  if (plannedIntent && plannedIntent !== legacy.intent) differences.push(`intent:${legacy.intent}->${plannedIntent}`);
  if (plan.limit !== legacy.topN) differences.push(`limit:${legacy.topN}->${plan.limit}`);
  if (Boolean(plan.hardFilters.housingAvailable) !== legacy.requireHousing) differences.push("housing_filter");
  const plannedScore = plan.hardFilters.ieltsMax ?? plan.hardFilters.toeflMax;
  if (plannedScore !== undefined && plannedScore !== legacy.languageScore) differences.push("language_score");
  if (plan.hardFilters.quotaMin !== undefined && plan.hardFilters.quotaMin !== legacy.quotaMin) differences.push("quota_min");
  if (plan.followupReference.enabled !== false && !legacy.inScope) differences.push("followup_reference");
  return differences;
}

export function followupOrdinal(question: string) {
  const normalized = question.normalize("NFKC").toLowerCase();
  const match = normalized.match(/(?:^|\s)(\d+)\s*(?:번째|번|위)/);
  if (match) return Math.max(1, Number(match[1]));
  if (/첫\s*번째|첫째|first/.test(normalized)) return 1;
  if (/두\s*번째|둘째|second/.test(normalized)) return 2;
  if (/세\s*번째|셋째|third/.test(normalized)) return 3;
  return undefined;
}

const REASONING_EFFORT_VALUES = new Set(["minimal", "low", "medium", "high"]);
export function resolveReasoningEffort(): "minimal" | "low" | "medium" | "high" {
  const raw = process.env.SOLAR_REASONING_EFFORT;
  return raw && REASONING_EFFORT_VALUES.has(raw) ? raw as "minimal" | "low" | "medium" | "high" : "minimal";
}
