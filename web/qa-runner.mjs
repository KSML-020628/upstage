#!/usr/bin/env node
// Regression QA runner for the Exchange Atlas chatbot API.
// Node 18+, no external dependencies (built-in fetch + node:fs only).
//
//   node qa-runner.mjs
//   QA_BASE_URL=https://upstage-tau.vercel.app node qa-runner.mjs
//   QA_DELAY_MS=7000 node qa-runner.mjs
//   node qa-runner.mjs --only C,E

import { writeFileSync } from "node:fs";

const BASE_URL = process.env.QA_BASE_URL || "http://localhost:3000";
const DELAY_MS = Number(process.env.QA_DELAY_MS || 1200);

const onlyArg = process.argv.find((arg) => arg.startsWith("--only"));
const ONLY_GROUPS = onlyArg
  ? (onlyArg.includes("=") ? onlyArg.split("=")[1] : process.argv[process.argv.indexOf(onlyArg) + 1])
      ?.split(",")
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean)
  : null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Scenario definitions ──────────────────────────────────────────────────

const GROUPS = [
  {
    name: "A",
    label: "단일 대학 정보 조회",
    turns: [
      { question: "University of Sheffield의 교환학생 어학 조건을 알려줘.", checks: { cardsRequired: true } },
      { question: "University of Helsinki의 기숙사 신청 방법과 보장 여부를 알려줘.", checks: { cardsRequired: true } },
      { question: "University of Bristol의 지원 절차를 순서대로 알려줘.", checks: { cardsRequired: true } },
      { question: "Linköping University의 2026년 가을학기 지원 마감일은 언제야?", checks: { cardsRequired: true } },
      { question: "University of Eastern Finland의 최소 GPA와 IELTS 조건을 알려줘.", checks: { cardsRequired: true } },
    ],
  },
  {
    name: "B",
    label: "추천·복합 조건·비교",
    turns: [
      { question: "IELTS 6.0으로 지원 가능한 유럽 대학 3개를 추천해줘.", checks: { cardsRequired: true, consistency: true } },
      { question: "2026년 가을학기 지원 마감일이 가장 빠른 유럽 대학 3개를 알려줘.", checks: { cardsRequired: true } },
      {
        question: "IELTS 6.5, GPA 3.0/4.5, 경영학 전공, 봄학기, 기숙사 정보가 있는 유럽 대학 3개를 추천해줘.",
        checks: { cardsRequired: true, consistency: true },
      },
      {
        question: "University of Bristol과 University of Sheffield의 IELTS와 지원 마감일을 표로 비교해줘.",
        checks: { cardsRequired: true, requestedKeywords: ["ielts", "마감"] },
      },
      {
        question: "핀란드 대학 중 기숙사 정보가 있고 IELTS 6.5로 지원 가능한 곳을 알려줘.",
        checks: { cardsRequired: true, consistency: true },
      },
    ],
  },
  {
    name: "C",
    label: "후속 질문 연결",
    turns: [
      { question: "IELTS 6.0으로 지원 가능한 유럽 대학 3개를 추천해줘.", checks: { cardsRequired: true } },
      { question: "그중 봄학기에 갈 수 있는 곳만 알려줘.", checks: { followup: true } },
      { question: "그 학교들 중 기숙사 배정이 보장되는 곳이 있어?", checks: { followup: true } },
      { question: "첫 번째 대학의 공식 출처를 보여줘.", checks: { followup: true } },
    ],
  },
  {
    name: "C2",
    label: "후속 질문 연결 (비교 시작)",
    turns: [
      {
        question: "University of Bristol과 University of Sheffield의 IELTS와 지원 마감일을 표로 비교해줘.",
        checks: { cardsRequired: true },
      },
      { question: "둘 중 어학 조건이 더 낮은 곳만 자세히 설명해줘.", checks: { followup: true } },
      { question: "거기 지원 마감일은 언제야?", checks: { followup: true } },
    ],
  },
  {
    name: "D",
    label: "한글 대학명 별칭",
    turns: [
      { question: "셰필드 대학교 아이엘츠 몇점이야?", checks: { onlyUniversity: "University of Sheffield" } },
      { question: "쉐필드대 영어성적 알려줘.", checks: { onlyUniversity: "University of Sheffield" } },
      { question: "헬싱키대 기숙사 있엉?", checks: { onlyUniversity: "University of Helsinki" } },
      { question: "브리스톨 교환학생 지원할 때 뭐 내야 해.", checks: { onlyUniversity: "University of Bristol" } },
      { question: "링셰핑대 봄학기 마감 언제임?", checks: { onlyUniversity: "Linkoping University" } },
    ],
  },
  {
    name: "E",
    label: "데이터 없음·모호한 질문",
    turns: [
      {
        question: "Harvard University의 교환학생 어학 조건을 알려줘.",
        checks: { noCards: true, noCardsCode: "P0-3", mustContain: ["찾"] },
      },
      {
        question: "마감일 알려줘.",
        checks: { noCards: true, noCardsCode: "P0-4", ambiguous: true },
      },
      { question: "기숙사 있는 대학 추천해줘.", checks: { displayOnly: true } },
      {
        question: "IELTS 4.0으로 지원 가능한 유럽 대학을 추천해줘.",
        checks: { noConfirmedMatch: true },
      },
      {
        question: "2028년 가을학기 마감일을 알려줘.",
        checks: { noConfirmedMatch: true },
      },
    ],
  },
  {
    name: "F",
    label: "범위 밖·출처·물가",
    turns: [
      { question: "오늘 서울 날씨 알려줘.", checks: { noCards: true, noCardsCode: "oos" } },
      { question: "내 합격 확률을 정확히 계산해줘.", checks: { noCards: true, noCardsCode: "oos" } },
      { question: "공식 자료에 없는 기숙사 월세를 예상해서 알려줘.", checks: { noConfirmedMatch: true } },
      {
        question: "University of Bristol 정보의 공식 출처 링크를 보여줘.",
        checks: { sourcesRequired: true, shortAnswerMustContainUrl: true },
      },
      { question: "영국과 핀란드 중 한국 대비 생활 물가가 더 낮은 나라는 어디야?", checks: { displayOnly: true } },
    ],
  },
];

