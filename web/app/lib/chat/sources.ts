import type { University } from "../types";
import type { ChatSource, Intent } from "./types";
import { cleanText, isClearlyNonOfficialUrl, isValidHttpUrl, normalizeSearchText, programOf } from "./utils";

function sourceTypeLabel(value: unknown) {
  const text = cleanText(value, "source");
  return text.replace(/_/g, " ");
}

export function universitySources(university: University): ChatSource[] {
  const sources: ChatSource[] = [];
  const program = programOf(university);

  for (const row of program?.source_links ?? []) {
    const url = cleanText(row.url);
    if (!isValidHttpUrl(url)) continue;
    sources.push({
      title: cleanText(row.title, sourceTypeLabel(row.source_type)),
      url,
      university_name: university.university_name,
      source_type: cleanText(row.source_type),
      is_official: row.is_official !== false,
      field_key: "source_links",
      evidence_quote: cleanText(row.evidence_quote, ""),
    });
  }

  for (const section of university.profile_sections ?? []) {
    const url = cleanText(section.evidence_url);
    if (!isValidHttpUrl(url)) continue;
    sources.push({
      title: section.section_title || `Section ${section.section_number}`,
      url,
      university_name: university.university_name,
      source_type: "profile_section",
      is_official: !url.includes("blog.naver.com"),
      field_key: `section_${section.section_number}`,
      evidence_quote: cleanText(section.summary, "").slice(0, 220),
    });
  }

  for (const [title, url] of [
    ["Incoming Exchange Page", university.incoming_exchange_url],
    ["Official Website", university.official_website_url],
  ] as const) {
    if (url && isValidHttpUrl(url)) {
      sources.push({
        title,
        url,
        university_name: university.university_name,
        source_type: title,
        is_official: true,
      });
    }
  }

  return sources;
}

function urlHost(value: string | undefined) {
  if (!value) return "";
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function looksLikeOtherUniversitySource(university: University, source: ChatSource) {
  const title = normalizeSearchText(source.title);
  const ownName = normalizeSearchText(university.university_name);
  if (!/(university|school|college|institut|universite)/.test(title)) return false;
  const ownTokens = ownName.split(/\s+/).filter((token) => token.length >= 4);
  return ownTokens.length > 0 && !ownTokens.some((token) => title.includes(token));
}

function sourceScore(university: University, source: ChatSource, intent: Intent) {
  const text = normalizeSearchText(`${source.title} ${source.source_type} ${source.url}`);
  const officialHost = urlHost(university.official_website_url);
  const incomingHost = urlHost(university.incoming_exchange_url);
  const sourceHost = urlHost(source.url);
  const isOwnDomain = Boolean(
    sourceHost &&
      ((officialHost && (sourceHost === officialHost || sourceHost.endsWith(`.${officialHost}`))) ||
        (incomingHost && (sourceHost === incomingHost || sourceHost.endsWith(`.${incomingHost}`)))),
  );
  const keyword: Record<Intent, RegExp> = {
    housing: /housing|accommodation|residence|dorm|기숙|숙소/,
    language: /language|ielts|toefl|english|어학|영어/,
    cost: /cost|fee|tuition|housing|accommodation|living|비용|학비|등록금|기숙/,
    deadline: /application|deadline|nomination|calendar|마감|일정|지원/,
    quota: /fact|exchange|application|quota|정원/,
    restriction: /restricted|restriction|prerequisite|approval|required|limited|course|subject/,
    source: /./,
    general: /exchange|incoming|fact|official/,
  };

  let score = 0;
  if (isOwnDomain) score += 20;
  if (source.is_official !== false) score += 8;
  if (keyword[intent].test(text)) score += 6;
  if (/incoming|exchange|fact|official/.test(text)) score += 4;
  if (looksLikeOtherUniversitySource(university, source)) score -= 18;
  if (/blog|naver|youtube|drive\.google|docs\.google/.test(text)) score -= 8;
  return score;
}

export function firstSource(university: University, intent: Intent) {
  const sources = universitySources(university);
  return sources
    .map((source) => ({ source, score: sourceScore(university, source, intent) }))
    .sort((a, b) => b.score - a.score)[0]?.source;
}

export function actionLabel(intent: Intent) {
  if (intent === "housing") return "기숙사 정보 보기";
  if (intent === "language") return "어학 조건 보기";
  if (intent === "cost") return "비용 정보 보기";
  if (intent === "deadline") return "지원 일정 보기";
  if (intent === "quota") return "정원 정보 보기";
  if (intent === "restriction") return "수강 제한 보기";
  if (intent === "source") return "출처 확인하기";
  return "상세 정보 보기";
}

export function sourceFieldForIntent(intent: Intent) {
  if (intent === "cost") return "cost_facts";
  if (intent === "housing") return "housing_facts";
  if (intent === "language") return "language_requirements";
  if (intent === "deadline") return "application_deadlines";
  return `${intent}_facts`;
}

export function rowSource(university: University, row: Record<string, unknown>, fieldKey: string, fallbackTitle: string): ChatSource | undefined {
  const url = cleanText(row.source_url, cleanText(row.url, cleanText(row.evidence_url)));
  if (!isValidHttpUrl(url)) return undefined;
  return {
    fact_id: cleanText(row.fact_id, cleanText(row.id)),
    title: cleanText(row.source_title, cleanText(row.title, fallbackTitle)),
    url,
    university_name: university.university_name,
    source_type: cleanText(row.source_type, fieldKey),
    is_official: !isClearlyNonOfficialUrl(url),
    field_key: fieldKey,
    evidence_quote: cleanText(row.evidence_quote, cleanText(row.original_text, "")).slice(0, 220),
  };
}
