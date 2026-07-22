import Link from "next/link";
import { notFound } from "next/navigation";
import { getUniversity } from "../../lib/supabase";
import { Header } from "../../ui/Header";
import { UniversityCover, UniversityLogo } from "../../ui/LocalMedia";
import { ResearchItemGrid } from "../../ui/ResearchItemGrid";
import { presentFactRow, presentFieldValue } from "../../lib/display/present-fact";
import type { ProfileSection } from "../../lib/types";

type RowValue = Record<string, unknown>;

const sectionLabels: Record<string, string> = {
  application_deadlines: "지원 일정",
  language_requirements: "어학 성적",
  academic_periods: "학사 일정",
  housing_options: "기숙사",
  required_documents: "준비 서류",
};

const hiddenFields = new Set([
  "id",
  "university_id",
  "exchange_program_id",
  "created_at",
  "updated_at",
  "source_url",
  "evidence_url",
  "evidence_quote",
  "raw_json",
  "fact_hash",
]);

const universitiesWithoutAttachedMathReports = new Set([
  "VinUniversity",
  "Chulalongkorn University",
  "Feng Chia University",
  "Hanken School of Economics",
  "Kajaani University of Applied Sciences",
  "Pontifical Catholic University of Peru",
  "SKEMA Business School",
  "UNICAMP (University of Campinas)",
]);

const fieldLabels: Record<string, string> = {
  semester: "학기",
  deadline_type: "마감 유형",
  deadline_date: "마감일",
  deadline_text: "마감 안내",
  language: "언어",
  test_type: "시험",
  minimum_score: "최소 점수",
  minimum_subscores: "세부 점수",
  cefr_level: "CEFR",
  is_required: "필수 여부",
  notes: "비고",
  period_type: "일정 유형",
  start_date: "시작일",
  end_date: "종료일",
  housing_available: "기숙사 제공",
  housing_guaranteed: "배정 보장",
  housing_type: "주거 유형",
  housing_category: "주거 분류",
  room_type: "방 유형",
  meal_type: "식사 포함",
  cost_min: "최소 비용",
  cost_max: "최대 비용",
  currency: "통화",
  billing_period: "청구 기준",
  application_required: "신청 필요",
  deadline: "신청 마감",
  cost_type: "비용 유형",
  amount_min: "최소 금액",
  amount_max: "최대 금액",
  reference_period: "기준 연도",
  normalized_krw_min: "원화 최소",
  normalized_krw_max: "원화 최대",
  document_type: "서류 유형",
  document_name: "서류명",
  preparation_stage: "준비 시점",
};