// ── Display-layer (universal) checks ───────────────────────────────────────

const RAW_LEAK_PATTERNS = [
  /\bper_(semester|month|year|week|day)\b/i,
  /\b[a-z][a-z0-9_]*_facts\b/i,
  /\b(housing_guaranteed|is_guaranteed|cost_min|cost_max|amount_min|amount_max|billing_period|field_key|review_status)\b/i,
  /\bundefined\b|\bNaN\b|\[object Object\]/,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
];

const BILINGUAL_PAIRS = [
  [/\b(autumn|fall)\b/i, /가을/],
  [/\bspring\b/i, /봄/],
  [/\bnomination\b/i, /(지명|노미네이션)/],
  [/\bapplication\b/i, /(지원|신청)/],
  [/\bdeadline\b/i, /마감/],
  [/\b(housing|dormitory)\b/i, /기숙사/],
  [/\baccommodation\b/i, /(숙소|주거)/],
  [/\bsemester\b/i, /학기/],
  [/\btuition\b/i, /(등록금|학비)/],
  [/living expenses?/i, /생활비/],
  [/\bguaranteed\b/i, /보장/],
  [/\brequired\b/i, /필수/],
];

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function collectCells(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .flatMap((line) => line.split("|"))
    .map((cell) => cell.trim())
    .filter(Boolean);
}

function checkUnfoldedRange(text, issues) {
  const matches = String(text ?? "").matchAll(/([\d][\d,]*)\s*~\s*([\d][\d,]*)/g);
  for (const match of matches) {
    const left = match[1].replace(/,/g, "");
    const right = match[2].replace(/,/g, "");
    if (left === right) {
      issues.push({ code: "unfolded_range", detail: match[0] });
    }
  }
}

function checkRawLeak(text, issues) {
  const value = String(text ?? "");
  for (const pattern of RAW_LEAK_PATTERNS) {
    const match = value.match(pattern);
    if (match) issues.push({ code: "raw_leak", detail: match[0] });
  }
}

