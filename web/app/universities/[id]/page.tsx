import Link from "next/link";
import { notFound } from "next/navigation";
import { getUniversity } from "../../lib/supabase";
import { Header } from "../../ui/Header";

const labels: Record<string, string> = { application_deadlines: "지원 일정", language_requirements: "어학 성적", academic_periods: "학사 일정", housing_options: "기숙사", estimated_costs: "예상 비용", required_documents: "준비 서류" };
const display = (value: unknown) => value === null || value === undefined ? "확인 중" : typeof value === "object" ? Object.values(value as Record<string, unknown>).filter(Boolean).join(" · ") : String(value);

export default async function UniversityDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const university = await getUniversity(id);
  if (!university) notFound();
  const program = university.exchange_programs?.[0];
  const profileSections = university.profile_sections ?? [];
  return <main><Header/><section className="detail-hero"><Link href="/universities">← 대학 목록</Link><p className="eyebrow">{university.country} · {university.city}</p><h1>{university.university_name}</h1><p>{university.summary}</p><div><span>{program?.program_name ?? "Exchange Program"}</span><span>{program?.academic_year ?? "최신 학년도"}</span><span>정보 검수 완료</span></div></section>
    <div className="detail-layout"><aside className="detail-nav"><b>대학 정보</b><a href="#overview">한눈에 보기</a>{Object.entries(labels).map(([key, label]) => <a key={key} href={`#${key}`}>{label}</a>)}{profileSections.length > 0 && <a href="#profile-sections">22개 조사 항목</a>}<a href="#sources">출처</a></aside>
      <section className="detail-content"><article id="overview" className="info-section"><div className="section-heading"><span>01</span><h2>한눈에 보기</h2></div><div className="overview-grid"><div><small>프로그램</small><b>{program?.program_name}</b></div><div><small>학년도</small><b>{program?.academic_year}</b></div><div><small>위치</small><b>{university.city}, {university.country}</b></div><div><small>교환 유형</small><b>{program?.exchange_type ?? "International Exchange"}</b></div></div>{program?.application_process && <p className="body-copy">{program.application_process}</p>}</article>
        {Object.entries(labels).map(([key, label], sectionIndex) => { const rows = (program?.[key as keyof typeof program] as Record<string, unknown>[] | undefined) ?? []; return <article id={key} className="info-section" key={key}><div className="section-heading"><span>{String(sectionIndex + 2).padStart(2,"0")}</span><h2>{label}</h2><em>{rows.length}건</em></div>{rows.length ? <div className="data-list">{rows.slice(0, 12).map((row, index) => <div key={index}>{Object.entries(row).filter(([field, value]) => !["id","exchange_program_id","created_at","source_url"].includes(field) && value !== null).slice(0,4).map(([field, value]) => <p key={field}><small>{field.replaceAll("_"," ")}</small><span>{display(value)}</span></p>)}</div>)}</div> : <p className="empty-state">확인된 정보가 아직 없습니다.</p>}</article>; })}
        {profileSections.length > 0 && <article id="profile-sections" className="info-section"><div className="section-heading"><span>08</span><h2>22개 조사 항목</h2><em>{profileSections.length}건</em></div><div className="data-list rich-section-list">{profileSections.sort((a, b) => a.section_number.localeCompare(b.section_number)).map((section) => <div key={`${section.section_number}-${section.section_title}`}><p><small>{section.section_number}</small><span><b>{section.section_title}</b></span></p><p><small>요약</small><span>{section.summary}</span></p>{section.source_note && <p><small>출처 성격</small><span>{section.source_note}</span></p>}{section.evidence_url && <p><small>근거</small><span><a href={section.evidence_url} target="_blank" rel="noreferrer">자료 열기 ↗</a></span></p>}</div>)}</div>{Boolean(university.unknowns?.length) && <div className="unknown-list"><h3>추가 확인 필요</h3>{university.unknowns?.map((item, index) => <p key={index}>{item}</p>)}</div>}</article>}
        <article id="sources" className="info-section"><div className="section-heading"><span>08</span><h2>공식 출처</h2></div><div className="source-list">{program?.source_links?.map((source, index) => <a key={index} href={String(source.url)} target="_blank" rel="noreferrer"><span>↗</span><b>{display(source.title)}</b><small>{source.is_official ? "공식 자료" : "참고 자료"}</small></a>)}</div></article>
      </section>
    </div>
  </main>;
}
