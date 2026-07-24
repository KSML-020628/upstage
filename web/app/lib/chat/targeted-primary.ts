import type { PlannerRun } from "./query-plan.ts";
import type { Intent, QueryConstraints, ResultCard } from "./types.ts";
import type { UniversityCatalogItem } from "./university-catalog.ts";
import type { University } from "../types";
import { groundPlannerFields } from "./planner-grounding.ts";
import {
  hydrateUniversitiesFromCatalog,
  queryRelevantUniversityFacts,
  resolveCandidateUniversityIds,
} from "./targeted-query.ts";

// Test-only dependency injection (Phase 3B step 3 requirement: reproduce
// targeted_error/empty_result/validation_failed without mutating real
// catalog/database data). Every field is optional and defaults to the real
// implementation below -- route.ts's real, production call site NEVER
// passes this object, so this can only ever change behavior when a test
// file explicitly constructs and passes one. Not gated by an env var here
// on purpose: the safety boundary lives at the ONE call site (route.ts),
// which additionally gates it behind NODE_ENV === "test" before it will
// ever forward a caller-supplied override into this function.
export type TargetedPrimaryDeps = {
  resolveCandidateUniversityIds?: typeof resolveCandidateUniversityIds;
  queryRelevantUniversityFacts?: typeof queryRelevantUniversityFacts;
  getUniversity?: (id: string) => Promise<University | undefined>;
  selectCards?: (universities: University[], constraints: QueryConstraints, question: string) => ResultCard[];
};

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
  // Explicit operational fields (not just derivable from selectedPath) so a
  // production canary dashboard can compute Targeted success rate, legacy
  // load skip rate, and fallback rate directly from the log without each
  // consumer re-deriving the same selectedPath -> boolean mapping.
  targetedAttempted: boolean;
  targetedSucceeded: boolean;
  // True once every gate EXCEPT the canary roll itself has passed --
  // distinguishes "this request structurally qualifies for Targeted" from
  // "the canary roll happened to select it" (canarySelected). A request
  // can be eligible and still miss the roll (canary_miss); every other
  // exclusion (wrong intent, follow-up, multi-target, no session key, out
  // of scope, flag disabled) is NOT eligible at all -- there's no roll to
  // make for those, they're structural exclusions, not unlucky ones.
  targetedEligible: boolean;
  // True only when the deterministic hash roll actually selected this
  // request's canary key -- always false when targetedEligible is false
  // (no roll happens if the request isn't structurally eligible first).
  canarySelected: boolean;
  // Wall-clock time spent inside the Targeted attempt itself (candidate
  // resolution + fact fetch + scoped identity fetch + hydration +
  // scoring), 0 when never attempted. Lets a production dashboard compare
  // Targeted vs. Legacy response time on the same basis as legacyQueryMs.
  targetedQueryMs: number;
};

function notAttempted(fallbackReason: string, eligible = false): TargetedPrimaryResult {
  return {
    selectedPath: "legacy_default", fallbackReason, cards: null,
    targetedAttempted: false, targetedSucceeded: false,
    targetedEligible: eligible, canarySelected: false, targetedQueryMs: 0,
  };
}

