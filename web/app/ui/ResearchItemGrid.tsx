import type { ProfileSection, SourceLink } from "../lib/types";
import { presentUnknowns } from "../lib/display/present-fact";

const MISSING_TEXT = "찾을 수 없는 내용";
const NO_UNVERIFIED_TEXT = "등록된 미확인 항목이 없습니다.";

type ResearchDefinition = {
  number: string;
  icon: string;
  title: string;
  aliases: string[];
};

type ResearchItemGridProps = {
  sections?: ProfileSection[];
  fallbackSections?: ProfileSection[];
  unknowns?: string[];
  sourceLinks?: SourceLink[];
  /** 22번 항목 필터링 결과를 개발 콘솔에 남길 때 대학을 식별하기 위한 라벨(선택). */
  universityName?: string;
};

type PreparedResearchItem = ResearchDefinition & {
  bullets: string[];
  overflowBullets: string[];
  summary?: string;
  groups: Array<{ title: string; items: string[] }>;
  structuredItems: Array<{ title: string; fields: Array<{ label: string; value: string }> }>;
  reportCount?: number;
  sourceNote: string;
  links: SourceLink[];
  missing: boolean;
};

const REVIEW_LABELS: Record<string, string> = {
  "수업": "수업·학업",
  "주거": "주거·기숙사",
  "비용": "비용",
  "이동": "공항·교통",
  "학생생활": "학생생활",
  "팁": "실전 팁",
  "주의": "주의사항",
};

function parseReview(summary?: string) {
  const lines = (summary ?? "").replace(/\r/g, "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const overview = lines.shift() ?? "";
  const groups = lines.map((line) => {
    const match = line.match(/^([^:]{1,12}):\s*(.*)$/);
    const rawTitle = match?.[1]?.trim() ?? "기타";
    const content = match?.[2]?.trim() ?? line;
    return {
      title: REVIEW_LABELS[rawTitle] ?? rawTitle,
      items: content.split(/\s*\/\s*/).map((item) => item.trim()).filter(Boolean).slice(0, 4),
    };
  }).filter((group) => group.items.length);
  return { overview, groups };
}

export const RESEARCH_ITEMS: ResearchDefinition[] = [
  { number: "01", icon: "검증", title: "성균관대 자료 검증", aliases: ["성균관대 자료 검증", "자료 검증", "skku 검증"] },
  { number: "02", icon: "기본", title: "대학 기본정보", aliases: ["대학 기본정보", "기본 정보", "개요", "대학 정보"] },
  { number: "03", icon: "위치", title: "캠퍼스 위치·구성", aliases: ["캠퍼스 위치", "캠퍼스 구성", "위치 및 구성"] },
  { number: "04", icon: "이동", title: "공항·대학 이동", aliases: ["공항 대학 이동", "공항 이동", "공항에서", "airport"] },
  { number: "05", icon: "평가", title: "대학 평가·랭킹", aliases: ["대학 평가", "랭킹", "순위", "ranking"] },
  { number: "06", icon: "강점", title: "강점 분야·교육 성격", aliases: ["강점 분야", "교육 성격", "강점", "연구 참여", "연구"] },
  { number: "07", icon: "지원", title: "지원 자격·마감일", aliases: ["지원 자격", "지원 일정", "마감일", "자격"] },
  { number: "08", icon: "서류", title: "지원 서류·타임라인", aliases: ["지원 서류", "지원 절차", "타임라인", "준비 서류", "절차"] },
  { number: "09", icon: "어학", title: "어학 정보", aliases: ["어학 정보", "어학 성적", "언어 요건", "언어"] },
  { number: "10", icon: "일정", title: "학사 일정", aliases: ["학사 일정", "학기 일정", "academic calendar"] },
  { number: "11", icon: "수강", title: "수강 신청·학점", aliases: ["수강 신청", "수강신청", "수강 및 학점", "학점"] },
  { number: "12", icon: "전공", title: "학과·전공·제한 과목", aliases: ["학과 전공", "전공 및 과목", "제한 과목", "전공", "과목 제한"] },
  { number: "13", icon: "시설", title: "캠퍼스 시설", aliases: ["캠퍼스 시설", "교내 시설", "시설"] },
  { number: "14", icon: "주거", title: "기숙사·숙소", aliases: ["기숙사 숙소", "기숙사", "숙소", "주거"] },
  { number: "15", icon: "비용", title: "예상 비용", aliases: ["예상 비용", "생활 비용", "생활비", "비용"] },
  { number: "16", icon: "교통", title: "대중교통·학생 할인", aliases: ["대중교통", "학생 할인", "교통"] },
  { number: "17", icon: "생활", title: "학생생활", aliases: ["학생생활", "학생 생활", "동아리", "버디", "student life"] },
  { number: "18", icon: "현지", title: "현지생활", aliases: ["현지생활", "현지 생활", "비자 및 입국", "비자", "치안", "병원", "통신"] },
  { number: "19", icon: "항공", title: "항공편", aliases: ["항공편", "항공", "비행기"] },
  { number: "20", icon: "후기", title: "교환학생 후기", aliases: ["교환학생 후기", "학생 후기", "후기", "경험담", "수학보고서"] },
  { number: "21", icon: "자료", title: "공식 자료 링크", aliases: ["공식 자료 링크", "공식 자료", "자료 링크", "출처"] },
  { number: "22", icon: "확인", title: "확인하기 어려운 정보", aliases: ["확인하기 어려운 정보", "미확인 정보", "추가 확인", "기타"] },
];

function normalized(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9가-힣]+/g, "").trim();
}

