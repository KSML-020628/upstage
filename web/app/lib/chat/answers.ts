import { presentConditionCheck } from "../display/present-fact";
import type { ChatSource, Intent, ResultCard } from "./types";
import { cleanText, isClearlyNonOfficialUrl, isValidHttpUrl } from "./utils";

export function deterministicClassifiedAnswer(matched: ResultCard[], partiallyMatched: ResultCard[]) {
  const lines: string[] = [];
  const cell = (value: string) => cleanText(value).replace(/\|/g, "/").replace(/\s+/g, " ").trim();
  const allCards = [...matched, ...partiallyMatched];
  const columnCandidates = [
    { key: "housing_available", label: "기숙사 제공" },
    { key: "housing_guaranteed", label: "배정 보장" },
    { key: "semester", label: "파견 학기" },
    { key: "language", label: "어학" },
    { key: "gpa", label: "GPA" },
    { key: "gpa_exists", label: "최소 GPA" },
    { key: "major", label: "전공" },
    { key: "quota", label: "Quota" },
    { key: "official_source", label: "공식 출처" },
  ];
  const columns = columnCandidates.filter((column) => allCards.some((card) => card.condition_checks?.some((check) => check.key === column.key)));
  const checkCell = (card: ResultCard, key: string) => {
    const check = card.condition_checks?.find((item) => item.key === key);
    if (!check) return "-";
    const presented = presentConditionCheck(check);
    if (check.state === "unknown") return presented.value ?? "확인 필요";
    if (check.state === "failed") return `미충족 · ${presented.value ?? "조건 미충족"}`;
    return presented.value ?? "조건 충족";
  };
  const header = ["순위", "대학", "위치", ...columns.map((column) => column.label)];
  const separator = header.map((_, index) => index === 0 ? "---:" : "---");
  if (matched.length) {
    lines.push(`### 조건 충족 대학 (${matched.length}개)`, "", `| ${header.join(" | ")} |`, `|${separator.join("|")}|`);
    matched.forEach((card, index) => {
      const values = columns.map((column) => cell(checkCell(card, column.key)));
      lines.push(`| ${index + 1} | **${cell(card.university_name)}** | ${cell(`${card.country} · ${card.city}`)} | ${values.join(" | ")} |`);
    });
  } else {
    lines.push("### 검색 결과", "", "모든 조건이 확인된 대학은 찾지 못했습니다.");
  }
  if (partiallyMatched.length) {
    const partialHeader = ["대학", ...columns.map((column) => column.label), "판정"];
    lines.push("", `### 추가 확인이 필요한 후보 (${partiallyMatched.length}개)`, "", `| ${partialHeader.join(" | ")} |`, `|${partialHeader.map(() => "---").join("|")}|`);
    partiallyMatched.forEach((card) => {
      const values = columns.map((column) => cell(checkCell(card, column.key)));
      lines.push(`| **${cell(card.university_name)}** | ${values.join(" | ")} | ${cell(card.unknown_fields?.join(", ") || "추가 확인 필요")} |`);
    });
    lines.push("", "> 위 후보는 일부 조건의 데이터가 없어 모든 조건을 충족한다고 확정할 수 없습니다.");
  }
  return lines.join("\n");
}

export function restrictionEvidence(card: ResultCard[]) {
  return card.flatMap((item) => [
    ...(item.fact_bundle ?? []).map((fact) => `${fact.value} ${fact.evidence_quote ?? ""}`),
    ...item.highlights,
  ]).filter((text) => /restricted|not available|approval required|prerequisite|limited|closed|수강 제한|전공 제한|선수 과목/i.test(text));
}

export function deterministicRestrictionAnswer(cards: ResultCard[]) {
  const lines: string[] = ["### 확인된 수강 제한", ""];
  let found = false;
  for (const card of cards) {
    const evidence = restrictionEvidence([card]);
    if (!evidence.length) continue;
    found = true;
    lines.push(`- **${card.university_name}**`, ...evidence.slice(0, 3).map((text) => `  - ${cleanText(text).slice(0, 500)}`));
  }
  if (!found) {
    return ["### 확인 결과", "", "명시적인 수강 제한 근거를 확인하지 못했습니다.", "", "- 전공명이 등장한다는 이유만으로 제한이 있다고 판단하지 않았습니다.", "- 지원 전 해당 대학의 최신 Course Catalog를 확인해 주세요."].join("\n");
  }
  lines.push("", "> 위 내용은 DB에 저장된 제한 문구만 정리했으며, 확인되지 않은 조건은 추가하지 않았습니다.");
  return lines.join("\n");
}

