import type { University } from "../types";

export function cleanText(value: unknown, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text || text.includes("???") || text.includes("�")) return fallback;
  return text;
}

function repairMojibake(value: string): string {
  if (!/[ÃÂêëìíîïðñòóôõö÷øùúûüýþÿ]/.test(value)) return value;
  try {
    const bytes = Uint8Array.from([...value].map((char) => char.charCodeAt(0) & 0xff));
    const repaired = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    return repaired.includes("�") ? value : repaired;
  } catch {
    return value;
  }
}

export function normalizeSearchText(value: unknown): string {
  const text = typeof value === "string" ? repairMojibake(value) : cleanText(value);
  return cleanText(text)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, " ")
    .trim();
}

export function includesAny(text: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(text));
}

export function isValidHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function isClearlyNonOfficialUrl(value: string) {
  return /blog|naver|youtube|tistory|brunch|drive\.google|docs\.google|notion\.site|medium\.com/i.test(value);
}

export function rowText(row: Record<string, unknown>) {
  return Object.values(row)
    .filter((value) => value !== null && value !== undefined && value !== "")
    .map((value) => String(value))
    .join(" · ");
}

export function rowsText(rows: Record<string, unknown>[] | undefined) {
  return (rows ?? []).map(rowText).join("\n");
}

