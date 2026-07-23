export type ChatIntent =
  | "university_lookup"
  | "university_recommendation"
  | "language_requirement"
  | "housing"
  | "cost"
  | "deadline"
  | "quota"
  | "course_restriction"
  | "source_request"
  | "followup"
  | "out_of_scope";

export type QueryPlan = {
  intent: ChatIntent;
  universityNames: string[];
  hardFilters: {
    regions?: string[];
    countries?: string[];
    excludedRegions?: string[];
    excludedCountries?: string[];
    ieltsMax?: number;
    ieltsMinimumSubscore?: number;
    toeflMax?: number;
    gpaValue?: number;
    gpaScale?: number;
    housingAvailable?: boolean;
    housingGuaranteed?: boolean;
    quotaMin?: number;
    semesters?: string[];
    academicYears?: string[];
    majors?: string[];
    officialSourceRequired?: boolean;
    numericCostRequired?: boolean;
  };
  softPreferences: {
    lowerCost?: boolean;
    englishCourses?: boolean;
    housingPreferred?: boolean;
    earlierDeadline?: boolean;
  };
  requestedFields: string[];
  limit: number;
  followupReference: {
    enabled: boolean;
    ordinal?: number;
    previousResultOnly?: boolean;
  };
  clarificationNeeded: boolean;
  clarificationQuestion?: string;
};

export type PlannerRun = {
  rawPlan: QueryPlan | null;
  validatedPlan: QueryPlan | null;
  issues: string[];
  usedSolar: boolean;
};

const INTENTS = new Set<ChatIntent>([
  "university_lookup", "university_recommendation", "language_requirement", "housing", "cost",
  "deadline", "quota", "course_restriction", "source_request", "followup", "out_of_scope",
]);

const FIELDS = new Set([
  "universities", "language_requirements", "housing_options", "estimated_costs",
  "application_deadlines", "quota_facts", "course_restrictions", "source_links",
]);

// ISO/slash dates (2026-05-01, 2026/05/01) embed digits that are NOT
// free-standing counts or scores. Without stripping them first, a question
// like "2026-05-01 이후 마감" would "ground" any Planner-guessed limit/score
// that happens to numerically equal 2026, 5, or 1 purely by coincidence
// with the date's own month/day components -- this is exactly how a
// schema-clamped, otherwise-ungrounded `limit` guess of 5 slipped past the
// limit_not_grounded check once Solar started landing on 5 consistently
// (see docs/decisions.md, "q4 20-run diagnostic" follow-up).
const stripDateLikeSequences = (text: string) => text.replace(/\d{4}[-/]\d{1,2}[-/]\d{1,2}/g, " ");
const numberTokens = (text: string) => (stripDateLikeSequences(text).match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
const hasNumber = (question: string, value: number) => numberTokens(question).some((item) => Math.abs(item - value) < 0.0001);
const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 12) : [];
const bool = (value: unknown) => typeof value === "boolean" ? value : undefined;
const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const semesters = (value: unknown) => strings(value).flatMap((item) => {
  const normalized = item.normalize("NFKC").toLowerCase();
  if (/spring|봄/.test(normalized)) return ["spring"];
  if (/autumn|fall|가을/.test(normalized)) return ["autumn"];
  return [];
}).filter((item, index, items) => items.indexOf(item) === index);

const REGION_KEYWORDS: Record<string, RegExp> = {
  europe: /유럽|europe/,
  asia: /아시아|asia/,
  americas: /미주|북미|남미|아메리카|americas?|north america|south america/,
};
const EXCLUSION_MARKER = /제외|빼고|빼줘|exclude|without/;

function hasExclusionMarkerNear(q: string, keyword: RegExp): boolean {
  const k = keyword.source;
  const m = EXCLUSION_MARKER.source;
  return new RegExp(`(?:${k})[^\\n]{0,18}(?:${m})|(?:${m})[^\\n]{0,18}(?:${k})`, "i").test(q);
}

