import Link from "next/link";
import { notFound } from "next/navigation";
import { getUniversity } from "../../lib/supabase";
import { Header } from "../../ui/Header";
import { UniversityCover, UniversityLogo } from "../../ui/LocalMedia";

type RowValue = Record<string, unknown>;

const sectionLabels: Record<string, string> = {
  application_deadlines: "지원 일정",
  language_requirements: "어학 성적",
  academic_periods: "학사 일정",
  housing_options: "기숙사",
  estimated_costs: "예상 비용",
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
  housing_guaranteed: "보장 여부",
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
.unknown-list h3:before{content:"검토 메모"}
@media(max-width:980px){.rich-section-card-grid{grid-template-columns:1fr}.clean-data-row{grid-template-columns:1fr}.research-intro{display:block}.research-intro em{display:block;margin-top:8px}}
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

function splitSummary(summary?: string) {
  const clean = (summary ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return ["현재 등록된 구조화 데이터에서는 확인이 필요합니다."];

  const explicitBullets = clean
    .split(/\s*[•·]\s+|\s+-\s+/)
    .map((item) => item.replace(/^\d+[.)]\s*/, "").trim())
    .filter(Boolean);
  if (explicitBullets.length >= 2) return explicitBullets.slice(0, 4);

  const sentences = clean
    .split(/(?<=다\.)\s+|(?<=[.!?])\s+/)
    .map((item) => item.replace(/^\d+[.)]\s*/, "").trim())
    .filter(Boolean);
  if (sentences.length >= 2) return sentences.slice(0, 4);

  const commaParts = clean
    .split(/,\s+|;\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return commaParts.length >= 2 ? commaParts.slice(0, 4) : [clean];
}

function rowEntries(row: RowValue) {
  return Object.entries(row)
    .filter(([field, value]) => !hiddenFields.has(field) && value !== null && value !== undefined && value !== "")
    .slice(0, 6);
}

function sourceLabel(sourceNote?: string) {
  const note = sourceNote?.trim();
  if (!note) return "공식 자료";
  if (/student|review|blog|후기|수학보고서/i.test(note)) return "후기/보조 자료";
  return note;
}

export default async function UniversityDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const university = await getUniversity(id);
  if (!university) notFound();

  const program = university.exchange_programs?.[0];
  const profileSections = [...(university.profile_sections ?? [])].sort((a, b) =>
    a.section_number.localeCompare(b.section_number, undefined, { numeric: true }),
  );

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
          {profileSections.length > 0 && (
            <a className="active-like" href="#profile-sections">
              22개 조사 항목
            </a>
          )}
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
                  <div className="clean-data-list">
                    {rows.slice(0, 12).map((row, rowIndex) => (
                      <div className="clean-data-row" key={rowIndex}>
                        {rowEntries(row).map(([field, value]) => (
                          <p key={field}>
                            <small>{formatFieldName(field)}</small>
                            <span>{formatValue(value)}</span>
                          </p>
                        ))}
                        {typeof row.source_url === "string" && row.source_url && (
                          <a className="clean-source-link" href={row.source_url} target="_blank" rel="noreferrer">
                            공식 출처 보기 ↗
                          </a>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="empty-state">현재 등록된 구조화 데이터에서는 확인이 필요합니다.</p>
                )}
              </article>
            );
          })}

          {profileSections.length > 0 && (
            <article id="profile-sections" className="info-section">
              <div className="research-intro">
                <span>08</span>
                <h2>22개 조사 항목</h2>
                <em>{profileSections.length}건</em>
              </div>
              <div className="rich-section-card-grid">
                {profileSections.map((section) => (
                  <section className="research-card" key={`${section.section_number}-${section.section_title}`}>
                    <div className="research-card-body">
                      <small className="research-card-number">{section.section_number}</small>
                      <h3>{section.section_title}</h3>
                      <ul>
                        {splitSummary(section.summary).map((item, bulletIndex) => (
                          <li key={bulletIndex}>{item}</li>
                        ))}
                      </ul>
                    </div>
                    <div className="research-card-footer">
                      <span className="source-label">출처 성격</span>
                      <b className="source-chip">{sourceLabel(section.source_note)}</b>
                      {section.evidence_url ? (
                        <a href={section.evidence_url} target="_blank" rel="noreferrer">
                          자료 열기 ↗
                        </a>
                      ) : (
                        <span className="research-empty">근거 확인 필요</span>
                      )}
                    </div>
                  </section>
                ))}
              </div>
              {Boolean(university.unknowns?.length) && (
                <div className="unknown-list">
                  <h3>추가 확인 필요</h3>
                  {university.unknowns?.map((item, index) => (
                    <p key={index}>{item}</p>
                  ))}
                </div>
              )}
            </article>
          )}

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
