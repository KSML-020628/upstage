import { fallbackUniversities } from "./fallback-data";
import type { ExchangeProgram, ProfileSection, University } from "./types";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const key =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  process.env.SUPABASE_ANON_KEY ??
  process.env.SUPABASE_KEY;

function supabaseRestBase(): string {
  const raw = (url ?? "").replace(/\/+$/, "");
  return raw.endsWith("/rest/v1") ? raw : `${raw}/rest/v1`;
}

type SamuelUniversityRow = {
  id: string;
  name: string;
  country: string | null;
  city: string | null;
  homepage_url: string | null;
  exchange_url: string | null;
};

type CanonicalFactRow = {
  university_id?: string;
  field_key: string;
  topic: string;
  value_json: unknown;
  value_text: string | null;
  evidence_url: string | null;
};

const knownCoordinates: Record<string, { latitude: number; longitude: number }> = {
  "ca foscari university in venice": { latitude: 45.434, longitude: 12.3267 },
  "city university of hong kong": { latitude: 22.3364, longitude: 114.1728 },
  "ichec brussels management school": { latitude: 50.8369, longitude: 4.4085 },
  "icn business school": { latitude: 48.6921, longitude: 6.1844 },
  "inalco": { latitude: 48.8276, longitude: 2.3766 },
  "jean moulin university lyon 3": { latitude: 45.7485, longitude: 4.8619 },
  "kiel university": { latitude: 54.3385, longitude: 10.1228 },
  "ku leuven": { latitude: 50.879, longitude: 4.711 },
  "lut university": { latitude: 61.0639, longitude: 28.0947 },
  "mci management center innsbruck": { latitude: 47.2682, longitude: 11.3923 },
  "national taiwan university": { latitude: 25.0173, longitude: 121.5398 },
  "osnabruck university of applied sciences": { latitude: 52.2843, longitude: 8.023 },
  "paris dauphine university": { latitude: 48.8705, longitude: 2.2734 },
  "rennes school of business": { latitude: 48.1272, longitude: -1.6927 },
  "singapore university of technology and design sutd": { latitude: 1.3414, longitude: 103.9638 },
  "toulouse business school": { latitude: 43.6078, longitude: 1.4339 },
  "universidad san francisco de quito": { latitude: -0.1967, longitude: -78.4353 },
  "university of bristol": { latitude: 51.4584, longitude: -2.603 },
  "university of copenhagen": { latitude: 55.6802, longitude: 12.5724 },
  "university of eastern finland": { latitude: 62.601, longitude: 29.7636 },
  "university of helsinki": { latitude: 60.1699, longitude: 24.9384 },
  "university of manitoba": { latitude: 49.8075, longitude: -97.1366 },
  "university of rostock": { latitude: 54.0872, longitude: 12.1342 },
  "university of sao paulo": { latitude: -23.5614, longitude: -46.7308 },
  "university of sheffield": { latitude: 53.3811, longitude: -1.488 },
  "university of southern denmark": { latitude: 55.368, longitude: 10.428 },
  "vorarlberg university of applied sciences": { latitude: 47.4075, longitude: 9.7445 },
};

function coordinateKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .toLowerCase();
}

function cleanText(value: unknown, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text || text.includes("???") || text.includes("\uFFFD")) return fallback;
  return text;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object") as Record<string, unknown>[] : [];
}

