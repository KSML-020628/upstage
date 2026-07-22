export type FactRow = Record<string, unknown>;

export type PresentationStatus = "confirmed" | "unknown" | "conflict";
export type SourceState = "official" | "supporting" | "missing";

export type PresentedField = {
  key: string;
  label: string;
  value?: string;
  status: PresentationStatus;
  sourceState: SourceState;
  sourceUrl?: string;
  evidenceQuote?: string;
};

export type PresentableConditionCheck = {
  key: string;
  label: string;
  state: "met" | "unknown" | "failed";
  detail: string;
};

const PERIOD_LABELS: Record<string, string> = {
  per_day: "일",
  daily: "일",
  day: "일",
  per_week: "주",
  weekly: "주",
  week: "주",
  per_month: "월",
  monthly: "월",
  month: "월",
  per_semester: "학기",
  semester: "학기",
  term: "학기",
  per_year: "연",
  yearly: "연",
  annual: "연",
  annually: "연",
  year: "연",
  academic_year: "학년도",
  full_year: "연",
};

const BOOLEAN_LABELS: Record<string, { yes: string; no: string }> = {
  housing_available: { yes: "있음", no: "없음" },
  housing_guaranteed: { yes: "보장", no: "명시적으로 보장되지 않음" },
  is_guaranteed: { yes: "보장", no: "명시적으로 보장되지 않음" },
  application_required: { yes: "필요", no: "필요 없음" },
  is_required: { yes: "필수", no: "필수 아님" },
  tuition_waived: { yes: "면제", no: "면제 아님" },
};

function compactText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

export function numericValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const match = value.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function numberLabel(value: number, minimumFractionDigits = 0): string {
  return value.toLocaleString("ko-KR", { minimumFractionDigits, maximumFractionDigits: 2 });
}

function rowStatus(row: FactRow): PresentationStatus {
  const reviewStatus = compactText(row.review_status).toLowerCase();
  if (reviewStatus === "conflict") return "conflict";
  return "confirmed";
}

function sourceState(row: FactRow): SourceState {
  const url = compactText(row.source_url || row.evidence_url);
  if (!url) return "missing";
  const type = compactText(row.source_type).toLowerCase();
  if (/student|review|blog|youtube|other/.test(type)) return "supporting";
  return "official";
}

function baseField(row: FactRow, key: string, label: string): Omit<PresentedField, "value" | "status"> {
  const sourceUrl = compactText(row.source_url || row.evidence_url) || undefined;
  const evidenceQuote = compactText(row.evidence_quote).slice(0, 220) || undefined;
  return { key, label, sourceState: sourceState(row), sourceUrl, evidenceQuote };
}

export function periodLabel(value: unknown): string | undefined {
  const raw = compactText(value);
  if (!raw) return undefined;
  const key = raw.toLowerCase().replace(/[\s-]+/g, "_");
  return PERIOD_LABELS[key] ?? raw;
}

export function moneyLabel(min: unknown, max: unknown, currency: unknown): string | undefined {
  const minimum = numericValue(min);
  const maximum = numericValue(max);
  if (minimum === undefined && maximum === undefined) return undefined;
  const unit = compactText(currency).toUpperCase();
  const prefix = unit ? `${unit} ` : "";
  if (minimum === undefined) return `${prefix}${numberLabel(maximum as number)}`.trim();
  if (maximum === undefined || minimum === maximum) return `${prefix}${numberLabel(minimum)}`.trim();
  return `${prefix}${numberLabel(minimum)}~${numberLabel(maximum)}`.trim();
}

export function costKindLabel(row: FactRow): string {
  const corpus = `${compactText(row.cost_type)} ${compactText(row.housing_category)} ${compactText(row.housing_type)}`.toLowerCase();
  if (/tuition|registration|등록금|학비/.test(corpus)) return "등록금";
  if (/hous|dorm|accommod|residence|hall|lodging|기숙사/.test(corpus)) return "기숙사비";
  if (/주거|숙소/.test(corpus)) return "주거비";
  if (/meal|food|식비/.test(corpus)) return "식비";
  if (/transport|교통/.test(corpus)) return "교통비";
  if (/insurance|보험/.test(corpus)) return "보험료";
  if (/living|생활/.test(corpus)) return "생활비";
  return "비용";
}