function matchesDefinition(section: ProfileSection, definition: ResearchDefinition): boolean {
  const title = normalized(section.section_title ?? "");
  if (!title) return false;
  return definition.aliases.some((alias) => {
    const candidate = normalized(alias);
    return title === candidate || title.includes(candidate) || candidate.includes(title);
  });
}

export function summaryToBullets(summary?: string): string[] {
  const text = (summary ?? "").replace(/\r/g, " ").trim();
  if (!text || text === MISSING_TEXT) return [MISSING_TEXT];
  const withBreaks = text
    .replace(/\s+(?=\d{1,2}[.)]\s+)/g, "\n")
    .replace(/([.!?])\s+(?=[가-힣A-Z0-9“"])/g, "$1\n");
  const bullets = withBreaks
    .split(/\n+/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d{1,2}[.)])\s*/, "").trim())
    .filter(Boolean);
  return bullets.length ? bullets.slice(0, 8) : [MISSING_TEXT];
}

function validLinks(links: SourceLink[]): SourceLink[] {
  const seen = new Set<string>();
  return links.filter((link) => {
    const url = link.url?.trim();
    if (!url || !/^https?:\/\//i.test(url) || seen.has(url)) return false;
    seen.add(url);
    return true;
  });
}

function sectionLinks(sections: ProfileSection[]): SourceLink[] {
  return sections.map((section) => ({
    title: section.section_title,
    url: section.evidence_url,
    is_official: Boolean(section.source_note && /공식|official/i.test(section.source_note)),
  }));
}

function sourceNoteFor(sections: ProfileSection[], links: SourceLink[]): string {
  const notes = sections.map((section) => section.source_note?.trim()).filter((note): note is string => Boolean(note));
  if (notes.length) return [...new Set(notes)].join(" · ");
  if (links.some((link) => link.is_official)) return "공식 자료";
  if (links.length) return "참고 자료";
  return "출처 확인 필요";
}

export function prepareResearchItems({
  sections = [],
  fallbackSections = [],
  unknowns = [],
  sourceLinks = [],
  universityName,
}: ResearchItemGridProps): PreparedResearchItem[] {
  const claimed = new Set<ProfileSection>();
  const prepared = RESEARCH_ITEMS.map((definition) => {
    let matches = sections.filter((section) => !claimed.has(section) && matchesDefinition(section, definition));
    matches.forEach((section) => claimed.add(section));
    const fallbackMatches = fallbackSections.filter((section) => matchesDefinition(section, definition));
    if (!matches.length || fallbackMatches.some((section) => (section.structured_items?.length ?? 0) > 0)) {
      matches = fallbackMatches.length ? fallbackMatches : matches;
    }
    let bullets = matches.flatMap((section) => summaryToBullets(section.summary));
    let links = sectionLinks(matches);
    let overflowBullets: string[] = [];
    let unverifiedIsEmpty = false;

    if (definition.number === "21" && sourceLinks.length) {
      bullets = sourceLinks.map((link) => link.title?.trim() || "공식 자료");
      links = [...links, ...sourceLinks];
    }
    if (definition.number === "22") {
      // unverified_items 는 공식 출처로 확정하지 못한 항목을 알리는 정직성 장치이지만,
      // 추출 단계에서 재귀 증식 노이즈·오분류된 확정 사실·섹션 요약문이 섞여 들어온다.
      // 원본 unknowns 값은 그대로 두고 표시 직전에만 presentUnknowns 로 거른다.
      const result = presentUnknowns(unknowns);
      bullets = result.shown;
      overflowBullets = result.overflow;
      unverifiedIsEmpty = result.shown.length === 0 && result.overflow.length === 0;
      if (process.env.NODE_ENV !== "production" && unknowns.length) {
        const after = result.shown.length + result.overflow.length;
        // presentUnknowns 내부에서 완전히 같은 문자열은 먼저 하나로 합치므로, raw unknowns.length가
        // 아니라 (표시 + 접힘 + 제외)의 합을 "필터 전" 값으로 써야 두 숫자가 항상 맞아떨어진다.
        const before = after + result.filtered.length;
        const excludedPreview = result.filtered.slice(0, 5);
        console.info(
          `[research-item-22] ${universityName ?? "(대학명 미상)"}: 필터 전 ${before}건(원본 ${unknowns.length}건) -> 후 ${after}건` +
            (excludedPreview.length ? ` | 제외 ${result.filtered.length}건 예시: ${excludedPreview.join(" / ")}` : ""),
        );
      }
    }

    bullets = definition.number === "22" ? bullets : [...new Set(bullets)];
    links = validLinks(links);
    const missing = definition.number === "22" ? unverifiedIsEmpty : bullets.length === 0 || bullets.every((bullet) => bullet === MISSING_TEXT);
    const review = definition.number === "20" && matches[0] ? parseReview(matches[0].summary) : undefined;
    return {
      ...definition,
      bullets: review ? [] : missing ? [definition.number === "22" ? NO_UNVERIFIED_TEXT : MISSING_TEXT] : bullets,
      overflowBullets: missing ? [] : overflowBullets,
      summary: review?.overview,
      groups: review?.groups ?? [],
      structuredItems: matches.flatMap((section) => section.structured_items ?? []),
      reportCount: matches.reduce((count, section) => count + (section.report_count ?? 0), 0) || undefined,
      sourceNote: missing ? (definition.number === "22" ? "확인 필요 항목 없음" : "미확인") : definition.number === "22" ? "추가 확인 필요" : sourceNoteFor(matches, links),
      links,
      missing,
    };
  });

  const unmatched = sections.filter((section) => !claimed.has(section));
  if (unmatched.length) {
    const reviewItem = prepared.find((item) => item.number === "22");
    if (reviewItem) {
      const unmatchedBullets = unmatched.flatMap((section) =>
        summaryToBullets(section.summary).map((bullet) => `${section.section_title}: ${bullet}`),
      );
      reviewItem.bullets = reviewItem.missing ? unmatchedBullets : [...reviewItem.bullets, ...unmatchedBullets];
      reviewItem.links = validLinks([...reviewItem.links, ...sectionLinks(unmatched)]);
      reviewItem.sourceNote = "추가 확인 필요";
      reviewItem.missing = false;
    }
  }
  return prepared;
}

export function ResearchItemGrid(props: ResearchItemGridProps) {
  const items = prepareResearchItems(props);
  return (
    <div className="research-item-grid" aria-label="22개 대학 조사 항목">
      {items.map((item) => (
        <article className={`research-item-card${item.missing ? " is-missing" : ""}`} key={item.number}>
          <header className="research-item-header">
            <span className="research-item-number">{item.number}</span>
            <span className="research-item-icon" aria-hidden="true">{item.icon}</span>
            <h3>{item.title}</h3>
          </header>
          {item.summary && <p className="research-item-summary">{item.summary}</p>}
          {item.groups.length > 0 && (
            <div className="research-review-groups">
              {item.groups.map((group) => (
                <section key={group.title}>
                  <h4>{group.title}</h4>
                  <ul>{group.items.map((entry) => <li key={entry}>{entry}</li>)}</ul>
                </section>
              ))}
            </div>
          )}
          {item.structuredItems.length > 0 ? (
            <div className="research-structured-items">
              {item.structuredItems.map((entry, index) => (
                <section key={`${entry.title}-${index}`}>
                  <h4>{entry.title}</h4>
                  <dl>{entry.fields.map((field) => <div key={`${field.label}-${field.value}`}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}</dl>
                </section>
              ))}
            </div>
          ) : item.bullets.length > 0 && (
            <>
              <ul className="research-item-bullets">
                {item.bullets.map((bullet, index) => <li key={`${item.number}-${index}`}>{bullet}</li>)}
              </ul>
              {item.overflowBullets.length > 0 && (
                <details className="research-item-overflow">
                  <summary>더 보기 (+{item.overflowBullets.length})</summary>
                  <ul className="research-item-bullets">
                    {item.overflowBullets.map((bullet, index) => <li key={`${item.number}-overflow-${index}`}>{bullet}</li>)}
                  </ul>
                </details>
              )}
            </>
          )}
          <footer className="research-item-footer">
            <span className={`research-status${item.missing ? " missing" : ""}`}>
              {item.reportCount ? `${item.reportCount}건 통합 요약 · ` : ""}{item.sourceNote}
            </span>
            {item.links.length > 0 && (
              <div className="research-item-links">
                {item.links.map((link) => (
                  <a href={link.url ?? undefined} key={String(link.url)} target="_blank" rel="noreferrer">
                    {link.is_official ? "공식 자료" : "참고 자료"} 열기 ↗
                  </a>
                ))}
              </div>
            )}
          </footer>
        </article>
      ))}
    </div>
  );
}