function fellBack(fallbackReason: string, targetedQueryMs: number): TargetedPrimaryResult {
  return {
    selectedPath: "legacy_fallback", fallbackReason, cards: null,
    targetedAttempted: true, targetedSucceeded: false,
    targetedEligible: true, canarySelected: true, targetedQueryMs,
  };
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
  // null means the caller has no stable key to sample on (no client-sent
  // sessionId) -- treated as a hard exclusion from canary, not a fallback
  // to per-request randomness. A per-request key (e.g. this request's own
  // freshly-generated id) would make an anonymous client's canary
  // assignment change on every single message, which is exactly the
  // "bounces between Targeted and Legacy" inconsistency stable sampling
  // exists to prevent -- there is no such thing as a "stable" per-request
  // key, so the caller must pass null rather than substitute one.
  canaryKey: string | null;
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
  deps?: TargetedPrimaryDeps;
}): Promise<TargetedPrimaryResult> {
  if (!args.enabled) return notAttempted("flag_disabled");
  if (!TARGETED_PRIMARY_ALLOWED_INTENTS.has(args.intent)) return notAttempted("intent_not_eligible");
  if (args.hasFollowupContext) return notAttempted("followup_not_eligible");
  if (args.catalogExactTargetIds.length !== 1) return notAttempted("not_single_target");
  if (!args.planner.validatedPlan) return notAttempted("no_validated_plan");
  if (!args.finalInScope) return notAttempted("out_of_scope");
  // No stable key to sample on (client sent no sessionId) -- excluded from
  // canary entirely rather than rolled per-request, which would make an
  // anonymous client's assignment change on every message. Not "eligible":
  // there is no roll that could ever select an anonymous request.
  if (args.canaryKey === null) return notAttempted("no_stable_canary_key");
  // Every gate above this point is a structural exclusion; everything below
  // is "eligible" in the sense that a canary roll is genuinely possible --
  // canary_miss is the one case where eligible is true but the roll itself
  // said no.
  if (!canaryRollFor(args.canaryKey, args.canaryRate)) return notAttempted("canary_miss", true);

  const targetId = args.catalogExactTargetIds[0];
  const attemptStart = Date.now();
  try {
    const grounded = groundPlannerFields({ question: args.question, validatedPlan: args.planner.validatedPlan });
    const intentField = INTENT_TO_REQUESTED_FIELD[args.intent];
    const groundedRequestedFields = [...new Set([
      ...(intentField ? [intentField] : []),
      ...(grounded.requestedFields.value.length ? grounded.requestedFields.value : args.constraints.requestedFields),
    ])];

    const resolveCandidateUniversityIdsFn = args.deps?.resolveCandidateUniversityIds ?? resolveCandidateUniversityIds;
    const queryRelevantUniversityFactsFn = args.deps?.queryRelevantUniversityFacts ?? queryRelevantUniversityFacts;

    const { ids: candidateIds, source: candidateSource } = await resolveCandidateUniversityIdsFn({
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
      return fellBack("validation_failed", Date.now() - attemptStart);
    }

    const targeted = await queryRelevantUniversityFactsFn(candidateIds, groundedRequestedFields, candidateSource);
    if (targeted.errors.length) return fellBack("targeted_error", Date.now() - attemptStart);
    // Unsupported fields (course_restrictions/source_links -- no dedicated
    // fact table) fall all the way back to legacy instead of shipping a
    // partially-composited result as if the Targeted path had produced it
    // independently -- same conservative bar as step 1.
    if (targeted.unsupportedFields.length) return fellBack("unsupported_field", Date.now() - attemptStart);

    // Scoped, single-university identity fetch (city/summary/
    // profile_sections/source_links/academic_year/program_name) -- NOT the
    // full legacy load. getUniversity() (supabase.ts) already derives all
    // of these from its own single canonical_facts fetch for this one id,
    // so no separate fetchLegacyFallbackFields call is needed here; that
    // would just be a second, duplicate scoped fetch for data this one
    // call already provides.
    const getUniversityFn = args.deps?.getUniversity ?? (await import("../supabase.ts")).getUniversity;
    const identity = await getUniversityFn(targetId);
    if (!identity) return fellBack("validation_failed", Date.now() - attemptStart);

    const candidateCatalogItems = args.catalog.filter((item) => item.universityId === targetId);
    const legacyById = new Map([[targetId, identity]]);
    const targetedUniversities = hydrateUniversitiesFromCatalog(candidateCatalogItems, targeted.factBundles, legacyById, new Map());

    // Lazy import: selection.ts also exports unknownInstitutionResponse,
    // which pulls in next/server -- fine under Next's own bundler, but it
    // breaks a plain `node --test` run of this module's eligibility-gate
    // tests (which never reach this line) if imported at module top level.
    const selectCardsFn = args.deps?.selectCards ?? (await import("./selection.ts")).selectCards;
    const targetedCards = selectCardsFn(targetedUniversities, args.constraints, args.question);

    if (!targetedCards.length) return fellBack("empty_result", Date.now() - attemptStart);

    return {
      selectedPath: "targeted_primary", fallbackReason: null, cards: targetedCards,
      targetedAttempted: true, targetedSucceeded: true,
      targetedEligible: true, canarySelected: true, targetedQueryMs: Date.now() - attemptStart,
    };
  } catch (error) {
    return fellBack(error instanceof Error ? `targeted_error:${error.message}` : "targeted_error", Date.now() - attemptStart);
  }
}