export function presentCost(row: FactRow): PresentedField {
  const label = costKindLabel(row);
  const amount = moneyLabel(row.amount_min ?? row.cost_min, row.amount_max ?? row.cost_max, row.currency);
  const billingPeriod = periodLabel(row.billing_period);
  const referencePeriod = compactText(row.reference_period);
  const referenceSuffix = referencePeriod && referencePeriod !== billingPeriod ? ` · ${referencePeriod} 기준` : "";
  const base = baseField(row, "cost", label);
  if (!amount) return { ...base, status: rowStatus(row) === "conflict" ? "conflict" : "unknown", value: undefined };
  return { ...base, status: rowStatus(row), value: `${amount}${billingPeriod ? ` / ${billingPeriod}` : ""}${referenceSuffix}` };
}

export function presentHousingAvailability(row: FactRow): PresentedField {
  const base = baseField(row, "housing_available", "기숙사 제공");
  if (row.housing_available === true) return { ...base, status: rowStatus(row), value: "있음" };
  if (row.housing_available === false) return { ...base, status: rowStatus(row), value: "없음" };
  return { ...base, status: rowStatus(row) === "conflict" ? "conflict" : "unknown" };
}

export function presentHousingApplication(row: FactRow): PresentedField {
  const base = baseField(row, "application_required", "별도 신청");
  if (row.application_required === true) return { ...base, status: rowStatus(row), value: "필요" };
  if (row.application_required === false) return { ...base, status: rowStatus(row), value: "필요 없음" };
  return { ...base, status: rowStatus(row) === "conflict" ? "conflict" : "unknown" };
}

export function presentHousingGuarantee(row: FactRow): PresentedField {
  const base = baseField(row, "housing_guaranteed", "배정 보장");
  const value = row.housing_guaranteed ?? row.is_guaranteed;
  if (value === true) return { ...base, status: rowStatus(row), value: "보장" };
  if (value === false) return { ...base, status: rowStatus(row), value: "명시적으로 보장되지 않음" };
  return { ...base, status: rowStatus(row) === "conflict" ? "conflict" : "unknown" };
}

export function presentHousingRow(row: FactRow): PresentedField[] {
  const fields: PresentedField[] = [
    presentHousingAvailability(row),
    presentHousingApplication(row),
    presentHousingGuarantee(row),
  ];
  const type = [row.room_type, row.housing_type ?? row.housing_category, row.meal_type]
    .map(compactText)
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index)
    .join(" · ");
  if (type) fields.push({ ...baseField(row, "housing_type", "유형"), status: rowStatus(row), value: type });
  const cost = presentCost({ ...row, cost_type: row.cost_type ?? "Housing" });
  if (cost.status !== "unknown") fields.push({ ...cost, key: "housing_cost", label: "기숙사비" });
  const deadline = compactText(row.deadline);
  if (deadline) fields.push({ ...baseField(row, "housing_deadline", "신청 마감"), status: rowStatus(row), value: deadline });
  return fields;
}

function minimumSubscore(row: FactRow): number | undefined {
  const subscores = row.minimum_subscores;
  if (subscores && typeof subscores === "object" && !Array.isArray(subscores)) {
    const values = Object.values(subscores as FactRow).map(numericValue).filter((value): value is number => value !== undefined);
    if (values.length) return Math.max(...values);
  }
  return undefined;
}