// Real bilingual duplication reads as a label/value pair sitting right next to
// each other (e.g. "가을학기 Autumn", "Nomination 지명") -- not merely an English
// cognate and its Korean word appearing anywhere in the same sentence. A normal
// Korean sentence about deadlines will naturally use "지원"/"신청" while also
// mentioning an English system name that happens to start with "application",
// so co-occurrence anywhere in a cell is not evidence of duplication by itself.
// Only flag when the two matches sit within a short distance of each other.
const ADJACENCY_WINDOW = 12;

function checkBilingualDup(text, issues) {
  for (const cell of collectCells(text)) {
    for (const [en, ko] of BILINGUAL_PAIRS) {
      const enMatch = cell.match(en);
      const koMatch = cell.match(ko);
      if (!enMatch || !koMatch) continue;
      const gap = Math.abs((enMatch.index ?? 0) - (koMatch.index ?? 0));
      if (gap <= ADJACENCY_WINDOW) {
        issues.push({ code: "bilingual_dup", detail: cell });
        break;
      }
    }
  }
}

function checkRepeatedSentence(text, issues) {
  const sentences = String(text ?? "")
    .split(/(?<=[.?!다])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 15);
  const seen = new Set();
  const duplicates = new Set();
  for (const sentence of sentences) {
    if (seen.has(sentence)) duplicates.add(sentence);
    seen.add(sentence);
  }
  for (const sentence of duplicates) {
    issues.push({ code: "repeated_sentence", detail: sentence.slice(0, 160) });
  }
}

// A Korean summary that names the university in English ("University of X")
// or cites an English test name (TOEFL/IELTS) is normal and not a duplication
// bug. The actual failure mode this guards against is a whole English sentence
// or clause re-appended verbatim (a real "same content, two languages" case),
// which shows up as one long unbroken run of Latin-script words rather than a
// short proper noun or acronym. Require a substantial contiguous Latin run
// before treating the summary as bilingual-duplicated.
const LATIN_RUN_MIN_LENGTH = 60;