export function numericValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  if (!normalized) return undefined;
  const parsed = Number(normalized[0]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function rowAsText(row: Record<string, unknown>) {
  return Object.entries(row)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(" | ");
}

export function programOf(university: University) {
  return university.exchange_programs?.[0];
}

export const EUROPE_COUNTRIES = new Set(
  [
    "Austria",
    "Belgium",
    "Denmark",
    "Finland",
    "France",
    "Germany",
    "Italy",
    "Netherlands",
    "Norway",
    "Portugal",
    "Spain",
    "Sweden",
    "Switzerland",
    "United Kingdom",
    "UK",
    "England",
    "Scotland",
    "Ireland",
    "Czech Republic",
    "Poland",
    "Greece",
    "Hungary",
  ].map(normalizeSearchText),
);

export const ASIA_COUNTRIES = new Set([
  "china", "hong kong", "india", "indonesia", "japan", "malaysia", "mongolia", "philippines",
  "singapore", "south korea", "korea", "taiwan", "thailand", "turkey", "vietnam",
]);

export const AMERICAS_COUNTRIES = new Set([
  "argentina", "brazil", "canada", "chile", "colombia", "ecuador", "mexico", "peru",
  "united states", "usa", "united states of america",
]);

// No registered exchange partner is ever "South Korea" (this lists SKKU's
// outbound partners, not domestic universities), so matching "한국"/"Korea"
// here as an include/exclude country filter can only ever zero out results --
// e.g. "한국 학생이 지원하기 좋은 유럽 대학" would set countries: ["South Korea"]
// and, combined with requireEurope, guarantee 0 matches. "한국" in a question
// almost always means "compared to Korea" (the cost-of-living baseline) or
// "as a Korean student", never "a university located in Korea". Left out of
// this list entirely rather than filtered post hoc, so it can't leak into
// constraints.countries anywhere it's used.
export const COUNTRY_ALIASES: Array<{ country: string; patterns: RegExp[] }> = [
  { country: "France", patterns: [/프랑스/, /france|french/] },
  { country: "Germany", patterns: [/독일/, /germany|german/] },
  { country: "Austria", patterns: [/오스트리아/, /austria/] },
  { country: "Finland", patterns: [/핀란드/, /finland|finnish/] },
  { country: "Belgium", patterns: [/벨기에/, /belgium|belgian/] },
  { country: "Italy", patterns: [/이탈리아/, /italy|italian/] },
  { country: "United Kingdom", patterns: [/영국/, /united kingdom|\buk\b|britain|england/] },
  { country: "Denmark", patterns: [/덴마크/, /denmark|danish/] },
  { country: "Canada", patterns: [/캐나다/, /canada|canadian/] },
  { country: "Singapore", patterns: [/싱가포르/, /singapore/] },
  { country: "Hong Kong", patterns: [/홍콩/, /hong kong/] },
  { country: "Taiwan", patterns: [/대만|타이완/, /taiwan/] },
  { country: "Brazil", patterns: [/브라질/, /brazil/] },
  { country: "Ecuador", patterns: [/에콰도르/, /ecuador/] },
  { country: "Japan", patterns: [/일본/, /japan/] },
  { country: "Netherlands", patterns: [/네덜란드/, /netherlands|dutch/] },
  { country: "Sweden", patterns: [/스웨덴/, /sweden|swedish/] },
  { country: "Switzerland", patterns: [/스위스/, /switzerland|swiss/] },
  { country: "Norway", patterns: [/노르웨이/, /norway|norwegian/] },
  { country: "Portugal", patterns: [/포르투갈/, /portugal|portuguese/] },
  { country: "Spain", patterns: [/스페인/, /spain|spanish/] },
  { country: "Turkey", patterns: [/튀르키예|터키/, /turkey|turkiye|türkiye/] },
  { country: "Thailand", patterns: [/태국/, /thailand|thai/] },
  { country: "Indonesia", patterns: [/인도네시아/, /indonesia|indonesian/] },
  { country: "Vietnam", patterns: [/베트남/, /vietnam|vietnamese/] },
  { country: "United States", patterns: [/미국/, /united states|usa|u\.s\.a\.?/] },
  { country: "Peru", patterns: [/페루/, /peru|peruvian/] },
];

export function isEuropeanUniversity(university: University) {
  const country = normalizeSearchText(university.country);
  const city = normalizeSearchText(university.city);
  const name = normalizeSearchText(university.university_name);
  return (
    EUROPE_COUNTRIES.has(country) ||
    /united kingdom|\buk\b|england|scotland/.test(country) ||
    /paris|rennes|lyon|bristol|sheffield|venice|rostock|kiel|dornbirn|brussels|copenhagen|helsinki|joensuu|kuopio|toulouse|osnabruck/.test(`${city} ${name}`)
  );
}

export function isAsianUniversity(university: University) {
  return ASIA_COUNTRIES.has(normalizeSearchText(university.country));
}

export function isAmericasUniversity(university: University) {
  return AMERICAS_COUNTRIES.has(normalizeSearchText(university.country));
}

export function matchesCountry(university: University, countries: string[]) {
  if (!countries.length) return true;
  const country = normalizeSearchText(university.country);
  return countries.some((item) => country === normalizeSearchText(item));
}

function countryMentionIsExcluded(rawText: string, matchIndex: number, matchLength: number) {
  const before = rawText.slice(Math.max(0, matchIndex - 14), matchIndex);
  const after = rawText.slice(matchIndex + matchLength, Math.min(rawText.length, matchIndex + matchLength + 14));
  const exclusion = "(?:제외(?:하고)?|빼고|말고|아닌|except|exclude|without)";
  return new RegExp(`${exclusion}\\s*$`, "i").test(before)
    || new RegExp(`^\\s*(?:은|는|을|를|도|과|와|,)?\\s*${exclusion}`, "i").test(after);
}

export function detectCountries(question: string) {
  const rawText = question.normalize("NFKC").toLowerCase();
  return COUNTRY_ALIASES.filter(({ patterns }) => patterns.some((pattern) => {
    const match = rawText.match(pattern);
    return Boolean(match && !countryMentionIsExcluded(rawText, match.index ?? 0, match[0].length));
  })).map(({ country }) => country);
}

export function detectExcludedCountries(question: string) {
  const rawText = question.normalize("NFKC").toLowerCase();
  return COUNTRY_ALIASES.filter(({ patterns }) => patterns.some((pattern) => {
    const match = rawText.match(pattern);
    return Boolean(match && countryMentionIsExcluded(rawText, match.index ?? 0, match[0].length));
  })).map(({ country }) => country);
}
