import { NextResponse } from "next/server";
import { getUniversities } from "../../lib/supabase";
import type { ExchangeProgram, ProfileSection, University } from "../../lib/types";

export const runtime = "nodejs";

const UPSTAGE_CHAT_URL = "https://api.upstage.ai/v1/chat/completions";
const MAX_MESSAGES = 8;
const MAX_MESSAGE_LENGTH = 2000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_REQUESTS = 10;

const requestBuckets = new Map<string, { count: number; resetAt: number }>();

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type ChatSource = {
  title: string;
  url: string;
  university_name?: string;
  source_type?: string;
  is_official?: boolean;
};

function compactText(value: unknown, maxLength = 500): unknown {
  if (typeof value !== "string") return value;
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function cleanText(value: unknown, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  return value.replace(/\s+/g, " ").trim() || fallback;
}

function compactRows(rows: Record<string, unknown>[] | undefined, limit = 6) {
  return (rows ?? []).slice(0, limit).map((row) =>
    Object.fromEntries(
      Object.entries(row)
        .filter(
          ([key, value]) =>
            !["id", "created_at", "updated_at", "exchange_program_id", "university_id"].includes(key) && value != null,
        )
        .map(([key, value]) => [key, compactText(value)]),
    ),
  );
}

function compactSections(sections: ProfileSection[] | undefined, limit = 8) {
  return (sections ?? []).slice(0, limit).map((section) => ({
    number: section.section_number,
    title: section.section_title,
    summary: compactText(section.summary, 500),
    source: section.evidence_url,
  }));
}

function compactProgram(program: ExchangeProgram) {
  return {
    academic_year: program.academic_year,
    program_name: program.program_name,
    exchange_type: program.exchange_type,
    application_process: compactText(program.application_process, 700),
    course_registration_notes: compactText(program.course_registration_notes, 700),
    application_deadlines: compactRows(program.application_deadlines),
    language_requirements: compactRows(program.language_requirements, 8),
    academic_periods: compactRows(program.academic_periods),
    housing_options: compactRows(program.housing_options),
    estimated_costs: compactRows(program.estimated_costs),
    required_documents: compactRows(program.required_documents),
    source_links: compactRows(program.source_links, 8),
  };
}

function compactUniversity(university: University) {
  return {
    university_name: university.university_name,
    country: university.country,
    city: university.city,
    summary: compactText(university.summary, 700),
    official_website_url: university.official_website_url,
    incoming_exchange_url: university.incoming_exchange_url,
    exchange_programs: (university.exchange_programs ?? []).slice(0, 2).map(compactProgram),
    profile_sections: compactSections(university.profile_sections),
    unknowns: university.unknowns?.slice(0, 8),
  };
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    (item.role === "user" || item.role === "assistant") &&
    typeof item.content === "string" &&
    item.content.trim().length > 0 &&
    item.content.length <= MAX_MESSAGE_LENGTH
  );
}

