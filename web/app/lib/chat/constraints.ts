import { parseDeadlineDateConstraint } from "./chat-policy";
import type { ChatMessage, ClearableConditionField, Intent, LanguageTestName, QueryConstraints, QuotaMode } from "./types";
import { detectCountries, detectExcludedCountries, includesAny, normalizeSearchText } from "./utils";

// A follow-up like "어학 성적이 필요 없는 곳은?" after a turn that set
// languageScore=6.0 must actually drop that condition, not just fail to
// restate it -- mergeConversationConstraints's `current.X ?? base.X` falls
// back to the old value precisely when the new turn doesn't mention X again,
// which is indistinguishable from "doesn't need X anymore" unless something
// says so explicitly. This detects that explicit signal per condition group.
function detectExplicitConditionClears(question: string): ClearableConditionField[] {
  const text = question.normalize("NFKC").toLowerCase();
  const cleared: ClearableConditionField[] = [];
  if (/(?:어학|영어|언어|ielts|toefl)[^\n]{0,12}(?:상관없|무관|필요\s*없|없어도|안\s*내도|점수\s*없이)/i.test(text)) cleared.push("language");
  if (/(?:학점|평점|gpa)[^\n]{0,12}(?:상관없|무관|필요\s*없|없어도)/i.test(text)) cleared.push("gpa");
  if (/전공[^\n]{0,12}(?:상관없|무관|필요\s*없)/i.test(text)) cleared.push("major");
  if (/기숙사[^\n]{0,12}(?:상관없|무관)/i.test(text)) cleared.push("housing");
  if (/(?:예산|비용)[^\n]{0,12}(?:상관없|무관)/i.test(text)) cleared.push("budget");
  if (/(?:정원|quota)[^\n]{0,12}(?:상관없|무관)/i.test(text)) cleared.push("quota");
  return cleared;
}

export function detectIntent(question: string): Intent {
  const rawText = question.normalize("NFKC").toLowerCase();
  if (/수강\s*제한|전공\s*제한|선수\s*과목|제한됨|restricted|restriction|prerequisite|approval required|not available/i.test(rawText)) return "restriction";
  if (/비용|생활비|예산|학비|등록금|기숙사비|주거비|저렴|가장\s*싼|cost|fee|budget|tuition|living\s*cost|cheap|cheapest|least expensive/i.test(rawText)) return "cost";
  if (/기숙사|숙소|주거|housing|accommodation|dorm|residence/i.test(rawText)) return "housing";
  if (/ielts|toefl|어학|영어|언어|language|english/i.test(rawText)) return "language";
  if (/마감|지원\s*일정|지원\s*마감|노미네이션|nomination|deadline|application deadline/i.test(rawText)) return "deadline";
  if (/정원|쿼터|인원|quota|몇\s*명/i.test(rawText)) return "quota";
  if (/출처|공식|링크|근거|source/i.test(rawText)) return "source";
  const text = normalizeSearchText(question);
  if (includesAny(text, [/수강\s*제한/, /전공\s*제한/, /선수\s*과목/, /제한된/, /restricted/, /restriction/, /prerequisite/, /approval required/, /not available/])) return "restriction";
  if (includesAny(text, [/비용/, /생활비/, /예산/, /학비/, /등록금/, /기숙사비/, /저렴/, /최저/, /싼/, /싸/, /낮은/, /적게/, /cost/, /fee/, /budget/, /tuition/, /living/, /cheap/, /cheapest/, /lowest/, /least expensive/])) return "cost";
  if (includesAny(text, [/기숙/, /숙소/, /주거/, /housing/, /accommodation/, /dorm/, /residence/])) return "housing";
  if (includesAny(text, [/ielts/, /toefl/, /어학/, /영어/, /언어/, /language/, /english/])) return "language";
  if (includesAny(text, [/마감/, /지원\s*일정/, /지원\s*마감/, /노미네이션/, /nomination/, /deadline/, /application deadline/])) return "deadline";
  if (includesAny(text, [/정원/, /인원/, /quota/, /몇 명/, /몇명/])) return "quota";
  if (includesAny(text, [/출처/, /공식/, /링크/, /근거/, /source/])) return "source";
  return "general";
}