async function request<T>(path: string): Promise<T> {
  if (!url || !key) throw new Error("Supabase public environment is not configured");
  const response = await fetch(`${supabaseRestBase()}/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    next: { revalidate: 300 },
  });
  if (!response.ok) throw new Error(`Supabase request failed: ${response.status}`);
  return response.json() as Promise<T>;
}

async function requestAll<T>(path: string, pageSize = 1000): Promise<T[]> {
  const rows: T[] = [];
  let offset = 0;
  const separator = path.includes("?") ? "&" : "?";
  const basePath = path.replace(/([?&])limit=\d+(&?)/, (_match, prefix, suffix) => (suffix ? prefix : "")).replace(/[?&]$/, "");

  while (true) {
    const page = await request<T[]>(`${basePath}${separator}limit=${pageSize}&offset=${offset}`);
    rows.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }

  return rows;
}

function factMap(facts: CanonicalFactRow[]): Map<string, CanonicalFactRow> {
  const mapped = new Map<string, CanonicalFactRow>();
  for (const fact of facts) {
    if (!mapped.has(fact.field_key)) mapped.set(fact.field_key, fact);
  }
  return mapped;
}

function profileFromFacts(facts: CanonicalFactRow[]): Record<string, unknown> | undefined {
  const row = facts.find((fact) => fact.field_key === "ui_profile_json");
  return asRecord(row?.value_json);
}

function sourceLinks(profile: Record<string, unknown> | undefined, facts: Map<string, CanonicalFactRow>): Record<string, unknown>[] {
  const links = asArray(profile?.source_links);
  if (links.length) return links;
  return [...facts.values()]
    .filter((fact) => fact.evidence_url)
    .slice(0, 12)
    .map((fact) => ({
      title: fact.topic || fact.field_key,
      url: fact.evidence_url,
      is_official: !String(fact.evidence_url).includes("blog.naver.com"),
      source_type: fact.field_key,
    }));
}

function sectionsFromFacts(profile: Record<string, unknown> | undefined, facts: Map<string, CanonicalFactRow>): ProfileSection[] {
  const profileSections = asArray(profile?.sections).map((item) => ({
    section_number: cleanText(item.section_number, ""),
    section_title: cleanText(item.section_title, ""),
    summary: cleanText(item.summary, ""),
    source_note: cleanText(item.source_note, ""),
    evidence_url: cleanText(item.evidence_url, ""),
  })).filter((item) => item.section_number && item.summary);
  if (profileSections.length) return profileSections;

  return [...facts.entries()]
    .filter(([key]) => /^section_\d{2}_summary$/.test(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, fact]) => {
      const number = key.match(/section_(\d{2})_summary/)?.[1] ?? "";
      const json = asRecord(fact.value_json);
      return {
        section_number: number,
        section_title: cleanText(json?.section_title, fact.topic),
        summary: cleanText(fact.value_text, ""),
        source_note: cleanText(json?.source_note, ""),
        evidence_url: cleanText(fact.evidence_url, ""),
      };
    })
    .filter((item) => item.summary);
}

function exchangeProgram(row: SamuelUniversityRow, profile: Record<string, unknown> | undefined, facts: Map<string, CanonicalFactRow>): ExchangeProgram {
  const program = asRecord(profile?.program);
  const source_links = sourceLinks(profile, facts);
  return {
    id: `${row.id}-program`,
    university_id: row.id,
    academic_year: cleanText(program?.academic_year, "2026/27"),
    program_name: cleanText(program?.program_name, "Incoming Exchange"),
    exchange_type: cleanText(program?.exchange_type, "Exchange"),
    application_process: cleanText(program?.application_process, facts.get("section_07_summary")?.value_text ?? ""),
    course_registration_notes: cleanText(program?.course_registration_notes, facts.get("section_11_summary")?.value_text ?? ""),
    application_deadlines: asArray(profile?.application_deadlines).length ? asArray(profile?.application_deadlines) : asArray(facts.get("application_deadlines")?.value_json),
    language_requirements: asArray(profile?.language_requirements).length ? asArray(profile?.language_requirements) : asArray(facts.get("language_requirements")?.value_json),
    academic_periods: asArray(profile?.academic_periods).length ? asArray(profile?.academic_periods) : asArray(facts.get("academic_periods")?.value_json),
    housing_options: asArray(profile?.housing_options).length ? asArray(profile?.housing_options) : asArray(facts.get("housing_options")?.value_json),
    estimated_costs: asArray(profile?.estimated_costs).length ? asArray(profile?.estimated_costs) : asArray(facts.get("estimated_costs")?.value_json),
    required_documents: asArray(profile?.required_documents).length ? asArray(profile?.required_documents) : asArray(facts.get("required_documents")?.value_json),
    source_links,
  };
}

async function hydrateUniversity(row: SamuelUniversityRow, prefetchedFacts?: CanonicalFactRow[]): Promise<University> {
  const facts = prefetchedFacts ?? await request<CanonicalFactRow[]>(
    `canonical_facts?select=field_key,topic,value_json,value_text,evidence_url&university_id=eq.${encodeURIComponent(row.id)}`,
  );
  const mapped = factMap(facts);
  const profile = profileFromFacts(facts);
  const coordinate = knownCoordinates[coordinateKey(row.name)] ?? { latitude: 0, longitude: 0 };
  const fallback = fallbackUniversities.find((item) => item.university_name === row.name);
  const summary = cleanText(profile?.summary, cleanText(mapped.get("summary")?.value_text, fallback?.summary ?? "공식 자료와 후기 자료를 기반으로 정리한 교환학생 정보입니다."));
  const sections = sectionsFromFacts(profile, mapped);
  const unknowns = Array.isArray(profile?.unknowns) ? profile.unknowns.map((item) => String(item)).filter(Boolean) : [];
  const firstSourceUrl = cleanText(sourceLinks(profile, mapped)[0]?.url, "");

  return {
    id: row.id,
    university_name: row.name,
    country: row.country ?? "",
    city: row.city ?? "",
    latitude: fallback?.latitude ?? coordinate.latitude,
    longitude: fallback?.longitude ?? coordinate.longitude,
    image_url: fallback?.image_url,
    summary,
    official_website_url: row.homepage_url ?? undefined,
    incoming_exchange_url: row.exchange_url ?? (firstSourceUrl || undefined),
    exchange_programs: [exchangeProgram(row, profile, mapped)],
    profile_sections: sections,
    unknowns,
  };
}

export async function getUniversities(): Promise<University[]> {
  try {
    const rows = await requestAll<SamuelUniversityRow>("universities?select=id,name,country,city,homepage_url,exchange_url&order=name.asc");
    if (!rows.length) return [];
    const ids = rows.map((row) => row.id);
    const facts = await requestAll<CanonicalFactRow>(
      `canonical_facts?select=university_id,field_key,topic,value_json,value_text,evidence_url&field_key=eq.ui_profile_json&university_id=in.(${ids.map(encodeURIComponent).join(",")})`,
    );
    const factsByUniversity = new Map<string, CanonicalFactRow[]>();
    for (const fact of facts) {
      if (!fact.university_id) continue;
      const group = factsByUniversity.get(fact.university_id) ?? [];
      group.push(fact);
      factsByUniversity.set(fact.university_id, group);
    }
    return await Promise.all(rows.map((row) => hydrateUniversity(row, factsByUniversity.get(row.id) ?? [])));
  } catch (error) {
    console.error("Supabase university list fetch failed; using fallback data", error);
    if (process.env.NODE_ENV === "development") throw error;
    return fallbackUniversities;
  }
}

export async function getUniversity(id: string): Promise<University | undefined> {
  const fallback = fallbackUniversities.find((item) => item.id === id || item.university_name.toLowerCase().includes(id.toLowerCase()));
  try {
    const rows = await request<SamuelUniversityRow[]>(`universities?select=id,name,country,city,homepage_url,exchange_url&id=eq.${encodeURIComponent(id)}&limit=1`);
    if (!rows[0]) return fallback;
    return await hydrateUniversity(rows[0]);
  } catch (error) {
    console.error("Supabase university detail fetch failed; using fallback data", error);
    if (process.env.NODE_ENV === "development") throw error;
    return fallback;
  }
}