function checkSummaryBilingual(summary, issues) {
  const text = String(summary ?? "");
  if (text.length < 40) return;
  const korean = (text.match(/[가-힣]/g) ?? []).length / text.length;
  if (korean <= 0.2) return;
  const latinRuns = text.match(/[A-Za-z][A-Za-z0-9\s,.'()-]*[A-Za-z]/g) ?? [];
  if (latinRuns.some((run) => run.trim().length >= LATIN_RUN_MIN_LENGTH)) {
    issues.push({ code: "summary_bilingual", detail: text.slice(0, 160) });
  }
}

function dedupeIssues(issues) {
  const seen = new Set();
  const out = [];
  for (const issue of issues) {
    const key = `${issue.code}::${issue.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
  }
  return out;
}

function runDisplayChecks(result) {
  const issues = [];
  const cards = result.cards ?? [];
  const strings = [
    result.shortAnswer,
    result.detailedAnswer,
    ...cards.flatMap((card) => [
      card.summary,
      ...(card.highlights ?? []),
      ...(card.condition_checks ?? []).flatMap((check) => [check.label, check.detail]),
    ]),
    ...(result.sources ?? []).map((source) => source.title),
  ].filter((value) => typeof value === "string" && value.length);

  for (const value of strings) {
    checkRawLeak(value, issues);
    checkUnfoldedRange(value, issues);
    checkBilingualDup(value, issues);
    checkRepeatedSentence(value, issues);
  }
  for (const card of cards) checkSummaryBilingual(card.summary, issues);

  return dedupeIssues(issues);
}

// ── Scenario-specific checks ───────────────────────────────────────────────

function checkConsistency(result, issues) {
  const shortAnswer = result.shortAnswer ?? "";
  const partial = result.partially_matched ?? [];
  const matched = result.matched ?? [];
  for (const card of partial) {
    if (card.university_name && shortAnswer.includes(card.university_name)) {
      issues.push({ code: "P0-1", detail: `partially_matched 대학명이 shortAnswer에 노출: ${card.university_name}` });
    }
  }
  for (const match of shortAnswer.matchAll(/(\d+)\s*개/g)) {
    const count = Number(match[1]);
    if (count !== matched.length) {
      issues.push({ code: "P0-1", detail: `shortAnswer 개수(${count}개)와 matched.length(${matched.length}) 불일치` });
    }
  }
}

function checkFollowup(result, previousIds, issues) {
  if (!previousIds || !previousIds.size) return;
  const cards = result.cards ?? [];
  if (!cards.length) return;
  const strays = cards.filter((card) => !previousIds.has(card.university_id)).map((card) => card.university_name);
  if (strays.length) {
    issues.push({ code: "P0-2", detail: `직전 결과에 없던 대학 포함: ${strays.join(", ")}` });
  }
}

function checkNoCards(result, code, issues) {
  const cards = result.cards ?? [];
  if (cards.length) {
    issues.push({ code, detail: `카드가 없어야 하는데 ${cards.length}개 표시: ${cards.map((card) => card.university_name).join(", ")}` });
  }
}

function checkMustContain(result, needles, issues) {
  const text = `${result.shortAnswer ?? ""} ${result.detailedAnswer ?? ""}`;
  for (const needle of needles) {
    if (!text.includes(needle)) issues.push({ code: "P0-3", detail: `필수 표현 누락: "${needle}"` });
  }
}

function checkAmbiguous(result, issues) {
  const text = `${result.shortAnswer ?? ""} ${result.detailedAnswer ?? ""}`;
  if (!/[?]|어느|어떤|선택|예:/.test(text)) {
    issues.push({ code: "P0-4", detail: "되묻는 표현이 없음(? / 어느 / 어떤 / 선택 / 예: 중 하나도 없음)" });
  }
}

function checkNoConfirmedMatch(result, issues) {
  const matched = result.matched ?? [];
  if (matched.length) {
    issues.push({ code: "confirmed_match", detail: `조건 충족으로 확정된 대학이 있음: ${matched.map((card) => card.university_name).join(", ")}` });
  }
}

function checkRequestedKeywords(result, keywords, issues) {
  const text = `${result.shortAnswer ?? ""} ${result.detailedAnswer ?? ""}`.toLowerCase();
  for (const keyword of keywords) {
    if (!text.includes(keyword.toLowerCase())) {
      issues.push({ code: "P1-2", detail: `요청 항목 누락: "${keyword}"` });
    }
  }
}

function checkOnlyUniversity(result, expectedName, aliasNames, issues) {
  const cards = result.cards ?? [];
  const accepted = new Set([expectedName, ...(aliasNames ?? [])]);
  if (!cards.length) {
    issues.push({ code: "P1-1", detail: `${expectedName} 카드가 전혀 없음` });
    return;
  }
  const hasExpected = cards.some((card) => accepted.has(card.university_name));
  if (!hasExpected) {
    issues.push({ code: "P1-1", detail: `기대한 대학(${expectedName})이 결과에 없음: ${cards.map((card) => card.university_name).join(", ")}` });
  }
  const strays = cards.filter((card) => !accepted.has(card.university_name)).map((card) => card.university_name);
  if (strays.length) {
    issues.push({ code: "P1-1", detail: `기대하지 않은 대학 혼입: ${strays.join(", ")}` });
  }
}

function checkSourcesRequired(result, issues) {
  const sources = result.sources ?? [];
  if (!sources.length) issues.push({ code: "P1-3", detail: "sources 배열이 비어 있음" });
}

function checkShortAnswerUrl(result, issues) {
  if (!/https?:\/\//.test(result.shortAnswer ?? "")) {
    issues.push({ code: "P1-3", detail: "shortAnswer에 http(s) URL이 없음" });
  }
}

// ── Networking ──────────────────────────────────────────────────────────

async function postChat(messages, contextUniversityIds) {
  const response = await fetch(`${BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: messages.slice(-8), contextUniversityIds }),
  });
  let body = {};
  try {
    body = await response.json();
  } catch {
    body = { error: "응답을 JSON으로 파싱하지 못했습니다." };
  }
  return { status: response.status, body };
}