export function presentLanguage(row: FactRow): PresentedField {
  const test = compactText(row.test_type) || compactText(row.language) || "어학 조건";
  const base = baseField(row, "language_requirement", test);
  const embeddedCefr = test.match(/\b([ABC][12])\b/i)?.[1]?.toUpperCase();
  const cefr = compactText(row.cefr_level || row.level) || embeddedCefr;
  const score = embeddedCefr && numericValue(row.minimum_score) === Number(embeddedCefr.slice(1))
    ? undefined
    : numericValue(row.minimum_score ?? row.overall_score);
  const language = compactText(row.language) || (/german/i.test(test) ? "독일어" : /english/i.test(test) ? "영어" : test.replace(/\blevel\b/ig, "").replace(/\b[ABC][12]\b/ig, "").trim());
  const parts: string[] = [];
  if (score !== undefined) parts.push(`최소 ${/ielts/i.test(test) ? numberLabel(score, 1) : numberLabel(score)}`);
  else if (cefr) parts.push(`CEFR ${cefr}`);
  const subscore = minimumSubscore(row);
  if (subscore !== undefined) parts.push(`각 영역 ${/ielts/i.test(test) ? numberLabel(subscore, 1) : numberLabel(subscore)} 이상`);
  if (row.is_required === true) parts.push("필수");
  else if (row.is_required === false) parts.push("필수 아님");
  else parts.push("필수 여부 확인 필요");
  if (!score && !cefr) parts.unshift("점수 확인 필요");
  return { ...base, label: language || "어학 조건", status: score !== undefined || cefr ? rowStatus(row) : "unknown", value: parts.join(" · ") };
}

export function presentDeadline(row: FactRow): PresentedField {
  const semester = compactText(row.semester);
  const type = compactText(row.deadline_type) || "마감일";
  const date = compactText(row.deadline_date || row.date || row.deadline_text);
  const label = [semester, type].filter(Boolean).join(" · ");
  const base = baseField(row, "deadline", label);
  return date
    ? { ...base, status: rowStatus(row), value: date }
    : { ...base, status: rowStatus(row) === "conflict" ? "conflict" : "unknown" };
}

export function presentQuota(row: FactRow): PresentedField {
  const base = baseField(row, "quota", "교환 정원");
  const quota = numericValue(row.quota ?? row.amount ?? row.value ?? row.value_text);
  if (quota === undefined || quota < 0 || quota > 999) return { ...base, status: rowStatus(row) === "conflict" ? "conflict" : "unknown" };
  return { ...base, status: rowStatus(row), value: `${numberLabel(quota)}명` };
}

function scoreFromDetail(detail: string, token: string): number | undefined {
  const pattern = new RegExp(`${token}\\s*(\\d+(?:\\.\\d+)?)`, "i");
  return numericValue(detail.match(pattern)?.[1]);
}

export function presentConditionCheck(check: PresentableConditionCheck): PresentedField {
  const status: PresentationStatus = check.state === "unknown" ? "unknown" : "confirmed";
  const detail = compactText(check.detail);
  let value = detail;
  if (/ielts/i.test(check.label) || check.key === "language") {
    const required = scoreFromDetail(detail, "요구");
    const input = scoreFromDetail(detail, "입력");
    if (required !== undefined) value = `IELTS ${numberLabel(required, 1)} 기준 ${check.state === "met" ? "충족" : check.state === "failed" ? "미충족" : "확인 필요"}`;
    if (input !== undefined) value += ` · 보유 ${numberLabel(input, 1)}`;
  } else if (check.key === "gpa") {
    const requiredMatch = detail.match(/요구\s*(\d+(?:\.\d+)?)/i);
    value = requiredMatch
      ? `최소 GPA ${requiredMatch[1]} 기준 ${check.state === "met" ? "충족" : check.state === "failed" ? "미충족" : "확인 필요"}`
      : check.state === "unknown" ? "최소 GPA 확인 필요" : detail;
  } else if (check.key === "housing_available") {
    value = check.state === "met" ? "있음" : check.state === "failed" ? "없음" : "확인 필요";
  } else if (check.key === "housing_guaranteed") {
    value = check.state === "met" ? "보장" : check.state === "failed" ? "명시적으로 보장되지 않음" : "확인 필요";
  } else if (check.state === "unknown" && !detail) {
    value = "확인 필요";
  }
  return { key: check.key, label: check.label, value, status, sourceState: "missing" };
}

export function presentFieldValue(fieldKey: string, value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") {
    const words = BOOLEAN_LABELS[fieldKey];
    return words ? (value ? words.yes : words.no) : value ? "예" : "아니요";
  }
  if (fieldKey === "billing_period") return periodLabel(value) ?? String(value);
  if (Array.isArray(value)) {
    const values = value.map((item) => presentFieldValue(fieldKey, item)).filter((item): item is string => Boolean(item));
    return values.length ? values.join(" · ") : null;
  }
  return String(value);
}

