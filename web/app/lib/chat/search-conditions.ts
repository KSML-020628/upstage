import type { QueryConstraints } from "./types";

export function hasRecommendationConditions(constraints: QueryConstraints) {
  return Boolean(
      constraints.requireEurope ||
      constraints.requireAsia ||
      constraints.requireAmericas ||
      constraints.countries.length ||
      constraints.excludedCountries.length ||
      constraints.excludeAsia ||
      constraints.requireHousing ||
      constraints.requireHousingGuaranteed ||
      constraints.deadlineSemester !== undefined ||
      constraints.languageScore !== undefined ||
      constraints.gpa !== undefined ||
      constraints.major ||
      constraints.quotaMin !== undefined ||
      constraints.quotaMode !== undefined ||
      constraints.requireGpaKnown ||
      constraints.sortGpaLowest ||
      constraints.requireQuotaKnown ||
      constraints.requireHousingMissing ||
      constraints.requireOfficialSource,
  );
}

// Whether the FINAL merged constraints (legacy regex conditions folded
// together with whatever the Planner contributed) already carry an
// actionable search condition -- used by the target-clarification decision
// instead of plannerHasSearchConditions(planner.validatedPlan), which only
// looked at the Planner's own hardFilters. That missed cases where Solar
// returned a completely empty hardFilters object for a run (a real,
// measured occurrence -- see docs/decisions.md's q4 diagnostic) even though
// the LEGACY regex side already had a real condition (e.g. excludeAsia from
// "아시아 빼고", or a deadline comparator from "2026-05-01 이후"), wrongly
// asking "which university?" for a question that was already a valid
// collection search. Deadline date/comparator/year are included here on top
// of hasRecommendationConditions because the Planner has no equivalent
// field for them at all (they're regex-only), so they'd never show up in
// plannerHasSearchConditions regardless of source.
export function hasActionableSearchConditions(constraints: QueryConstraints) {
  return (
    hasRecommendationConditions(constraints) ||
    constraints.deadlineComparator !== undefined ||
    constraints.deadlineDate !== undefined ||
    constraints.deadlineAcademicYear !== undefined
  );
}