// A region string is textually "grounded" whenever its keyword appears
// anywhere in the question -- but that alone can't tell an inclusion
// ("유럽 대학만") from an exclusion ("아시아 빼고") mentioning the SAME keyword.
// Solar occasionally drops an exclusion condition into the wrong polarity
// field (regions instead of excludedRegions); a plain substring check would
// happily accept that. For a positive `regions` claim, also reject it if an
// exclusion marker sits right next to the same keyword -- a genuine
// inclusion request has no reason to pair the region with "제외"/"빼고".
const groundedRegions = (question: string, value: unknown, issues: string[], prefix: string, polarity: "include" | "exclude") => {
  const q = question.normalize("NFKC").toLowerCase();
  return strings(value).filter((item) => {
    const region = item.normalize("NFKC").toLowerCase();
    const keyword = REGION_KEYWORDS[region];
    const grounded = keyword ? keyword.test(q) : q.includes(region);
    if (!grounded) { issues.push(`${prefix}_not_grounded:${item}`); return false; }
    if (polarity === "include" && keyword && hasExclusionMarkerNear(q, keyword)) {
      issues.push(`region_polarity_conflict:${item}`);
      return false;
    }
    return true;
  });
};

const groundedCountries = (question: string, value: unknown, issues: string[], prefix: string) => {
  const q = question.normalize("NFKC").toLowerCase();
  return strings(value).filter((item) => {
    const grounded = q.includes(item.normalize("NFKC").toLowerCase());
    if (!grounded) issues.push(`${prefix}_not_grounded:${item}`);
    return grounded;
  });
};

export function validateQueryPlan(question: string, value: unknown, knownUniversityNames: string[]): { plan: QueryPlan | null; issues: string[] } {
  const issues: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return { plan: null, issues: ["planner_output_not_object"] };
  const raw = value as Record<string, unknown>;
  const intent = INTENTS.has(raw.intent as ChatIntent) ? raw.intent as ChatIntent : "university_lookup";
  if (intent !== raw.intent) issues.push("invalid_intent");
  const rawHard = raw.hardFilters && typeof raw.hardFilters === "object" ? raw.hardFilters as Record<string, unknown> : {};
  const rawSoft = raw.softPreferences && typeof raw.softPreferences === "object" ? raw.softPreferences as Record<string, unknown> : {};
  const requestedNumbers: Array<[string, number | undefined, number, number]> = [
    ["ieltsMax", finite(rawHard.ieltsMax), 0, 9],
    ["ieltsMinimumSubscore", finite(rawHard.ieltsMinimumSubscore), 0, 9],
    ["toeflMax", finite(rawHard.toeflMax), 0, 120],
    ["gpaValue", finite(rawHard.gpaValue), 0, 5],
    ["gpaScale", finite(rawHard.gpaScale), 1, 5],
    ["quotaMin", finite(rawHard.quotaMin), 0, 10000],
  ];
  const cleanNumbers: Record<string, number> = {};
  for (const [key, candidate, min, max] of requestedNumbers) {
    if (candidate === undefined) continue;
    if (candidate < min || candidate > max || !hasNumber(question, candidate)) {
      issues.push(`${key}_not_grounded`);
      continue;
    }
    cleanNumbers[key] = candidate;
  }
  if (cleanNumbers.gpaValue !== undefined && cleanNumbers.gpaScale === undefined) cleanNumbers.gpaScale = 4.5;
  if (cleanNumbers.gpaValue !== undefined && cleanNumbers.gpaScale !== undefined && cleanNumbers.gpaValue > cleanNumbers.gpaScale) {
    delete cleanNumbers.gpaValue;
    issues.push("invalid_gpa");
  }

  const known = new Map(knownUniversityNames.map((name) => [name.toLocaleLowerCase(), name]));
  const universityNames = strings(raw.universityNames).flatMap((name) => {
    const exact = known.get(name.toLocaleLowerCase());
    if (!exact) issues.push(`unknown_university:${name}`);
    return exact ? [exact] : [];
  });
  const rawFollowup = raw.followupReference && typeof raw.followupReference === "object"
    ? raw.followupReference as Record<string, unknown>
    : {};
  // Solar's own limit guess is only trustworthy when the exact number it
  // picked is actually present in the question -- otherwise it's Solar's own
  // unrequested default, not the user's. Adopting it regardless is exactly
  // what produced q4's measured nondeterminism: the same question with no
  // stated count returned 5 cards on most calls and 1 on others, purely
  // because Solar's own ungrounded `limit` guess varied between identical
  // calls (see docs/decisions.md, "q4 20-run diagnostic").
  const rawLimit = finite(raw.limit);
  const limitGrounded = rawLimit !== undefined && hasNumber(question, rawLimit);
  if (rawLimit !== undefined && !limitGrounded) issues.push("limit_not_grounded");
  const limit = limitGrounded ? Math.max(1, Math.min(5, Math.trunc(rawLimit!))) : 4;
  if (limitGrounded && limit !== rawLimit) issues.push("limit_clamped");

  const regions = groundedRegions(question, rawHard.regions, issues, "region", "include");
  const excludedRegions = groundedRegions(question, rawHard.excludedRegions, issues, "excluded_region", "exclude");
  const countries = groundedCountries(question, rawHard.countries, issues, "country");
  const excludedCountries = groundedCountries(question, rawHard.excludedCountries, issues, "excluded_country");
  // Solar claiming the SAME region/country as both required and excluded is
  // a direct self-contradiction (as opposed to the include-vs-exclude
  // keyword-polarity mixup groundedRegions already catches above) -- surface
  // it distinctly so it's greppable instead of silently keeping both.
  for (const region of regions) if (excludedRegions.includes(region)) issues.push(`region_include_exclude_conflict:${region}`);
  for (const country of countries) if (excludedCountries.includes(country)) issues.push(`country_include_exclude_conflict:${country}`);

  return {
    plan: {
      intent,
      universityNames,
      hardFilters: {
        regions,
        countries,
        excludedRegions,
        excludedCountries,
        ...cleanNumbers,
        housingAvailable: bool(rawHard.housingAvailable),
        housingGuaranteed: bool(rawHard.housingGuaranteed),
        semesters: semesters(rawHard.semesters),
        academicYears: strings(rawHard.academicYears),
        majors: strings(rawHard.majors),
        officialSourceRequired: bool(rawHard.officialSourceRequired),
        numericCostRequired: bool(rawHard.numericCostRequired),
      },
      softPreferences: {
        lowerCost: bool(rawSoft.lowerCost),
        englishCourses: bool(rawSoft.englishCourses),
        housingPreferred: bool(rawSoft.housingPreferred),
        earlierDeadline: bool(rawSoft.earlierDeadline),
      },
      requestedFields: strings(raw.requestedFields).filter((field) => FIELDS.has(field)),
      limit,
      followupReference: {
        enabled: bool(rawFollowup.enabled) ?? false,
        ordinal: finite(rawFollowup.ordinal),
        previousResultOnly: bool(rawFollowup.previousResultOnly),
      },
      clarificationNeeded: bool(raw.clarificationNeeded) ?? false,
      clarificationQuestion: typeof raw.clarificationQuestion === "string" ? raw.clarificationQuestion.slice(0, 240) : undefined,
    },
    issues,
  };
}