export function presentFactRow(sectionKey: string, row: FactRow): PresentedField[] {
  if (sectionKey === "housing_options") return presentHousingRow(row);
  if (sectionKey === "estimated_costs") return [presentCost(row)];
  if (sectionKey === "language_requirements") return [presentLanguage(row)];
  if (sectionKey === "application_deadlines") return [presentDeadline(row)];
  if (sectionKey === "quota_facts") return [presentQuota(row)];
  return [];
}

// ── "확인하기 어려운 정보" (unverified_items) 표시 필터 ──────────────────────
//
// unverified_items 는 공식 출처로 확정하지 못한 항목을 솔직하게 알리는 정직성
// 장치다. 원본 데이터는 절대 고치지 않는다 — 이 함수는 표시 직전에만 걸러낸다.
//
// 진짜 미확인 항목은 예외 없이 "서술어 없는 명사구"다: "교환학생 선발 인원(quota)",
// "정확한 GPA 기준", "비자 발급 소요 기간"처럼 무엇을 확인하지 못했는지만 가리킨다.
// 그래서 필터는 배제 목록이 아니라 허용 형태(명사구) 기준으로 짠다 — 완결된 문장,
// 단정 서술, 섹션 요약문, 그리고 추출 모델이 항목명을 자기복제한 재귀 증식 노이즈는
// 전부 "명사구가 아니거나, 명사구인데 서로 늘어나며 중복된 것"이라는 공통점으로 걸러진다.

export type UnverifiedItemsResult = {
  /** 필터를 통과해 바로 보여줄 항목 (최대 8개). */
  shown: string[];
  /** 필터는 통과했지만 8개를 넘어 접어서 "더 보기"로 처리할 항목. */
  overflow: string[];
  /** 걸러진(제외된) 항목 — 과도 삭제 여부를 검증하기 위해 항상 함께 반환한다. */
  filtered: string[];
};

const UNVERIFIED_ITEM_MAX_SHOWN = 8;

// 바로 뒤에 관형사형 어미(-한/-하는/-된/-되는)가 붙어야 서술로 본다. "제공 여부",
// "가능 과목", "운영 기간"처럼 활용 없이 명사를 바로 수식하는 복합명사는 서술이 아니다.
const ASSERTIVE_PREDICATE_PATTERN = /(제공|운영|권장|위치|가능)(?:한|하는|된|되는)/;
const ASSERTIVE_PREDICATE_ENDINGS = ["입니다", "합니다"];

// ETL이 "필드명: 공식 근거 기반 구조화 값 추가 확인 필요"처럼 검증 상태를 그대로
// unverified_items 에 템플릿으로 남기는 경우가 있다. 완결형 어미로 끝나 종결 문장
// 판정에 걸리지만, 이건 재귀 증식도 오분류된 확정 사실도 아닌 정직한 미확인 표시이므로
// 이 정확한 패턴만 예외로 통과시킨다.
const FIELD_STATUS_TEMPLATE_SUFFIX = "공식 근거 기반 구조화 값 추가 확인 필요";

function isFieldStatusTemplate(item: string): boolean {
  const colonIndex = item.indexOf(":");
  if (colonIndex < 0) return false;
  return item.slice(colonIndex + 1).trim() === FIELD_STATUS_TEMPLATE_SUFFIX;
}

// 괄호 병기(quota 처럼)는 명사구의 일부일 뿐이므로 종결 어미 판정에서는 떼어내고 본다.
function stripTrailingParenthetical(text: string): string {
  return text.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

function endsLikeCompleteSentence(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/[.!?]$/.test(trimmed)) return true;
  const core = stripTrailingParenthetical(trimmed);
  if (!core) return false;
  return /(다|요|음|함)$/.test(core);
}