export function isExchangeQuestion(question: string) {
  const text = normalizeSearchText(question);
  if (includesAny(text, [/맛집|식당|주식|코딩|게임|영화|날씨|부동산 투자|movie|restaurant|weather|stock/])) return false;
  return includesAny(text, [
    /교환|교환학생|대학|학교|지원|마감|어학|영어|기숙|숙소|주거|비용|생활비|학비|등록금|학점|평점|정원|전공|수강|학기|출처|랭킹|비자/,
    /exchange|university|college|application|deadline|ielts|toefl|gpa|grade point|housing|accommodation|cost|tuition|quota|major|semester|visa/,
  ]);
}

export function isCostOfLivingIndexQuestion(question: string) {
  const text = normalizeSearchText(question);
  const raw = question.normalize("NFKC").toLowerCase();
  return /물가\s*지수|numbeo|cost of living index|한국.*물가|물가.*비슷|생활\s*수준.*비슷/.test(text)
    || /물가\s*지수|numbeo|cost of living index|한국.*물가|물가.*비슷|생활\s*수준.*비슷/.test(raw);
}

// This runs before any university-name resolution, so it never had a real
// target count to check -- the caller always passed 0, permanently disabling
// the "targetCount === 1" exemption this was written for. Dropped the
// parameter rather than leave a branch that can't fire.
export function isRemovedCostRecommendation(question: string) {
  const text = question.normalize("NFKC").toLowerCase();
  if (/예산|상한|budget/.test(text)) return true;
  if (/총\s*비용|전체\s*비용|종합\s*비용|total\s*cost/.test(text)) return true;
  return /비용[^\n]{0,30}(?:비교|순위|랭킹|가장|최저|저렴|싼|낮은\s*순|적게|추천)|(?:compare|rank|ranking|cheapest|lowest|recommend)[^\n]{0,30}(?:cost|fee)/i.test(text);
}

export function detectLanguageRequirement(question: string): { test: LanguageTestName; score: number; subscore?: number } | undefined {
  const text = question
    .normalize("NFKC")
    .toLowerCase()
    .replace(/아이엘츠/g, "ielts")
    .replace(/토플/g, "toefl");
  const testMatch = text.match(/(ielts|toefl(?:\s*ibt)?|duolingo|pte|cambridge|cae|cpe|ellt|oxford)[^\d]{0,20}(\d+(?:[.,]\d+)?)/i);
  const score = testMatch ? Number(testMatch[2].replace(",", ".")) : undefined;
  const subscoreMatch = text.match(/(?:각\s*(?:영역|항목)|each\s*(?:band|component|section)|no\s*(?:band|component)\s*below)[^\d]{0,20}(\d+(?:[.,]\d+)?)/i);
  const subscore = subscoreMatch ? Number(subscoreMatch[1].replace(",", ".")) : undefined;
  if (/ielts/.test(text) && score !== undefined) return { test: "IELTS Academic", score, subscore };
  if (/toefl/.test(text) && score !== undefined) return { test: "TOEFL iBT", score, subscore };
  if (/duolingo/.test(text) && score !== undefined) return { test: "Duolingo English Test", score, subscore };
  if (/pte/.test(text) && score !== undefined) return { test: "PTE Academic", score, subscore };
  if (/cambridge|cae|cpe/.test(text) && score !== undefined) return { test: "Cambridge CAE/CPE", score, subscore };
  if (/ellt|oxford/.test(text) && score !== undefined) return { test: "Oxford ELLT", score, subscore };
  return undefined;
}

