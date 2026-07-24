import type { PlannerRun } from "./query-plan.ts";
import type { Intent, QueryConstraints, ResultCard } from "./types.ts";
import type { University } from "../types";
import { getUniversityCatalog } from "./university-catalog.ts";
import { groundPlannerFields } from "./planner-grounding.ts";
import {
  fetchLegacyFallbackFields,
  hydrateUniversitiesFromCatalog,
  queryRelevantUniversityFacts,
  resolveCandidateUniversityIds,
} from "./targeted-query.ts";

// Phase 3B step 1 scope: single-university lookups only. Recommendation-
// style queries (no named university, condition-based, region-wide,
// compound-condition, comparison/ranking of multiple universities, or
// follow-up-based re-ranking) are explicitly held back for a later canary
// expansion -- none of that logic exists here, and eligibility below
// enforces it structurally (exactly one already-resolved target, no
// follow-up context) rather than trusting intent alone.
export const TARGETED_PRIMARY_ALLOWED_INTENTS: ReadonlySet<Intent> = new Set([
  "general",
  "language",
  "housing",
  "deadline",
]);

const INTENT_TO_REQUESTED_FIELD: Partial<Record<Intent, string>> = {
  general: "universities",
  language: "language_requirements",
  housing: "housing_options",
  deadline: "application_deadlines",
};

export type TargetedPrimarySelectedPath = "targeted_primary" | "legacy_fallback" | "legacy_default";

export type TargetedPrimaryResult = {
  selectedPath: TargetedPrimarySelectedPath;
  // null exactly when selectedPath is "targeted_primary" (a successful,
  // safety-net-clean run) -- non-null whenever we fell back or never
  // attempted, always naming the specific reason for the fallback/skip log.
  fallbackReason: string | null;
  // Only set when selectedPath === "targeted_primary". The caller must keep
  // using its own already-computed legacy cards for every other case --
  // this function never asks the caller to treat a null cards value as "no
  // results", only as "not this path".
  cards: ResultCard[] | null;
};

function notAttempted(fallbackReason: string): TargetedPrimaryResult {
  return { selectedPath: "legacy_default", fallbackReason, cards: null };
}

function fellBack(fallbackReason: string): TargetedPrimaryResult {
  return { selectedPath: "legacy_fallback", fallbackReason, cards: null };
}

// Attempts to serve a single-university lookup from the Targeted Query
// Builder instead of the legacy full-load pipeline. Every exit that isn't a
// clean "targeted_primary" success falls back to the caller's own,
// already-computed legacy cards -- this function never lets a Targeted-side
// problem reach the user as a broken response, only as a fallback the
// caller was going to use anyway.
export async function resolveTargetedPrimary(args: {
  enabled: boolean;
  canaryRate: number;
  intent: Intent;
  exactTargets: University[];
  followupTargets: University[];
  planner: PlannerRun;
  finalInScope: boolean;
  question: string;
  constraints: QueryConstraints;
  legacyById: Map<string, University>;
}): Promise<TargetedPrimaryResult> {
  if (!args.enabled) return notAttempted("flag_disabled");
  if (!TARGETED_PRIMARY_ALLOWED_INTENTS.has(args.intent)) return notAttempted("intent_not_eligible");
  // First canary step is fresh, single-university lookups only -- a
  // follow-up (even one that ultimately narrows to one university) revisits
  // prior conversation state this step doesn't attempt to reproduce, and
  // "다수 대학 비교 및 랭킹"/"후속 질문 기반 재랭킹" are exactly the classes
  // held back for a later expansion.
  if (args.followupTargets.length !== 0) return notAttempted("followup_not_eligible");
  if (args.exactTargets.length !== 1) return notAttempted("not_single_target");
  if (!args.planner.validatedPlan) return notAttempted("no_validated_plan");
  if (!args.finalInScope) return notAttempted("out_of_scope");
  if (!(Math.random() < args.canaryRate)) return notAttempted("canary_miss");

  try {
    const catalog = await getUniversityCatalog();
    const grounded = groundPlannerFields({ question: args.question, validatedPlan: args.planner.validatedPlan });
    const intentField = INTENT_TO_REQUESTED_FIELD[args.intent];
    const groundedRequestedFields = [...new Set([
      ...(intentField ? [intentField] : []),
      ...(grounded.requestedFields.value.length ? grounded.requestedFields.value : args.constraints.requestedFields),
    ])];

    const providedUniversityIds = args.exactTargets.map((university) => university.id);
    const { ids: candidateIds, source: candidateSource } = await resolveCandidateUniversityIds({
      plan: args.planner.validatedPlan,
      catalog,
      providedUniversityIds,
      groundedHousingAvailable: args.constraints.requireHousing,
      groundedHousingGuaranteed: args.constraints.requireHousingGuaranteed,
      groundedLanguageTest: args.constraints.languageTest,
    });

    // A single-university-lookup candidate set must be exactly the one
    // already-confirmed target -- anything else means candidate resolution
    // diverged from a target we'd already resolved with confidence, which
    // is precisely the kind of surprise this first canary step must not
    // risk shipping to a real user.
    if (candidateIds.length !== 1 || candidateIds[0] !== providedUniversityIds[0]) {
      return fellBack("validation_failed");
    }

    const targeted = await queryRelevantUniversityFacts(candidateIds, groundedRequestedFields, candidateSource);
    if (targeted.errors.length) return fellBack("targeted_error");
    // Unsupported fields (course_restrictions/source_links -- no dedicated
    // fact table) are handled as an explicit legacy-fallback-composited
    // value for shadow-parity purposes, but for the real primary path this
    // canary step falls all the way back to legacy instead of shipping a
    // partially-composited result as if the Targeted path had produced it
    // independently.
    if (targeted.unsupportedFields.length) return fellBack("unsupported_field");

    const candidateCatalogItems = catalog.filter((item) => item.universityId === candidateIds[0]);
    const legacyFallback = await fetchLegacyFallbackFields(candidateIds);
    const targetedUniversities = hydrateUniversitiesFromCatalog(candidateCatalogItems, targeted.factBundles, args.legacyById, legacyFallback.data);
    // Lazy import: selection.ts also exports unknownInstitutionResponse,
    // which pulls in next/server -- fine under Next's own bundler, but it
    // breaks a plain `node --test` run of this module's eligibility-gate
    // tests (which never reach this line) if imported at module top level.
    const { selectCards } = await import("./selection.ts");
    const targetedCards = selectCards(targetedUniversities, args.constraints, args.question);

    if (!targetedCards.length) return fellBack("empty_result");

    return { selectedPath: "targeted_primary", fallbackReason: null, cards: targetedCards };
  } catch (error) {
    return fellBack(error instanceof Error ? `targeted_error:${error.message}` : "targeted_error");
  }
}