export function collectSources(cards: ResultCard[]): ChatSource[] {
  const seen = new Set<string>();
  const sources: ChatSource[] = [];

  for (const card of cards) {
    for (const fact of card.fact_bundle ?? []) {
      if (!fact.source_url || !isValidHttpUrl(fact.source_url)) continue;
      const key = `${card.university_id}:${fact.source_url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      seen.add(fact.source_url);
      sources.push({
        fact_id: fact.fact_id,
        title: fact.source_title || fact.label || "근거 출처",
        url: fact.source_url,
        university_name: card.university_name,
        source_type: fact.source_type || fact.table,
        is_official: !isClearlyNonOfficialUrl(fact.source_url),
        field_key: fact.field_key,
        evidence_quote: fact.evidence_quote,
      });
    }
    if (!card.source_url || !isValidHttpUrl(card.source_url) || seen.has(card.source_url)) continue;
    seen.add(card.source_url);
    seen.add(`${card.university_id}:${card.source_url}`);
    sources.push({
      title: card.source_title || "근거 출처",
      url: card.source_url,
      university_name: card.university_name,
      source_type: card.source_type || "row_source",
      is_official: !isClearlyNonOfficialUrl(card.source_url),
      field_key: card.source_field_key,
      evidence_quote: card.evidence_quote,
    });
  }

  return sources.slice(0, Math.max(3, cards.length));
}

export function searchMode(intent: Intent) {
  if (intent === "general") return "Supabase 대학 데이터 필터링 + Solar Pro 3 요약";
  if (intent === "cost") return "Supabase 구조화 비용 필드 필터링/정렬 + row 단위 출처";
  return "Supabase 구조화 필드 1차 후보 추림 + Solar Pro 3 설명";
}

export function deterministicDirectCostAnswer(cards: ResultCard[]) {
  const cell = (value: string) => cleanText(value).replace(/\|/g, "/").replace(/\s+/g, " ").trim();
  const rows = cards.flatMap((card) => {
    const facts = (card.fact_bundle ?? [])
      .filter((fact) => fact.table === "cost_facts" || fact.table === "housing_facts")
      .map((fact) => fact.value)
      .filter(Boolean)
      .slice(0, 4);
    return facts.map((fact) => `| **${cell(card.university_name)}** | ${cell(fact)} |`);
  });

  return [
    "### 확인된 비용 정보",
    "",
    ...(rows.length ? ["| 대학 | 비용과 과금 기간 |", "|---|---|", ...rows] : ["공식 비용 금액을 확인하기 어렵습니다."]),
    "",
    "### 확인사항",
    "- 금액은 원래 통화와 과금 기간을 그대로 표시했습니다.",
    "- 개인 지출을 포함한 총비용으로 합산하지 않았습니다.",
  ].join("\n");
}

export function deterministicFactAnswer(cards: ResultCard[], intent: "housing" | "language") {
  const cell = (value: string) => cleanText(value).replace(/\|/g, "/").replace(/\s+/g, " ").trim();
  const title = intent === "housing" ? "기숙사 정보" : "어학 조건";
  const rows = cards.flatMap((card) => {
    const facts = (card.fact_bundle ?? []).filter((fact) =>
      intent === "housing" ? fact.table === "housing_facts" : fact.table === "language_requirements",
    );
    const values = facts.length
      ? facts.map((fact) => fact.value)
      : card.highlights.filter((value) =>
          intent === "housing" ? /기숙|주거|housing|accommodation|residence/i.test(value) : /IELTS|TOEFL|CEFR|어학|English/i.test(value),
        );
    return values.filter(Boolean).slice(0, 5).map((value) => `| **${cell(card.university_name)}** | ${cell(value)} |`);
  });

  return [
    `### ${title}`,
    "",
    ...(rows.length ? ["| 대학 | 확인된 내용 |", "|---|---|", ...rows] : ["현재 등록된 자료에서 확인할 수 있는 정보가 없습니다."]),
    "",
    "### 확인사항",
    intent === "housing"
      ? "- 금액·보장 여부·신청 일정이 저장되지 않은 경우 임의로 추정하지 않습니다."
      : "- 시험별 최소 점수와 세부 영역 점수는 확인된 값만 표시합니다.",
    "- 최신 정보는 아래 공식 근거에서 다시 확인해 주세요.",
  ].join("\n");
}

export function sanitizeGeneratedAnswer(value: string) {
  return value
    .split(/\r?\n/)
    .filter((line) => !/(?:€|EUR|USD|GBP|KRW|원|달러|파운드)?\s*(?:XXX|TBD|미정)(?:\s*(?:€|EUR|USD|GBP|KRW|원|달러|파운드))?/i.test(line))
    .filter((line) => !/^현재 Supabase(?:의|에)\b/.test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function plainTextSummary(value: string, maxLength = 320) {
  const text = value
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*]\s+/gm, "")
    .replace(/\|/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength).trim()}...` : text;
}

function shortAnswerFor(cards: ResultCard[], detailedAnswer: string) {
  if (cards.length === 1) {
    const card = cards[0];
    const points = card.highlights.filter(Boolean).slice(0, 3).map((item) => `- ${plainTextSummary(item, 90)}`);
    return [`**${card.university_name}**의 확인된 정보를 정리했습니다.`, ...points].join("\n");
  }

  if (cards.length > 1) {
    const names = cards.slice(0, 3).map((card) => `- ${card.university_name}`);
    const suffix = cards.length > 3 ? `\n- 그 외 ${cards.length - 3}개 대학` : "";
    return [`조건과 관련된 대학 ${cards.length}개를 찾았습니다.`, ...names].join("\n") + suffix;
  }

  return plainTextSummary(detailedAnswer);
}

export function responsePresentation(detailedAnswer: string, cards: ResultCard[]) {
  return {
    answer: detailedAnswer,
    shortAnswer: shortAnswerFor(cards, detailedAnswer),
    detailedAnswer,
  };
}

export function deterministicDeadlineAnswer(cards: ResultCard[]) {
  const rows = cards.map((card, index) => {
    const deadlineFacts = (card.fact_bundle ?? [])
      .filter((fact) => fact.table === "application_deadlines" || fact.field_key === "application_deadlines")
      .map((fact) => fact.value)
      .filter(Boolean);
    const primary = deadlineFacts[0] ?? card.highlights.find((item) => /deadline|마감|application|nomination/i.test(item)) ?? "확인 필요";
    const otherDeadlines = deadlineFacts.slice(1, 3).join(" / ") || "추가 일정은 상세 페이지와 출처에서 확인";
    return `| ${index + 1} | ${card.university_name} | ${card.country} · ${card.city} | ${primary.replace(/\|/g, "/")} | ${otherDeadlines.replace(/\|/g, "/")} |`;
  });

  return [
    "### 지원 마감일 비교",
    "",
    // The cell content itself already says which deadline this is (e.g.
    // "2026년 봄학기 · 지명(성균관대 추천) 마감일: ..."), since a university can
    // have both a nomination and an application deadline and this shows
    // whichever comes first chronologically -- the header must not call it
    // "the" application deadline as if there's only one kind.
    "| 순위 | 대학 | 위치 | 가장 빠른 확인된 마감일 | 함께 확인할 일정 |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    "### 확인사항",
    "- 지명(성균관대 추천) 마감일과 지원(본인 제출) 마감일은 서로 다른 절차이며, 위 표는 둘 중 더 빠른 날짜를 보여줍니다.",
    "- 성균관대학교 내부 접수 일정과 상대교 일정은 다를 수 있습니다.",
    "- 실제 지원 전 아래 공식 출처에서 최신 일정을 확인해 주세요.",
  ].join("\n");
}

export function deterministicRequestedFieldsAnswer(cards: ResultCard[], requestedFields: string[]) {
  const labels: Record<string, string> = {
    language_requirements: "어학 조건",
    housing_options: "기숙사·주거",
    estimated_costs: "비용",
    application_deadlines: "지원 마감일",
    quota_facts: "파견 정원",
    course_restrictions: "수강 제한",
    source_links: "공식 출처",
    universities: "대학 기본 정보",
  };
  const lines = ["### 요청 항목 비교", ""];
  for (const card of cards) {
    lines.push(`#### ${card.university_name}`, "", "| 항목 | 확인된 내용 |", "|---|---|");
    for (const field of requestedFields) {
      const values = (card.fact_bundle ?? [])
        .filter((fact) => fact.field_key === field || fact.table === field)
        .map((fact) => cleanText(fact.value).replace(/\|/g, "/"))
        .filter(Boolean)
        .filter((value, index, items) => items.indexOf(value) === index)
        .slice(0, 3);
      lines.push(`| ${labels[field] ?? field} | ${values.length ? values.join(" / ") : "확인 필요"} |`);
    }
    lines.push("");
  }
  lines.push("### 확인사항", "", "- 확인 필요로 표시된 항목은 조건 충족으로 간주하지 않았습니다.", "- 숫자와 날짜는 아래 공식 근거에서 최신 값을 다시 확인해 주세요.");
  return lines.join("\n");
}

export function deterministicGeneralAnswer(cards: ResultCard[]) {
  const lines = ["### 확인된 교환대학 정보", ""];
  for (const card of cards) {
    lines.push(`#### ${card.university_name}`, "");
    lines.push(`- 위치: ${card.country} · ${card.city}`);
    for (const highlight of card.highlights.filter(Boolean).slice(0, 3)) {
      lines.push(`- ${plainTextSummary(highlight, 160)}`);
    }
    lines.push("");
  }
  lines.push("### 확인 안내", "", "- 상세 조건과 최신 일정은 연결된 공식 출처에서 다시 확인해 주세요.");
  return lines.join("\n");
}