function extractJson(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Planner did not return JSON");
  return JSON.parse(cleaned.slice(start, end + 1));
}

const HARD_FILTER_KEYS = [
  "regions", "countries", "excludedRegions", "excludedCountries",
  "ieltsMax", "ieltsMinimumSubscore", "toeflMax", "gpaValue", "gpaScale",
  "housingAvailable", "housingGuaranteed", "quotaMin", "semesters",
  "academicYears", "majors", "officialSourceRequired", "numericCostRequired",
] as const;

const QUERY_PLAN_JSON_SCHEMA = {
  type: "object",
  properties: {
    intent: { type: "string", enum: Array.from(INTENTS) },
    universityNames: { type: "array", items: { type: "string" } },
    hardFilters: {
      type: "object",
      properties: {
        regions: { type: "array", items: { type: "string" } },
        countries: { type: "array", items: { type: "string" } },
        excludedRegions: { type: "array", items: { type: "string" } },
        excludedCountries: { type: "array", items: { type: "string" } },
        ieltsMax: { type: ["number", "null"] },
        ieltsMinimumSubscore: { type: ["number", "null"] },
        toeflMax: { type: ["number", "null"] },
        gpaValue: { type: ["number", "null"] },
        gpaScale: { type: ["number", "null"] },
        housingAvailable: { type: ["boolean", "null"] },
        housingGuaranteed: { type: ["boolean", "null"] },
        quotaMin: { type: ["number", "null"] },
        semesters: { type: "array", items: { type: "string" } },
        academicYears: { type: "array", items: { type: "string" } },
        majors: { type: "array", items: { type: "string" } },
        officialSourceRequired: { type: ["boolean", "null"] },
        numericCostRequired: { type: ["boolean", "null"] },
      },
      required: HARD_FILTER_KEYS,
      additionalProperties: false,
    },
    softPreferences: {
      type: "object",
      properties: {
        lowerCost: { type: ["boolean", "null"] },
        englishCourses: { type: ["boolean", "null"] },
        housingPreferred: { type: ["boolean", "null"] },
        earlierDeadline: { type: ["boolean", "null"] },
      },
      required: ["lowerCost", "englishCourses", "housingPreferred", "earlierDeadline"],
      additionalProperties: false,
    },
    requestedFields: { type: "array", items: { type: "string", enum: Array.from(FIELDS) } },
    // No bounds were declared here before, so Solar's own out-of-range
    // guesses (observed live: 0 and 10) were fully schema-valid -- not
    // actually "outside the schema", just outside what validateQueryPlan's
    // clamp assumed. Declaring the real bounds directly is a second,
    // independent defense on top of the question-text grounding check in
    // validateQueryPlan (which is still the primary guard, since a
    // grounded-but-out-of-range limit like 8 should still be clamped, not
    // just rejected by the schema).
    limit: { type: "integer", minimum: 1, maximum: 5 },
    followupReference: {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
        ordinal: { type: ["integer", "null"] },
        previousResultOnly: { type: ["boolean", "null"] },
      },
      required: ["enabled", "ordinal", "previousResultOnly"],
      additionalProperties: false,
    },
    clarificationNeeded: { type: "boolean" },
    clarificationQuestion: { type: ["string", "null"] },
  },
  required: [
    "intent", "universityNames", "hardFilters", "softPreferences", "requestedFields",
    "limit", "followupReference", "clarificationNeeded", "clarificationQuestion",
  ],
  additionalProperties: false,
} as const;