const detailCardCss = `
.detail-content{min-width:0}
.research-intro{display:flex;align-items:baseline;gap:14px;margin-bottom:26px}
.research-intro span{color:#1b55d5;font:italic 15px Georgia,serif}
.research-intro h2{margin:0;color:#10243f;font-size:32px;letter-spacing:-.03em}
.research-intro em{margin-left:auto;color:#667386;font-size:12px;font-style:normal}
.rich-section-card-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
.research-card{min-height:228px;display:grid;grid-template-rows:1fr auto;overflow:hidden;border:1px solid #d8e0ea;border-radius:8px;background:#fff;box-shadow:0 12px 30px rgba(16,36,63,.045);transition:transform .18s ease,box-shadow .18s ease,border-color .18s ease}
.research-card:hover{transform:translateY(-2px);border-color:#b8c9df;box-shadow:0 18px 38px rgba(16,36,63,.08)}
.research-card-body{padding:22px 24px 18px}
.research-card-number{display:block;margin-bottom:10px;color:#1b55d5;font:italic 14px Georgia,serif}
.research-card h3{margin:0 0 14px;color:#10243f;font-size:20px;line-height:1.35;letter-spacing:-.02em}
.research-card ul{margin:0;padding-left:18px;color:#263951;font-size:14px;line-height:1.8}
.research-card li+li{margin-top:3px}
.research-card-footer{min-height:48px;display:flex;align-items:center;gap:12px;padding:12px 24px;border-top:1px solid #e3e8ef;background:#fbfcfe;color:#536479;font-size:12px}
.source-chip{font-weight:800;color:#10243f}
.source-label{color:#667386}
.research-card-footer a{margin-left:auto;color:#10243f;font-weight:800;text-decoration:none}
.research-card-footer a:hover{color:#1b55d5}
.research-empty{margin-left:auto;color:#7d8998}
.detail-nav a.active-like{color:#10243f;font-weight:800}
.clean-data-list{display:grid;gap:12px}
.clean-data-row{background:white;border:1px solid var(--line);padding:18px 22px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
.clean-data-row p{margin:0;display:flex;flex-direction:column;gap:6px}
.clean-data-row small{color:var(--muted);text-transform:uppercase;letter-spacing:.08em;font-size:9px}
.clean-data-row span{line-height:1.55;font-size:13px;color:#263951}
.clean-source-link{grid-column:1/-1;color:#1b55d5!important;font-size:12px!important;font-weight:800}
.compact-fact-panel{padding:20px 22px;border:1px solid #d8e0ea;background:#fff}
.deadline-table{width:100%;border-collapse:collapse;color:#263951;font-size:13px}
.deadline-table th{padding:10px 12px;background:#f4f7fb;color:#65758a;font-size:10px;text-align:left}
.deadline-table td{padding:14px 12px;border-top:1px solid #e7ecf2;vertical-align:top}
.deadline-table td:first-child{font-weight:800;color:#10243f}
.housing-overview{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-bottom:16px}
.housing-overview div{padding:14px 16px;border:1px solid #e1e8f1;border-radius:7px;background:#f8fafc}
.housing-overview small{display:block;margin-bottom:5px;color:#65758a;font-size:10px}
.housing-overview strong{color:#10243f;font-size:14px}
.housing-option-list{display:flex;flex-wrap:wrap;gap:8px}
.housing-option-list span{padding:8px 11px;border:1px solid #dce5f0;border-radius:6px;background:#fff;color:#314158;font-size:12px}
.section-source-links{display:flex;flex-wrap:wrap;gap:14px;margin-top:16px;padding-top:14px;border-top:1px solid #e7ecf2}
.section-source-links a{color:#1b55d5;font-size:11px;font-weight:800;text-decoration:none}
.unknown-list h3:before{content:"검토 메모"}
.research-item-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
.research-item-card{min-width:0;min-height:240px;padding:20px;display:flex;flex-direction:column;background:#fff;border:1px solid #d8e0ea;border-radius:8px;box-shadow:0 10px 26px rgba(16,36,63,.05);transition:transform 180ms ease,border-color 180ms ease,box-shadow 180ms ease}
.research-item-card:hover{transform:translateY(-2px);border-color:#aebfd8;box-shadow:0 14px 32px rgba(16,36,63,.08)}
.research-item-card.is-missing{min-height:158px;background:#f7f9fc;border-style:dashed;box-shadow:none}
.research-item-header{display:grid;grid-template-columns:auto 42px minmax(0,1fr);align-items:center;gap:10px;padding-bottom:14px;border-bottom:1px solid #e8edf3}
.research-item-number{color:#1b55d5;font:italic 13px Georgia,serif;letter-spacing:0}
.research-item-icon{display:grid;place-items:center;width:42px;height:34px;color:#174cba;background:#edf4ff;border:1px solid #d9e6fb;border-radius:7px;font-size:10px;font-weight:800;letter-spacing:0}
.research-item-header h3{min-width:0;margin:0;color:#10243f;font-size:17px;line-height:1.4;letter-spacing:0}
.research-item-bullets{margin:17px 0 20px;padding-left:18px;display:grid;gap:8px;color:#314158;font-size:13px;line-height:1.65}
.research-item-bullets li::marker{color:#1b55d5}
.research-item-summary{margin:17px 0 14px;padding:14px 16px;border-left:3px solid #1b55d5;background:#f4f7fb;color:#263951;font-size:13px;line-height:1.7}
.research-review-groups{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:0 0 18px}
.research-review-groups section,.research-structured-items section{min-width:0;padding:14px;border:1px solid #e1e8f1;border-radius:7px;background:#fbfcfe}
.research-review-groups h4,.research-structured-items h4{margin:0 0 9px;color:#174cba;font-size:12px;letter-spacing:0}
.research-review-groups ul{margin:0;padding-left:16px;display:grid;gap:6px;color:#35465c;font-size:12px;line-height:1.55}
.research-structured-items{display:grid;gap:10px;margin:17px 0 18px}
.research-structured-items dl{margin:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 14px}
.research-structured-items dl div{min-width:0}
.research-structured-items dt{margin-bottom:3px;color:#6b788a;font-size:9px;font-weight:800}
.research-structured-items dd{margin:0;color:#263951;font-size:12px;line-height:1.5;overflow-wrap:anywhere}
.research-item-card.is-missing .research-item-bullets{color:#7f8c9d}
.research-item-card.is-missing .research-item-bullets li::marker{color:#aeb8c4}
.research-item-footer{margin-top:auto;padding-top:13px;display:flex;align-items:center;justify-content:space-between;gap:12px;border-top:1px solid #eef1f5}
.research-status{display:inline-flex;align-items:center;min-height:26px;padding:5px 9px;color:#174cba;background:#eaf2ff;border-radius:7px;font-size:10px;font-weight:800}
.research-status.missing{color:#6f7c8c;background:#e9edf2}
.research-item-links{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px}
.research-item-links a{color:#1b55d5;font-size:11px;font-weight:800;text-decoration:none}
.research-item-links a:hover{text-decoration:underline;text-underline-offset:3px}
@media(max-width:980px){.rich-section-card-grid,.research-item-grid{grid-template-columns:1fr}.clean-data-row{grid-template-columns:1fr}.research-intro{display:block}.research-intro em{display:block;margin-top:8px}.research-item-card{min-height:0}.research-review-groups{grid-template-columns:1fr}}
@media(max-width:520px){.research-item-card{padding:17px}.research-item-footer{align-items:flex-start;flex-direction:column}.research-item-links{justify-content:flex-start}}
@media(prefers-reduced-motion:reduce){.research-item-card{transition:none}}
`;