async function postChatWithRetry(messages, contextUniversityIds) {
  const first = await postChat(messages, contextUniversityIds);
  if (first.status !== 429) return first;
  await sleep(Math.max(DELAY_MS * 5, 5000));
  return postChat(messages, contextUniversityIds);
}

// ── Runner ──────────────────────────────────────────────────────────────

async function runGroup(group) {
  const messages = [];
  let previousIds = null;
  const turnRecords = [];

  for (const turn of group.turns) {
    if (turnRecords.length > 0 || messages.length > 0) await sleep(DELAY_MS);

    messages.push({ role: "user", content: turn.question });
    const contextUniversityIds = previousIds ? [...previousIds].slice(0, 8) : [];
    const { status, body } = await postChatWithRetry(messages, contextUniversityIds);

    const result = {
      shortAnswer: body.shortAnswer ?? body.answer ?? "",
      detailedAnswer: body.detailedAnswer ?? body.answer ?? "",
      cards: body.cards ?? [],
      matched: body.matched ?? [],
      partially_matched: body.partially_matched ?? [],
      sources: body.sources ?? [],
      searchMode: body.searchMode,
      solarUsed: body.solarUsed,
    };
    messages.push({ role: "assistant", content: result.shortAnswer });

    const issues = [];
    if (status >= 400) issues.push({ code: "http_error", detail: `HTTP ${status}: ${body.error ?? "unknown error"}` });

    const checks = turn.checks ?? {};
    if (!checks.displayOnly) {
      if (checks.cardsRequired && !result.cards.length) issues.push({ code: "cards_required", detail: "카드가 최소 1개 있어야 함" });
      if (checks.consistency) checkConsistency(result, issues);
      if (checks.followup) checkFollowup(result, previousIds, issues);
      if (checks.noCards) checkNoCards(result, checks.noCardsCode ?? "no_cards", issues);
      if (checks.mustContain) checkMustContain(result, checks.mustContain, issues);
      if (checks.ambiguous) checkAmbiguous(result, issues);
      if (checks.noConfirmedMatch) checkNoConfirmedMatch(result, issues);
      if (checks.requestedKeywords) checkRequestedKeywords(result, checks.requestedKeywords, issues);
      if (checks.onlyUniversity) checkOnlyUniversity(result, checks.onlyUniversity, checks.onlyUniversityAliases, issues);
      if (checks.sourcesRequired) checkSourcesRequired(result, issues);
      if (checks.shortAnswerMustContainUrl) checkShortAnswerUrl(result, issues);
    }
    issues.push(...runDisplayChecks(result));

    const dedupedIssues = dedupeIssues(issues);
    turnRecords.push({
      group: group.name,
      question: turn.question,
      status,
      pass: dedupedIssues.length === 0,
      issues: dedupedIssues,
      shortAnswer: result.shortAnswer,
      detailedAnswer: result.detailedAnswer,
      cards: result.cards.map((card) => ({ university_id: card.university_id, university_name: card.university_name, match_status: card.match_status })),
      matchedCount: result.matched.length,
      partialCount: result.partially_matched.length,
      sources: result.sources.map((source) => ({ title: source.title, url: source.url })),
      searchMode: result.searchMode,
      solarUsed: result.solarUsed,
    });

    if (result.cards.length) previousIds = new Set(result.cards.map((card) => card.university_id));
  }

  return turnRecords;
}