function isNounPhraseShaped(item: string): boolean {
  if (isFieldStatusTemplate(item)) return true;
  if (endsLikeCompleteSentence(item)) return false;
  if (ASSERTIVE_PREDICATE_ENDINGS.some((marker) => item.includes(marker))) return false;
  if (ASSERTIVE_PREDICATE_PATTERN.test(item)) return false;
  const colonIndex = item.indexOf(":");
  if (colonIndex >= 0) {
    const afterColon = item.slice(colonIndex + 1).trim();
    if (afterColon && endsLikeCompleteSentence(afterColon)) return false;
  }
  return true;
}

function tokenize(item: string): string[] {
  return item.trim().split(/\s+/).filter(Boolean);
}

// 한 항목 안에서 같은 어절이 두 번 이상 반복되면(추출 모델의 자기복제 흔적) 제외한다.
// 단, "및"으로 이어진 서로 다른 절에서 같은 단어를 한 번씩 재사용하는 것은
// (예: "학점 인정 절차 및 학점 상한") 정상적인 명사구이므로, 반복 검사는 "및"으로
// 나눈 각 절 내부에서만 본다.
function hasRepeatedToken(item: string): boolean {
  const clauses = item.split(/\s*및\s*/);
  return clauses.some((clause) => {
    const tokens = tokenize(clause);
    const seen = new Set<string>();
    for (const token of tokens) {
      if (seen.has(token)) return true;
      seen.add(token);
    }
    return false;
  });
}

function isStrictTokenPrefix(shortTokens: string[], longTokens: string[]): boolean {
  if (shortTokens.length >= longTokens.length) return false;
  return shortTokens.every((token, index) => token === longTokens[index]);
}

// 어떤 항목이 다른 항목을 접두사로 완전히 포함하면서 길이만 늘어난 관계가
// 3개 이상 사슬로 이어지면, 그 사슬에서 가장 짧은(원본) 항목 하나만 남긴다.
function dropProliferationChains(items: string[]): { kept: string[]; dropped: string[] } {
  const tokensByItem = new Map(items.map((item) => [item, tokenize(item)] as const));
  const parent = new Map<string, string>();

  for (const item of items) {
    const itemTokens = tokensByItem.get(item)!;
    let bestParent: string | undefined;
    let bestLength = -1;
    for (const other of items) {
      if (other === item) continue;
      const otherTokens = tokensByItem.get(other)!;
      if (isStrictTokenPrefix(otherTokens, itemTokens) && otherTokens.length > bestLength) {
        bestParent = other;
        bestLength = otherTokens.length;
      }
    }
    if (bestParent !== undefined) parent.set(item, bestParent);
  }

  function chainRoot(item: string): string {
    let current = item;
    const visited = new Set<string>();
    while (parent.has(current) && !visited.has(current)) {
      visited.add(current);
      current = parent.get(current)!;
    }
    return current;
  }

  const groupsByRoot = new Map<string, string[]>();
  for (const item of items) {
    const root = chainRoot(item);
    const group = groupsByRoot.get(root) ?? [];
    group.push(item);
    groupsByRoot.set(root, group);
  }

  const kept: string[] = [];
  const dropped: string[] = [];
  for (const item of items) {
    const root = chainRoot(item);
    const group = groupsByRoot.get(root)!;
    if (group.length >= 3) {
      if (item === root) kept.push(item);
      else dropped.push(item);
    } else {
      kept.push(item);
    }
  }
  return { kept, dropped };
}

export function presentUnknowns(items: string[]): UnverifiedItemsResult {
  const deduped = [...new Set(items.map((item) => item.trim()).filter(Boolean))];

  const shapeFiltered: string[] = [];
  const shapeDropped: string[] = [];
  for (const item of deduped) {
    if (isNounPhraseShaped(item) && !hasRepeatedToken(item)) shapeFiltered.push(item);
    else shapeDropped.push(item);
  }

  const { kept, dropped: chainDropped } = dropProliferationChains(shapeFiltered);

  return {
    shown: kept.slice(0, UNVERIFIED_ITEM_MAX_SHOWN),
    overflow: kept.slice(UNVERIFIED_ITEM_MAX_SHOWN),
    filtered: [...shapeDropped, ...chainDropped],
  };
}