export async function runSolarPlanner(args: {
  apiKey: string;
  model: string;
  question: string;
  knownUniversityNames: string[];
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
}): Promise<PlannerRun> {
  const prompt = `Convert the Korean or English exchange-student question into the supplied JSON contract.\nRules:\n- hardFilters are mandatory; softPreferences are preferences.\n- Preserve decimals. SKKU GPA defaults to a 4.5 scale.\n- Distinguish housingAvailable (the student can apply or housing exists) from housingGuaranteed (allocation is guaranteed). Asking to apply for housing does not mean guaranteed.\n- ieltsMax/toeflMax is the student's own overall/total score (what they already have, used as a ceiling against each university's required score). ieltsMinimumSubscore is the student's own per-section/band score. A bare score like \"아이엘츠 6.0\"/\"IELTS 6.0\" with no mention of a section, band, or \"각 영역\" is the overall score -- set ieltsMax only and leave ieltsMinimumSubscore null. Only set ieltsMinimumSubscore when the question explicitly names a section/band/subscore.\n- Normalize spring/봄학기 to semesters:[\"spring\"] and autumn/fall/가을학기 to semesters:[\"autumn\"].\n- Never invent numbers, countries, universities, or URLs.\n- Do not write SQL. Return JSON only.\n- universityNames must exactly match one of KNOWN_UNIVERSITIES.\nKNOWN_UNIVERSITIES=${JSON.stringify(args.knownUniversityNames)}\nQUESTION=${JSON.stringify(args.question)}\nJSON_KEYS={intent,universityNames,hardFilters,softPreferences,requestedFields,limit,followupReference,clarificationNeeded,clarificationQuestion}`;
  try {
    const response = await fetch("https://api.upstage.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${args.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: args.model,
        temperature: 0,
        max_tokens: 16_000,
        reasoning_effort: args.reasoningEffort ?? "minimal",
        response_format: {
          type: "json_schema",
          json_schema: { name: "query_plan", strict: true, schema: QUERY_PLAN_JSON_SCHEMA },
        },
        messages: [
          { role: "system", content: "You are a constrained query planner. Output valid JSON only." },
          { role: "user", content: prompt },
        ],
      }),
      // Sized to fit inside the route's Vercel maxDuration (see vercel.json)
      // together with the reasoner's own timeout, run sequentially after
      // this one, plus the Supabase fetch and app logic around both. Real
      // measured latency at the default reasoning_effort=minimal is 2-6s for
      // the whole /api/chat request; this budget is headroom for a slow
      // response, not a target -- see docs/solar_usage.md for the numbers.
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`planner_http_${response.status}`);
    const json = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const rawPlan = extractJson(json.choices?.[0]?.message?.content ?? "") as QueryPlan;
    const validated = validateQueryPlan(args.question, rawPlan, args.knownUniversityNames);
    return { rawPlan, validatedPlan: validated.plan, issues: validated.issues, usedSolar: true };
  } catch (error) {
    console.error("[chat-v2] planner fallback", error instanceof Error ? error.message : error);
    return { rawPlan: null, validatedPlan: null, issues: ["planner_failed"], usedSolar: false };
  }
}