function isRateLimited(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const clientId = forwarded || "anonymous";
  const now = Date.now();
  const bucket = requestBuckets.get(clientId);

  if (!bucket || bucket.resetAt <= now) {
    requestBuckets.set(clientId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }

  bucket.count += 1;
  if (requestBuckets.size > 500) {
    for (const [key, value] of requestBuckets) {
      if (value.resetAt <= now) requestBuckets.delete(key);
    }
  }
  return bucket.count > RATE_LIMIT_REQUESTS;
}

function isValidHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function sourceTypeLabel(value: unknown) {
  const text = cleanText(value, "source");
  return text.replace(/_/g, " ");
}

function universitySources(university: University): ChatSource[] {
  const sources: ChatSource[] = [];
  const program = university.exchange_programs?.[0];

  for (const row of program?.source_links ?? []) {
    const url = cleanText(row.url);
    if (!isValidHttpUrl(url)) continue;
    sources.push({
      title: cleanText(row.title, sourceTypeLabel(row.source_type)),
      url,
      university_name: university.university_name,
      source_type: cleanText(row.source_type),
      is_official: row.is_official !== false,
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

function collectSources(universities: University[], question: string, answer: string): ChatSource[] {
  const haystack = `${question}\n${answer}`.toLowerCase();
  const candidates = universities.flatMap((university) => {
    const universityNeedle = university.university_name.toLowerCase();
    const cityNeedle = university.city.toLowerCase();
    const countryNeedle = university.country.toLowerCase();
    let score = 0;

    if (universityNeedle && haystack.includes(universityNeedle)) score += 10;
    if (cityNeedle && haystack.includes(cityNeedle)) score += 3;
    if (countryNeedle && haystack.includes(countryNeedle)) score += 2;

    return universitySources(university).map((source) => ({
      source,
      score: score + (source.is_official === false ? 0 : 1),
    }));
  });

  const seen = new Set<string>();
  const ranked = candidates
    .sort((a, b) => b.score - a.score)
    .map((item) => item.source)
    .filter((source) => {
      if (seen.has(source.url)) return false;
      seen.add(source.url);
      return true;
    });

  const relevant = candidates.some((item) => item.score > 1)
    ? ranked.filter((source) => {
        const text = `${source.university_name ?? ""} ${source.title}`.toLowerCase();
        return haystack.includes((source.university_name ?? "").toLowerCase()) || haystack.includes(text);
      })
    : [];

  return (relevant.length ? relevant : ranked).slice(0, 4);
}

function systemPrompt(context: string) {
  return `당신은 성균관대학교 학생을 위한 교환대학 정보 도우미입니다.

답변 원칙:
- 제공된 대학 데이터만 근거로 한국어로 답하세요.
- 데이터에 없는 내용은 추측하지 말고 "현재 등록된 자료로는 확인이 필요합니다"라고 말하세요.
- 지원 마감일, GPA, 어학 요건, 기숙사, 비용, 수강 제한은 구분해서 설명하세요.
- 여러 대학을 추천할 때는 이유를 짧게 비교하세요.
- 출처 URL은 등록된 데이터에 있는 링크만 사용하세요. 없는 링크를 만들지 마세요.
- API 키, 내부 환경변수, 서버 설정은 절대 공개하지 마세요.

등록된 대학 데이터:
${context}`;
}

export async function POST(request: Request) {
  if (isRateLimited(request)) {
    return NextResponse.json({ error: "질문이 너무 빠르게 반복되고 있습니다. 잠시 후 다시 시도해 주세요." }, { status: 429 });
  }

  const apiKey = process.env.UPSTAGE_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "챗봇 서버 설정이 아직 완료되지 않았습니다. UPSTAGE_API_KEY를 확인해 주세요." }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "올바른 요청 형식이 아닙니다." }, { status: 400 });
  }

  const rawMessages = (body as { messages?: unknown })?.messages;
  if (!Array.isArray(rawMessages)) {
    return NextResponse.json({ error: "대화 내용이 필요합니다." }, { status: 400 });
  }

  const messages = rawMessages.filter(isChatMessage).slice(-MAX_MESSAGES);
  if (!messages.length || messages.at(-1)?.role !== "user") {
    return NextResponse.json({ error: "질문을 입력해 주세요." }, { status: 400 });
  }

  try {
    const universities = await getUniversities();
    const context = JSON.stringify(universities.map(compactUniversity));
    const response = await fetch(UPSTAGE_CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.UPSTAGE_CHAT_MODEL || "solar-pro3",
        temperature: 0.2,
        max_tokens: 1200,
        messages: [
          {
            role: "system",
            content: systemPrompt(context),
          },
          ...messages,
        ],
      }),
      signal: AbortSignal.timeout(45_000),
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error("Upstage chat request failed", response.status, detail.slice(0, 500));
      return NextResponse.json({ error: "AI 답변을 생성하지 못했습니다. Upstage 키, 모델명, 사용량 한도를 확인해 주세요." }, { status: 502 });
    }

    const result = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const answer = result.choices?.[0]?.message?.content?.trim();
    if (!answer) {
      return NextResponse.json({ error: "AI가 빈 답변을 반환했습니다." }, { status: 502 });
    }

    const question = messages.at(-1)?.content ?? "";
    return NextResponse.json({
      answer,
      sources: collectSources(universities, question, answer),
    });
  } catch (error) {
    console.error("Chat route error", error);
    return NextResponse.json({ error: "챗봇 요청 처리 중 오류가 발생했습니다." }, { status: 500 });
  }
}