function printConsoleReport(allRecords) {
  const byGroup = new Map();
  for (const record of allRecords) {
    if (!byGroup.has(record.group)) byGroup.set(record.group, []);
    byGroup.get(record.group).push(record);
  }

  for (const [groupName, records] of byGroup) {
    console.log(`\n=== 그룹 ${groupName} ===`);
    records.forEach((record, index) => {
      const mark = record.pass ? "PASS" : "FAIL";
      console.log(`  [${mark}] ${index + 1}. ${record.question}`);
      if (!record.pass) {
        for (const issue of record.issues) {
          console.log(`      - ${issue.code}: ${issue.detail}`);
        }
      }
    });
  }

  const total = allRecords.length;
  const passed = allRecords.filter((record) => record.pass).length;
  const rate = total ? ((passed / total) * 100).toFixed(1) : "0.0";
  console.log(`\n총 ${total}턴 중 ${passed}턴 통과 (${rate}%)`);

  const codeCounts = new Map();
  for (const record of allRecords) {
    for (const issue of record.issues) {
      codeCounts.set(issue.code, (codeCounts.get(issue.code) ?? 0) + 1);
    }
  }
  if (codeCounts.size) {
    console.log("실패 코드별 집계:");
    for (const [code, count] of [...codeCounts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${code}: ${count}건`);
    }
  }
}

function writeJsonReport(allRecords) {
  writeFileSync("qa-report.json", JSON.stringify({ baseUrl: BASE_URL, generatedAt: new Date().toISOString(), records: allRecords }, null, 2));
}

function writeHtmlReport(allRecords) {
  const rows = allRecords
    .map((record, index) => {
      const rowClass = record.pass ? "pass" : "fail";
      const universities = record.cards.map((card) => escapeHtml(card.university_name)).join(", ") || "-";
      const issues = record.issues.map((issue) => `${escapeHtml(issue.code)}: ${escapeHtml(issue.detail)}`).join("<br>") || "-";
      return `<tr class="${rowClass}">
        <td>${index + 1}</td>
        <td>${escapeHtml(record.group)}</td>
        <td>${escapeHtml(record.question)}</td>
        <td>${record.pass ? "PASS" : "FAIL"}</td>
        <td>${record.matchedCount} / ${record.partialCount}</td>
        <td>${universities}</td>
        <td>${issues}</td>
        <td><details><summary>답변 보기</summary>
          <p><b>shortAnswer</b><br>${escapeHtml(record.shortAnswer)}</p>
          <p><b>detailedAnswer</b><br>${escapeHtml(record.detailedAnswer)}</p>
        </details></td>
      </tr>`;
    })
    .join("\n");

  const total = allRecords.length;
  const passed = allRecords.filter((record) => record.pass).length;
  const rate = total ? ((passed / total) * 100).toFixed(1) : "0.0";

  const html = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>QA Report</title>
<style>
body{font-family:system-ui,sans-serif;margin:24px;color:#10243f;background:#f7f9fc}
h1{font-size:20px}
table{border-collapse:collapse;width:100%;background:#fff}
th,td{border:1px solid #d8e0ea;padding:8px 10px;font-size:13px;vertical-align:top;text-align:left}
th{background:#eef2f8}
tr.fail{background:#fdecec}
tr.pass{background:#eafaf0}
summary{cursor:pointer;color:#1b55d5}
</style>
</head>
<body>
<h1>QA Report — ${escapeHtml(BASE_URL)}</h1>
<p>${total}턴 중 ${passed}턴 통과 (${rate}%) · 생성 시각 ${new Date().toISOString()}</p>
<table>
<thead><tr><th>#</th><th>그룹</th><th>질문</th><th>판정</th><th>충족/확인</th><th>결과 대학</th><th>문제</th><th>답변</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</body>
</html>`;
  writeFileSync("qa-report.html", html);
}

async function main() {
  const groups = ONLY_GROUPS ? GROUPS.filter((group) => ONLY_GROUPS.includes(group.name)) : GROUPS;
  if (!groups.length) {
    console.error(`--only 로 지정한 그룹을 찾을 수 없습니다: ${ONLY_GROUPS?.join(",")}`);
    process.exit(1);
  }

  console.log(`QA 대상: ${BASE_URL} (요청 간격 ${DELAY_MS}ms)`);
  const allRecords = [];
  for (const group of groups) {
    const records = await runGroup(group);
    allRecords.push(...records);
  }

  printConsoleReport(allRecords);
  writeJsonReport(allRecords);
  writeHtmlReport(allRecords);
  console.log("\n리포트 저장: qa-report.json, qa-report.html");

  if (allRecords.some((record) => !record.pass)) process.exit(1);
}

main().catch((error) => {
  console.error("qa-runner 실행 중 오류:", error);
  process.exit(1);
});