function formatFieldName(field: string) {
  return fieldLabels[field] ?? field.replaceAll("_", " ");
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "확인 필요";
  if (typeof value === "boolean") return value ? "예" : "아니요";
  if (Array.isArray(value)) {
    const values = value.map(formatValue).filter((item) => item && item !== "확인 필요");
    return values.length ? values.join(" · ") : "확인 필요";
  }
  if (typeof value === "object") {
    const values = Object.entries(value as RowValue)
      .filter(([, nestedValue]) => nestedValue !== null && nestedValue !== undefined && nestedValue !== "")
      .map(([key, nestedValue]) => `${formatFieldName(key)} ${formatValue(nestedValue)}`);
    return values.length ? values.join(" · ") : "확인 필요";
  }
  return String(value);
}

function rowEntries(row: RowValue) {
  return Object.entries(row)
    .filter(([field, value]) => !hiddenFields.has(field) && value !== null && value !== undefined && value !== "")
    .slice(0, 6);
}

function displayEntries(sectionKey: string, row: RowValue) {
  const presented = presentFactRow(sectionKey, row)
    .filter((field) => field.value)
    .map((field) => [field.label, field.value as string] as const);
  if (presented.length) return presented;
  return rowEntries(row)
    .map(([field, value]) => [formatFieldName(field), presentFieldValue(field, value)] as const)
    .filter((entry): entry is readonly [string, string] => entry[1] !== null);
}