export function detectBudgetKrwSemester(question: string) {
  const text = normalizeSearchText(question);
  const raw = text.match(/(\d+(?:\.\d+)?)\s*(만원|만 원|krw|원)/i);
  if (!raw || raw.index === undefined) return undefined;
  const number = Number(raw[1]);
  if (!Number.isFinite(number)) return undefined;
  const krw = /만원|만 원/.test(raw[2]) ? number * 10_000 : number;
  // Only look for "monthly" near the amount itself -- checking the whole
  // question turned "5월 마감이고 예산은 300만원이야" into a monthly budget (the
  // "월" in "5월", a date, had nothing to do with the money) and multiplied a
  // 3,000,000 KRW budget by 5.
  const vicinity = text.slice(Math.max(0, raw.index - 12), raw.index + raw[0].length + 12);
  const isMonthly = /월|한달|1달|monthly|per month/.test(vicinity);
  return isMonthly ? krw * 5 : krw;
}

export function detectGpa(question: string) {
  const text = question.normalize("NFKC").toLowerCase();
  const match = text.match(/(?:gpa|학점|평점)\s*(?:이|은|는|:)?\s*(\d+(?:[.,]\d+)?)(?:\s*\/\s*(\d+(?:[.,]\d+)?))?/i)
    ?? text.match(/(\d+(?:[.,]\d+)?)\s*\/\s*4[.,]5/);
  if (!match) return undefined;
  const gpa = Number(match[1].replace(",", "."));
  return Number.isFinite(gpa) ? gpa : undefined;
}

export function detectQuotaMode(question: string, quotaMin?: number): QuotaMode | undefined {
  const raw = question.normalize("NFKC").toLowerCase();
  if (quotaMin !== undefined) return "minimum";
  if (!/quota|정원|파견\s*인원|선발\s*인원/.test(raw)) return undefined;
  if (/미확인|없는|없고|알\s*수\s*없는/.test(raw)) return "missing";
  if (/내림차순|많은\s*순|높은\s*순|가장\s*많/.test(raw)) return "sort_desc";
  return "exists";
}

export function detectMajor(question: string) {
  const text = normalizeSearchText(question);
  if (/컴퓨터|소프트웨어|software|computer|cs|공학|engineering|it/.test(text)) return "engineering";
  if (/경영|경제|business|management|economics/.test(text)) return "business";
  if (/인문|사회|humanities|social/.test(text)) return "humanities";
  if (/자연과학|과학|science|biology|chemistry|physics/.test(text)) return "science";
  if (/예술|디자인|건축|art|design|architecture/.test(text)) return "arts";
  return undefined;
}

