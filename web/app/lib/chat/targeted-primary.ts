import type { PlannerRun } from "./query-plan.ts";
import type { Intent, QueryConstraints, ResultCard } from "./types.ts";
import type { UniversityCatalogItem } from "./university-catalog.ts";
import { groundPlannerFields } from "./planner-grounding.ts";
import {
  hydrateUniversitiesFromCatalog,
  queryRelevantUniversityFacts,
  resolveCandidateUniversityIds,
} from "./targeted-query.ts";

// Phase 3B step 2 scope: unchanged from step 1 -- single-university lookups
// only. Recommendation-style queries (no named university, condition-based,
// region-wide, compound-condition, comparison/ranking of multiple
// universities, or follow-up-based re-ranking) are explicitly held back for
// a later canary expansion -- none of that logic exists here, and
// eligibility below enforces it structurally (exactly one already-resolved
// catalog target, no follow-up context) rather than trusting intent alone.
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

// Deterministic djb2-style string hash, folded into a 0-9999 bucket. Used
// instead of a bare Math.random() roll so the same canary key (a session id
// when the client sends one, a request id otherwise -- see route.ts) always
// lands on the same side of the canary split. Without this, a single real
// user could bounce between the Targeted and Legacy paths from one message
// to the next within the same conversation purely by chance, which would be
// a confusing, avoidable inconsistency once canary rate is ever raised
// above 0 in production (not done as part of this step -- see docs/
// decisions.md; still 0/off by default, still requires separate approval).
export function stableCanaryBucket(key: string): number {
  let hash = 5381;
  for (let index = 0; index < key.length; index += 1) {
    hash = ((hash << 5) + hash + key.charCodeAt(index)) >>> 0;
  }
  // djb2's raw accumulator has poor avalanche behavior for near-identical
  // keys: "session-1" vs "session-2" differ by exactly 1 in the final
  // accumulated value, since the shared prefix computation is identical --
  // confirmed live, this clustered 10 sequential session ids onto the same
  // side of a 50% canary split instead of splitting roughly evenly. This is
  // a Murmur3-style finalizer (fmix32) that scrambles the bits so a single
  // trailing-character difference no longer produces a near-identical
  // bucket; verified against 1000 sequential keys landing at ~54/46, not a
  // near-100/0 split.
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b) >>> 0;
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
  hash = (hash ^ (hash >>> 16)) >>> 0;
  return hash % 10_000;
}

export function canaryRollFor(key: string, rate: number): boolean {
  return stableCanaryBucket(key) < rate * 10_000;
}

// Attempts to serve a single-university lookup from the Targeted Query
// Builder BEFORE the legacy full-load pipeline ever runs -- unlike step 1
// (which ran this after getChatUniversities() had already loaded
// everything), a successful run here means getChatUniversities() is never
// called at all for this request. Every exit that isn't a clean
// "targeted_primary" success tells the caller to lazily load legacy from
// scratch and use the existing full-load flow -- this function never lets
// a Targeted-side problem reach the user as a broken response.
export async function attemptTargetedFastPath(args: {
  enabled: boolean;
  canaryRate: number;
  canaryKey: string;
  intent: Intent;
  // Resolved via the lightweight catalog (alias + Planner name matching)
  // BEFORE any full legacy load -- never the legacy regex/token matcher
  // (findTargetUniversities), which needs full University objects (city,
  // etc.) the catalog doesn't have. If catalog-based resolution comes up
  // empty, this function is simply not eligible; the caller's fallback to
  // the full legacy flow will still try the regex matcher as it always has.
  catalogExactTargetIds: string[];
  // True whenever this request would use follow-up/previous-turn context
  // (explicitFollowup || planner.validatedPlan?.followupReference.enabled,
  // adjusted for explicit geography) -- computable without any University
  // data, so eligibility can rule this out before a full load happens.
  hasFollowupContext: boolean;
  planner: PlannerRun;
  finalInScope: boolean;
  question: string;
  constraints: QueryConstraints;
  catalog: UniversityCatalogItem[];
}): Promise<TargetedPrimaryResult> {
  if (!args.enabled) return notAttempted("flag_disabled");
  if (!TARGETED_PRIMARY_ALLOWED_INTENTS.has(args.intent)) return notAttempted("intent_not_eligible");
  if (args.hasFollowupContext) return notAttempted("followup_not_eligible");
  if (args.catalogExactTargetIds.length !== 1) return notAttempted("not_single_target");
  if (!args.planner.validatedPlan) return notAttempted("no_validated_plan");
  if (!args.finalInScope) return notAttempted("out_of_scope");
  if (!canaryRollFor(args.canaryKey, args.canaryRate)) return notAttempted("canary_miss");

  const targetId = args.catalogExactTargetIds[0];
  try {
    const grounded = groundPlannerFields({ question: args.question, validatedPlan: args.planner.validatedPlan });
    const intentField = INTENT_TO_REQUESTED_FIELD[args.intent];
    const groundedRequestedFields = [...new Set([
      ...(intentField ? [intentField] : []),
      ...(grounded.requestedFields.value.length ? grounded.requestedFields.value : args.constraints.requestedFields),
    ])];

    const { ids: candidateIds, source: candidateSource } = await resolveCandidateUniversityIds({
      plan: args.planner.validatedPlan,
      catalog: args.catalog,
      providedUniversityIds: [targetId],
      groundedHousingAvailable: args.constraints.requireHousing,
      groundedHousingGuaranteed: args.constraints.requireHousingGuaranteed,
      groundedLanguageTest: args.constraints.languageTest,
    });

    // A single-university-lookup candidate set must be exactly the one
    // already-confirmed target -- anything else means candidate resolution
    // diverged from a target we'd already resolved with confidence, which
    // is precisely the kind of surprise this canary step must not risk
    // shipping to a real user.
    if (candidateIds.length !== 1 || candidateIds[0] !== targetId) {
      return fellBack("validation_failed");
    }

    const targeted = await queryRelevantUniversityFacts(candidateIds, groundedRequestedFields, candidateSource);
    if (targeted.errors.length) return fellBack("targeted_error");
    // Unsupported fields (course_restrictions/source_links -- no dedicated
    // fact table) fall all the way back to legacy instead of shipping a
    // partially-composited result as if the Targeted path had produced it
    // independently -- same conservative bar as step 1.
    if (targeted.unsupportedFields.length) return fellBack("unsupported_field");

    // Scoped, single-university identity fetch (city/summary/
    // profile_sections/source_links/academic_year/program_name) -- NOT the
    // full legacy load. getUniversity() (supabase.ts) already derives all
    // of these from its own single canonical_facts fetch for this one id,
    // so no separate fetchLegacyFallbackFields call is needed here; that
    // would just be a second, duplicate scoped fetch for data this one
    // call already provides.
    const { getUniversity } = await import("../supabase.ts");
    const identity = await getUniversity(targetId);
    if (!identity) return fellBack("validation_failed");

    const candidateCatalogItems = args.catalog.filter((item) => item.universityId === targetId);
    const legacyById = new Map([[targetId, identity]]);
    const targetedUniversities = hydrateUniversitiesFromCatalog(candidateCatalogItems, targeted.factBundles, legacyById, new Map());

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
