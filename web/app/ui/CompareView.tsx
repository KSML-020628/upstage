"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import type { ExchangeProgram, University } from "../lib/types";

type Row = Record<string, unknown>;
const pending = "정보 확인 중";
const text = (input: unknown) => input === null || input === undefined || input === "" ? pending : String(input);
const unique = (items: string[]) => [...new Set(items.filter((item) => item && item !== pending))];
const programOf = (university: University): ExchangeProgram | undefined => university.exchange_programs?.[0];

function summarizeLanguages(university: University) {
  const rows = programOf(university)?.language_requirements ?? [];
  const preferred = rows.filter((row) => /IELTS|TOEFL/i.test(text(row.test_type)));
  const selected = (preferred.length ? preferred : rows).slice(0, 2);
  if (!selected.length) return pending;
  return unique(selected.map((row) => {
    const details = row.score_details as Row | undefined;
    const score = row.overall_score ?? row.level;
    return `${text(row.test_type)} ${text(score)}${details?.description ? ` (${details.description})` : ""}`;
  })).join("\n");
}

function summarizePeriods(university: University) {
  const rows = programOf(university)?.academic_periods ?? [];
  if (!rows.length) return pending;
  const semesterRows = rows.filter((row) => /semester|full academic year/i.test(`${text(row.period_type)} ${text(row.semester)}`));
  const summaries = unique((semesterRows.length ? semesterRows : rows).map((row) =>
    `${text(row.semester)}: ${text(row.start_date ?? row.start_text)} – ${text(row.end_date ?? row.end_text)}`,
  ));
  return summaries.slice(0, 3).join("\n") || pending;
}

function summarizeHousing(university: University) {
  const rows = programOf(university)?.housing_options ?? [];
  if (!rows.length) return pending;
  const minimums = rows.map((row) => Number(row.cost_min)).filter(Number.isFinite);
  const maximums = rows.map((row) => Number(row.cost_max)).filter(Number.isFinite);
  const currency = text(rows.find((row) => row.currency)?.currency);
  const periods = unique(rows.map((row) => text(row.billing_period))).slice(0, 2).join(" / ");
  if (minimums.length || maximums.length) {
    const minimum = Math.min(...(minimums.length ? minimums : maximums));
    const maximum = Math.max(...(maximums.length ? maximums : minimums));
    return `${currency} ${minimum.toLocaleString()} – ${maximum.toLocaleString()}\n${periods}`;
  }
  return unique(rows.map((row) => text(row.cost_text))).slice(0, 2).join("\n") || pending;
}

function summarizeCosts(university: University) {
  const rows = programOf(university)?.estimated_costs ?? [];
  if (!rows.length) return pending;
  return unique(rows.map((row) => row.original_text
    ? `${text(row.cost_type)}: ${text(row.original_text)}`
    : `${text(row.cost_type)}: ${text(row.currency)} ${text(row.amount_min)} – ${text(row.amount_max)} (${text(row.billing_period)})`,
  )).slice(0, 3).join("\n");
}

function summarizeDocuments(university: University) {
  const names = unique((programOf(university)?.required_documents ?? []).map((row) => text(row.document_name ?? row.document_type)));
  return names.length ? `${names.length}개 · ${names.join(", ")}` : pending;
}

export function CompareView({ universities }: { universities: University[] }) {
  const params = useSearchParams();
  const initial = (params.get("ids")?.split(",") ?? universities.slice(0, 2).map((item) => item.id)).slice(0, 3);
  const [ids, setIds] = useState<string[]>(initial);
  const slots = [0, 1, 2];
  const rows = [
    { label: "위치", get: (u: University) => `${u.city}, ${u.country}` },
    { label: "프로그램", get: (u: University) => text(programOf(u)?.program_name) },
    { label: "학년도", get: (u: University) => text(programOf(u)?.academic_year) },
    { label: "어학 기준", get: summarizeLanguages },
    { label: "학기 일정", get: summarizePeriods },
    { label: "기숙사 비용 범위", get: summarizeHousing },
    { label: "기타 예상 비용", get: summarizeCosts },
    { label: "필수 서류", get: summarizeDocuments },
  ];
  return <>
    <section className="compare-hero"><p className="eyebrow">SIDE BY SIDE</p><h1>대학 비교</h1><p>모든 대학을 같은 집계 기준으로 비교합니다. 줄바꿈된 내용은 복수 기준이 확인된 항목입니다.</p></section>
    <section className="compare-table">
      <div className="compare-row compare-head"><div className="row-label">비교 대학</div>{slots.map((slot) => <div className="compare-school" key={slot}><select value={ids[slot] ?? ""} onChange={(event) => setIds((current) => { const next = [...current]; next[slot] = event.target.value; return next; })}><option value="">대학 선택</option>{universities.map((item) => <option value={item.id} key={item.id}>{item.university_name}</option>)}</select>{ids[slot] && <><h2>{universities.find((item) => item.id === ids[slot])?.university_name}</h2><Link href={`/universities/${ids[slot]}`}>상세 보기 →</Link></>}</div>)}</div>
      {rows.map((row) => <div className="compare-row" key={row.label}><div className="row-label">{row.label}</div>{slots.map((slot) => { const university = universities.find((item) => item.id === ids[slot]); return <div className="compare-value" key={slot}>{university ? row.get(university) : "—"}</div>; })}</div>)}
    </section>
  </>;
}