export function detectQuotaMin(question: string) {
  const raw = question.normalize("NFKC").toLowerCase();
  const rawMatch = raw.match(/(\d+)\s*명\s*이상/);
  if (rawMatch && /quota|정원|파견|선발|모집/.test(raw)) {
    const rawValue = Number(rawMatch[1]);
    if (Number.isFinite(rawValue)) return rawValue;
  }
  const text = normalizeSearchText(question);
  const match = text.match(/(?:quota|정원|인원)?\s*(\d+)\s*(?:명|명 이상|이상|or more|plus)/i);
  if (!match || !/quota|정원|인원|명/.test(text)) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

export const REQUEST_FIELD_TO_INTENT: Record<string, Intent> = {
  universities: "general",
  language_requirements: "language",
  housing_options: "housing",
  estimated_costs: "cost",
  application_deadlines: "deadline",
  quota_facts: "quota",
  course_restrictions: "restriction",
  source_links: "source",
};

export function requestedFieldsFromQuestion(question: string) {
  const text = question.normalize("NFKC").toLowerCase();
  const fields: string[] = [];
  if (/ielts|아이엘츠|toefl|토플|어학|영어\s*성적|언어\s*조건/.test(text)) fields.push("language_requirements");
  if (/기숙사|숙소|주거|housing|accommodation|dorm|residence/.test(text)) fields.push("housing_options");
  if (/비용|생활비|학비|등록금|기숙사비|주거비|cost|fee|tuition/.test(text)) fields.push("estimated_costs");
  if (/마감|일정|지원\s*기간|학기|nomination|deadline|application|semester/.test(text)) fields.push("application_deadlines");
  if (/정원|쿼터|quota|몇\s*명/.test(text)) fields.push("quota_facts");
  if (/수강\s*제한|전공\s*제한|선수\s*과목|course\s*restriction|prerequisite/.test(text)) fields.push("course_restrictions");
  if (/출처|공식\s*(?:자료|링크)|근거|source/.test(text)) fields.push("source_links");
  if (!fields.length) fields.push("universities");
  return [...new Set(fields)];
}

export function detectConstraints(question: string): QueryConstraints {
  const text = normalizeSearchText(question);
  const rawQuestion = question.toLowerCase();
  const intent = detectIntent(question);
  const costOfLivingIndexQuestion = isCostOfLivingIndexQuestion(question);
  // "명" is a counter for people, not institutions -- keeping it here matched
  // "파견 정원 10명 이상인 대학 추천해줘" as "10 requested results" (topN capped at
  // 8) instead of a quota threshold, which detectQuotaMin already parses
  // separately from the same "10명 이상" text.
  const topMatch = question.match(
    /(\d+)\s*(개|곳|schools?|universities?)|(\d+)\s*(cheapest|lowest|best|recommended|추천)|(?:recommend|show|pick|select|top)\s*(?:the\s*)?(\d+)/i,
  );
  const koreanTop = question.match(/(\d+)\s*(?:개|곳|군데|학교|대학)/)?.[1];
  const topValue = topMatch?.[1] ?? topMatch?.[3] ?? topMatch?.[5] ?? koreanTop;
  const language = detectLanguageRequirement(question);
  const quotaMin = detectQuotaMin(question);
  const quotaMode = detectQuotaMode(question, quotaMin);
  const koreanClearCost = /명확|숫자|공식 출처|출처가 있는|확인된|구체적인|비용 정보가 있는/.test(rawQuestion);
  const koreanOfficial = /공식|공식자료|공식 자료/.test(rawQuestion);
  const koreanHousing = /기숙사|숙소|주거/.test(rawQuestion);
  const requestedFields = requestedFieldsFromQuestion(question);
  const deadlineDateConstraint = parseDeadlineDateConstraint(rawQuestion);

  const constraints = {
    intent,
    requireAsia:
      /아시아|asia/i.test(question) &&
      !/(?:아시아|asia)[^\n]{0,18}(?:제외|빼고|빼줘|exclude|without)|(?:제외|빼고|빼줘|exclude|without)[^\n]{0,18}(?:아시아|asia)/i.test(question),
    requireAmericas: /미주|북미|남미|아메리카|americas?|north america|south america/i.test(rawQuestion),
    sortGpaLowest: /(?:학점|gpa)[^\n]{0,30}(?:가장\s*낮|낮은\s*순|최저|lowest|ascending)|(?:가장\s*낮|낮은\s*순|최저|lowest)[^\n]{0,30}(?:학점|gpa)/i.test(question),
    topN: Math.max(1, Math.min(8, topValue ? Number(topValue) : 4)),
    requireEurope: /유럽|europe|european/.test(text) || /유럽|europe|european/.test(rawQuestion),
    inScope: isExchangeQuestion(question) && !costOfLivingIndexQuestion,
    requireHousing: /기숙|숙소|주거|housing|accommodation|dorm|residence/.test(text) || /기숙|숙소|주거|housing|accommodation|dorm|residence/.test(rawQuestion),
    requireHousingGuaranteed: /기숙사?\s*(?:배정\s*)?(?:보장|확약)|housing[^\n]{0,24}guaranteed|guaranteed[^\n]{0,24}(?:housing|accommodation)/i.test(rawQuestion),
    requireAll: /모든 조건|전부|only|만 추천|만 골라|제외|exclude|명확|공식 출처|숫자 비교/.test(text) || /모든 조건|전부|only|만 추천|만 골라|제외|exclude|명확|공식 출처|숫자 비교/.test(rawQuestion),
    requireOfficialSource: /공식|official/.test(text) || /공식|official/.test(rawQuestion),
    requireClearCost: /명확|숫자 비교|비용 정보가 부족|공식 출처|출처가 있는|정확/.test(text) || /명확|숫자 비교|비용 정보가 부족|공식 출처|출처가 있는|정확/.test(rawQuestion),
    countries: detectCountries(question),
    excludedCountries: detectExcludedCountries(question),
    excludeAsia: /(?:아시아|asia)[^\n]{0,18}(?:제외|빼고|빼줘|exclude|without)/i.test(question) || /(?:제외|빼고|빼줘|exclude|without)[^\n]{0,18}(?:아시아|asia)/i.test(question),
    languageTest: language?.test,
    languageScore: language?.score,
    languageSubscore: language?.subscore,
    budgetKrwSemester: detectBudgetKrwSemester(question),
    gpa: detectGpa(question),
    major: detectMajor(question),
    quotaMin,
    quotaMode,
    requireGpaKnown: /gpa.*(?:확인|공식)|(?:확인|공식).*gpa/i.test(rawQuestion),
    requireQuotaKnown: /quota.*(?:확인|공식)|(?:확인|공식).*quota/i.test(rawQuestion),
    requireHousingMissing: /기숙사\s*(?:정보가\s*)?(?:없는|없고|미확인)|housing[^\n]{0,20}(?:missing|unknown|without)/i.test(rawQuestion),
    sortDeadlineEarliest: /빠른|가장\s*먼저|이른|earliest|soonest/.test(text) || /빠른|가장\s*먼저|이른|earliest|soonest/.test(rawQuestion),
    // When an explicit ISO-date comparator was already parsed (e.g.
    // "2026-05-01 이후"), don't also pull an academic year out of that same
    // date and use it as a second, stricter filter -- "이후" should include
    // 2027, 2028, ... deadlines too, and requiring the year to equal exactly
    // the one in the comparator date silently excludes those.
    deadlineAcademicYear: deadlineDateConstraint
      ? undefined
      : Number(rawQuestion.match(/\b(20\d{2})(?:\s*\/\s*\d{2,4})?/)?.[1]) || undefined,
    deadlineSemester: /가을|autumn|fall/.test(rawQuestion) ? "autumn" as const : /봄|spring/.test(rawQuestion) ? "spring" as const : undefined,
    deadlineType: /nomination|노미네이션|지명/.test(rawQuestion) && !/application|지원\s*마감/.test(rawQuestion)
      ? "nomination" as const
      : /application|지원\s*마감/.test(rawQuestion) && !/nomination|노미네이션|지명/.test(rawQuestion)
        ? "application" as const
        : undefined,
    deadlineSpringOnly: /봄[^\n]{0,30}(?:있|등록)[^\n]{0,30}가을[^\n]{0,20}(?:없|미확인)|spring[^\n]{0,30}(?:only|but)[^\n]{0,30}(?:no|without)[^\n]{0,10}(?:autumn|fall)/i.test(rawQuestion),
    deadlineRequireClearYear: /학년도.*(?:명확|불분명)|적용\s*학기.*(?:명확|불분명)|연도.*(?:명확|불분명)|과거\s*자료.*제외/.test(rawQuestion),
    deadlineComparator: deadlineDateConstraint?.comparator,
    deadlineDate: deadlineDateConstraint?.date,
    unsupportedReason: costOfLivingIndexQuestion ? "cost_of_living_index" as const : undefined,
    requestedFields,
    explicitClears: detectExplicitConditionClears(question),
  };

  return {
    ...constraints,
    requireGpaKnown: constraints.requireGpaKnown || constraints.sortGpaLowest,
    deadlineSemester: constraints.deadlineSpringOnly ? undefined : constraints.deadlineSemester,
    requireHousing: constraints.requireHousingMissing ? false : koreanHousing || constraints.requireHousing,
    requireOfficialSource: koreanOfficial || constraints.requireOfficialSource,
    requireClearCost: koreanClearCost || constraints.requireClearCost,
  };
}

// A real conversation shouldn't need "IELTS 6.0" repeated in every turn just
// to keep filtering by it -- carry a turn's conditions forward the way a
// human would remember them, until the client starts a new conversation
// (a fresh sessionId / an empty message history resets this naturally, since
// there's nothing to fold in).
//
// Geographic scope (requireEurope/requireAsia/requireAmericas/countries/
// excludedCountries/excludeAsia) is deliberately NOT carried forward here.
// selectCards still applies those to an exact-name match even when the
// question names one specific university (e.g. "그 대학의 IELTS는?"), and if
// an earlier unrelated turn had said "유럽 대학만", that scope would wrongly
// hide a later, explicitly-named non-European university. The existing
// contextUniversityIds + isFollowupReference mechanism already carries
// forward *which universities* a "그중" follow-up should stay inside; this
// only restores conditions like score/GPA/major/housing/deadline that
// otherwise silently reset every turn.
export function mergeConversationConstraints(base: QueryConstraints, current: QueryConstraints): QueryConstraints {
  // "그중 어학 성적이 필요 없는 곳은?" must actually drop a previously-set
  // languageScore, not just fail to restate it -- the `current.X ?? base.X`
  // fallbacks below can't tell "this turn didn't mention X" apart from "this
  // turn explicitly wants X gone" on their own, so explicitClears (detected
  // above, from the *current* turn's own text) decides per condition group
  // whether the old value is even eligible to carry forward.
  const cleared = new Set(current.explicitClears);
  return {
    ...current,
    languageTest: cleared.has("language") ? undefined : current.languageTest ?? base.languageTest,
    languageScore: cleared.has("language") ? undefined : current.languageScore ?? base.languageScore,
    languageSubscore: cleared.has("language") ? undefined : current.languageSubscore ?? base.languageSubscore,
    gpa: cleared.has("gpa") ? undefined : current.gpa ?? base.gpa,
    major: cleared.has("major") ? undefined : current.major ?? base.major,
    budgetKrwSemester: cleared.has("budget") ? undefined : current.budgetKrwSemester ?? base.budgetKrwSemester,
    quotaMin: cleared.has("quota") ? undefined : current.quotaMin ?? base.quotaMin,
    quotaMode: cleared.has("quota") ? undefined : current.quotaMode ?? base.quotaMode,
    deadlineAcademicYear: current.deadlineAcademicYear ?? base.deadlineAcademicYear,
    deadlineSemester: current.deadlineSemester ?? base.deadlineSemester,
    deadlineType: current.deadlineType ?? base.deadlineType,
    deadlineComparator: current.deadlineComparator ?? base.deadlineComparator,
    deadlineDate: current.deadlineDate ?? base.deadlineDate,
    requireHousing: cleared.has("housing") ? false : (current.requireHousing || base.requireHousing),
    requireHousingGuaranteed: cleared.has("housing") ? false : (current.requireHousingGuaranteed || base.requireHousingGuaranteed),
    requireHousingMissing: current.requireHousingMissing || base.requireHousingMissing,
  };
}

export function detectConversationConstraints(messages: ChatMessage[]): QueryConstraints {
  const userTurns = messages.filter((message) => message.role === "user").map((message) => message.content);
  return userTurns.reduce<QueryConstraints | undefined>(
    (accumulated, text) => {
      const detected = detectConstraints(text);
      return accumulated ? mergeConversationConstraints(accumulated, detected) : detected;
    },
    undefined,
  )!;
}