function sourceUrlFromRows(rows: RowValue[]): string | undefined {
  for (const row of rows) {
    const url = row.source_url ?? row.evidence_url;
    if (typeof url === "string" && /^https?:\/\//i.test(url)) return url;
  }
  return undefined;
}

function uniqueSourceUrls(rows: RowValue[]): string[] {
  return [...new Set(rows.map((row) => row.source_url).filter((url): url is string => typeof url === "string" && /^https?:\/\//i.test(url)))];
}

function semesterLabel(value: unknown): string {
  const text = String(value ?? "").toLowerCase();
  if (/fall|autumn|가을/.test(text)) return "가을학기";
  if (/spring|봄/.test(text)) return "봄학기";
  if (/full|year|전체|연간/.test(text)) return "전체 학년";
  return "학기 확인 필요";
}

function deadlineTypeLabel(value: unknown): "nomination" | "application" | "other" {
  const text = String(value ?? "").toLowerCase();
  if (/nomin|recommend|추천|지명/.test(text)) return "nomination";
  if (/application|apply|지원|신청/.test(text)) return "application";
  return "other";
}

function deadlineDate(row: RowValue): string {
  return String(row.deadline_date ?? row.date ?? row.deadline_text ?? "확인 필요");
}

function deadlineGroups(rows: RowValue[]) {
  const groups = new Map<string, { semester: string; nomination?: string; application?: string; other: string[] }>();
  for (const row of rows) {
    const semester = semesterLabel(row.semester);
    const group = groups.get(semester) ?? { semester, other: [] };
    const kind = deadlineTypeLabel(row.deadline_type);
    const date = deadlineDate(row);
    if (kind === "nomination") group.nomination ??= date;
    else if (kind === "application") group.application ??= date;
    else if (!group.other.includes(date)) group.other.push(date);
    groups.set(semester, group);
  }
  return [...groups.values()].sort((a, b) => a.semester.localeCompare(b.semester, "ko"));
}

function housingOverview(rows: RowValue[]) {
  const availableValues = rows.map((row) => row.housing_available).filter((value) => typeof value === "boolean") as boolean[];
  const guaranteeValues = rows.map((row) => row.housing_guaranteed ?? row.is_guaranteed).filter((value) => typeof value === "boolean") as boolean[];
  const availability = availableValues.includes(true) ? "제공 정보 있음" : availableValues.length && availableValues.every((value) => !value) ? "학교 기숙사 없음" : "제공 여부 확인 필요";
  const guarantee = guaranteeValues.includes(true) ? "일부 옵션 보장" : guaranteeValues.length && guaranteeValues.every((value) => !value) ? "배정 보장 없음" : "보장 여부 확인 필요";
  const options = [...new Set(rows.map((row) => [row.room_type, row.housing_type ?? row.housing_category, row.meal_type]
    .map((value) => String(value ?? "").trim()).filter(Boolean).join(" · ")).filter(Boolean))];
  return { availability, guarantee, options };
}

function rowsToSection(sectionNumber: string, sectionTitle: string, sectionKey: string, rows: RowValue[]): ProfileSection | null {
  const summaries = rows
    .slice(0, 5)
    .map((row) => displayEntries(sectionKey, row).slice(0, 4).map(([label, value]) => `${label}: ${value}`).join(" · "))
    .filter(Boolean);
  if (!summaries.length) return null;
  const evidenceUrl = sourceUrlFromRows(rows);
  return {
    section_number: sectionNumber,
    section_title: sectionTitle,
    summary: summaries.join("\n"),
    source_note: evidenceUrl ? "공식 자료 기반 구조화 정보" : "구조화 데이터",
    evidence_url: evidenceUrl,
    structured_items: rows.slice(0, 8).map((row, index) => ({
      title: `${sectionTitle} ${index + 1}`,
      fields: displayEntries(sectionKey, row).slice(0, 6).map(([label, value]) => ({ label, value })),
    })).filter((item) => item.fields.length > 0),
  };
}

export default async function UniversityDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const university = await getUniversity(id);
  if (!university) notFound();

  const program = university.exchange_programs?.[0];
  const profileSections = [...(university.profile_sections ?? [])].sort((a, b) =>
    a.section_number.localeCompare(b.section_number, undefined, { numeric: true }),
  );
  const hasAttachedMathReport = !universitiesWithoutAttachedMathReports.has(university.university_name);
  const structuredFallbackSections = [
    {
      section_number: "02",
      section_title: "대학 기본정보",
      summary: `${university.university_name}은(는) ${university.city}, ${university.country}에 위치한 교환대학입니다.`,
      source_note: "대학 기본정보",
    },
    {
      section_number: "03",
      section_title: "캠퍼스 위치·구성",
      summary: `등록 위치: ${university.city}, ${university.country}`,
      source_note: "대학 기본정보",
    },
    rowsToSection("07", "지원 자격·마감일", "application_deadlines", (program?.application_deadlines ?? []) as RowValue[]),
    program?.application_process ? {
      section_number: "08",
      section_title: "지원 서류·타임라인",
      summary: program.application_process,
      source_note: "구조화 데이터",
    } : null,
    rowsToSection("09", "어학 정보", "language_requirements", (program?.language_requirements ?? []) as RowValue[]),
    rowsToSection("10", "학사 일정", "academic_periods", (program?.academic_periods ?? []) as RowValue[]),
    program?.course_registration_notes ? {
      section_number: "11",
      section_title: "수강 신청·학점",
      summary: program.course_registration_notes,
      source_note: "구조화 데이터",
    } : null,
    rowsToSection("12", "학과·전공·제한 과목", "course_restrictions", (program?.course_restrictions ?? []) as RowValue[]),
    rowsToSection("14", "기숙사·숙소", "housing_options", (program?.housing_options ?? []) as RowValue[]),
    {
      section_number: "20",
      section_title: "교환학생 후기",
      summary: hasAttachedMathReport
        ? "성균관대학교 학생 수학보고서 원본이 확인되었습니다. 개인정보를 제외한 후기 요약은 재가공 후 연결될 예정이며, 원본은 Challenge Square에서 확인할 수 있습니다."
        : "현재 첨부된 수학보고서 묶음에서는 이 대학의 보고서 원본을 확인하지 못했습니다. 추가 자료가 확보되면 개인정보를 제외한 요약을 연결합니다.",
      source_note: hasAttachedMathReport ? "수학보고서 원본 확인 · 요약 연결 준비 중" : "수학보고서 원본 미확인",
    },
  ].filter((section): section is ProfileSection => Boolean(section));

  return (
    <main>
      <style>{detailCardCss}</style>
      <Header />
      <section className="detail-hero">
        <UniversityCover name={university.university_name} fallback={university.image_url} className="detail-university-cover" />
        <UniversityLogo name={university.university_name} className="detail-university-logo" />
        <Link href="/universities">← 대학 목록</Link>
        <p className="eyebrow">
          {university.country} · {university.city}
        </p>
        <h1>{university.university_name}</h1>
        <p>{university.summary}</p>
        <div>
          <span>{program?.program_name ?? "Exchange Program"}</span>
          <span>{program?.academic_year ?? "최신 학년도"}</span>
          <span>정보 검수 완료</span>
        </div>
      </section>

      <div className="detail-layout">
        <aside className="detail-nav">
          <b>대학 정보</b>
          <a href="#overview">한눈에 보기</a>
          {Object.entries(sectionLabels).map(([key, label]) => (
            <a key={key} href={`#${key}`}>
              {label}
            </a>
          ))}
          <a className="active-like" href="#profile-sections">22개 조사 항목</a>
          <a href="#sources">출처</a>
        </aside>

        <section className="detail-content">
          <article id="overview" className="info-section">
            <div className="section-heading">
              <span>01</span>
              <h2>한눈에 보기</h2>
            </div>
            <div className="overview-grid">
              <div>
                <small>프로그램</small>
                <b>{program?.program_name ?? "Incoming Exchange"}</b>
              </div>
              <div>
                <small>학년도</small>
                <b>{program?.academic_year ?? "확인 필요"}</b>
              </div>
              <div>
                <small>위치</small>
                <b>
                  {university.city}, {university.country}
                </b>
              </div>
              <div>
                <small>교환 유형</small>
                <b>{program?.exchange_type ?? "International Exchange"}</b>
              </div>
            </div>
            {program?.application_process && <p className="body-copy">{program.application_process}</p>}
          </article>

          {Object.entries(sectionLabels).map(([key, label], index) => {
            const rows = (program?.[key as keyof typeof program] as RowValue[] | undefined) ?? [];
            return (
              <article id={key} className="info-section" key={key}>
                <div className="section-heading">
                  <span>{String(index + 2).padStart(2, "0")}</span>
                  <h2>{label}</h2>
                  <em>{rows.length}건</em>
                </div>
                {rows.length ? (
                  key === "application_deadlines" ? (
                    <div className="compact-fact-panel">
                      <table className="deadline-table">
                        <thead><tr><th>학기</th><th>본교 추천 마감</th><th>학생 지원 마감</th></tr></thead>
                        <tbody>{deadlineGroups(rows).map((group) => (
                          <tr key={group.semester}><td>{group.semester}</td><td>{group.nomination ?? "확인 필요"}</td><td>{group.application ?? group.other[0] ?? "확인 필요"}</td></tr>
                        ))}</tbody>
                      </table>
                      <div className="section-source-links">{uniqueSourceUrls(rows).map((url) => <a href={url} key={url} target="_blank" rel="noreferrer">공식 출처 보기 ↗</a>)}</div>
                    </div>
                  ) : key === "housing_options" ? (
                    <div className="compact-fact-panel">
                      <div className="housing-overview">
                        <div><small>기숙사 제공</small><strong>{housingOverview(rows).availability}</strong></div>
                        <div><small>배정 보장</small><strong>{housingOverview(rows).guarantee}</strong></div>
                      </div>
                      {housingOverview(rows).options.length > 0 && <div className="housing-option-list">{housingOverview(rows).options.map((option) => <span key={option}>{option}</span>)}</div>}
                      <div className="section-source-links">{uniqueSourceUrls(rows).map((url) => <a href={url} key={url} target="_blank" rel="noreferrer">공식 출처 보기 ↗</a>)}</div>
                    </div>
                  ) : (
                    <div className="clean-data-list">
                      {rows.slice(0, 12).map((row, rowIndex) => (
                        <div className="clean-data-row" key={rowIndex}>
                          {displayEntries(key, row).map(([label, value]) => <p key={label}><small>{label}</small><span>{value}</span></p>)}
                          {typeof row.source_url === "string" && row.source_url && <a className="clean-source-link" href={row.source_url} target="_blank" rel="noreferrer">공식 출처 보기 ↗</a>}
                        </div>
                      ))}
                    </div>
                  )
                ) : (
                  <p className="empty-state">현재 등록된 구조화 데이터에서는 확인이 필요합니다.</p>
                )}
              </article>
            );
          })}

          <article id="profile-sections" className="info-section">
            <div className="research-intro">
              <span>08</span>
              <h2>22개 조사 항목</h2>
              <em>22건</em>
            </div>
            <ResearchItemGrid
              sections={profileSections}
              fallbackSections={structuredFallbackSections}
              unknowns={university.unknowns}
              sourceLinks={program?.source_links}
            />
          </article>

          <article id="sources" className="info-section">
            <div className="section-heading">
              <span>09</span>
              <h2>출처</h2>
            </div>
            <div className="source-list">
              {program?.source_links?.map((source, index) => (
                <a key={index} href={String(source.url)} target="_blank" rel="noreferrer">
                  <span>↗</span>
                  <b>{formatValue(source.title)}</b>
                  <small>{source.is_official ? "공식 자료" : "참고 자료"}</small>
                </a>
              ))}
            </div>
          </article>
        </section>
      </div>
    </main>
  );
}
