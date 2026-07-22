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

const numberTokens = (text: string) => (text.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
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

const groundedRegions = (question: string, value: unknown, issues: string[], prefix: string) => {
  const q = question.normalize("NFKC").toLowerCase();
  return strings(value).filter((item) => {
    const region = item.normalize("NFKC").toLowerCase();
    const grounded = region === "europe"
      ? /유럽|europe/.test(q)
      : region === "asia"
        ? /아시아|asia/.test(q)
        : /americas?|north america|south america/.test(region)
          ? /미주|북미|남미|아메리카|americas?|north america|south america/.test(q)
          : q.includes(region);
    if (!grounded) issues.push(`${prefix}_not_grounded:${item}`);
    return grounded;
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
  const rawLimit = finite(raw.limit) ?? 4;
  const limit = Math.max(1, Math.min(5, Math.trunc(rawLimit)));
  if (limit !== rawLimit) issues.push("limit_clamped");

  return {
    plan: {
      intent,
      universityNames,
      hardFilters: {
        regions: groundedRegions(question, rawHard.regions, issues, "region"),
        countries: groundedCountries(question, rawHard.countries, issues, "country"),
        excludedRegions: groundedRegions(question, rawHard.excludedRegions, issues, "excluded_region"),
        excludedCountries: groundedCountries(question, rawHard.excludedCountries, issues, "excluded_country"),
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

export async function runSolarPlanner(args: {
  apiKey: string;
  model: string;
  question: string;
  knownUniversityNames: string[];
}): Promise<PlannerRun> {
  const prompt = `Convert the Korean or English exchange-student question into the supplied JSON contract.\nRules:\n- hardFilters are mandatory; softPreferences are preferences.\n- Preserve decimals. SKKU GPA defaults to a 4.5 scale.\n- Distinguish housingAvailable (the student can apply or housing exists) from housingGuaranteed (allocation is guaranteed). Asking to apply for housing does not mean guaranteed.\n- Normalize spring/봄학기 to semesters:[\"spring\"] and autumn/fall/가을학기 to semesters:[\"autumn\"].\n- Never invent numbers, countries, universities, or URLs.\n- Do not write SQL. Return JSON only.\n- universityNames must exactly match one of KNOWN_UNIVERSITIES.\nKNOWN_UNIVERSITIES=${JSON.stringify(args.knownUniversityNames)}\nQUESTION=${JSON.stringify(args.question)}\nJSON_KEYS={intent,universityNames,hardFilters,softPreferences,requestedFields,limit,followupReference,clarificationNeeded,clarificationQuestion}`;
  try {
    const response = await fetch("https://api.upstage.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${args.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: args.model,
        temperature: 0,
        max_tokens: 900,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "You are a constrained query planner. Output valid JSON only." },
          { role: "user", content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(25_000),
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
