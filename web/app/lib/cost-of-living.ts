export type CostIndexSource = "OECD" | "Numbeo";

export type CostIndexCountry = {
  name: string;
  label: string;
  source: CostIndexSource;
  oecdCode?: string;
  fallbackIndex?: number;
  numbeoIndex?: number;
};

export const NUMBEO_SOUTH_KOREA_INDEX = 61.6;
export const NUMBEO_SNAPSHOT_DATE = "2026-07-21";
export const OECD_FALLBACK_PERIOD = "2026-05";
const OECD_COUNTRIES = "KOR+AUT+BEL+CAN+DNK+FIN+FRA+DEU+ITA+GBR+USA";

export type CostOfLivingSnapshot = {
  source: "OECD";
  period: string;
  base: "Korea=100";
  indices: Record<string, number>;
  fallback: boolean;
};

export const costIndexCountries: CostIndexCountry[] = [
  { name: "South Korea", label: "대한민국", source: "OECD", oecdCode: "KOR", fallbackIndex: 100 },
  { name: "Austria", label: "오스트리아", source: "OECD", oecdCode: "AUT", fallbackIndex: 146 },
  { name: "Belgium", label: "벨기에", source: "OECD", oecdCode: "BEL", fallbackIndex: 151 },
  { name: "Canada", label: "캐나다", source: "OECD", oecdCode: "CAN", fallbackIndex: 155 },
  { name: "Denmark", label: "덴마크", source: "OECD", oecdCode: "DNK", fallbackIndex: 178 },
  { name: "Finland", label: "핀란드", source: "OECD", oecdCode: "FIN", fallbackIndex: 154 },
  { name: "France", label: "프랑스", source: "OECD", oecdCode: "FRA", fallbackIndex: 141 },
  { name: "Germany", label: "독일", source: "OECD", oecdCode: "DEU", fallbackIndex: 140 },
  { name: "Italy", label: "이탈리아", source: "OECD", oecdCode: "ITA", fallbackIndex: 124 },
  { name: "United Kingdom", label: "영국", source: "OECD", oecdCode: "GBR", fallbackIndex: 160 },
  { name: "United States", label: "미국", source: "OECD", oecdCode: "USA", fallbackIndex: 174 },
  { name: "Brazil", label: "브라질", source: "Numbeo", numbeoIndex: 30.1 },
  { name: "Ecuador", label: "에콰도르", source: "Numbeo", numbeoIndex: 30.9 },
  { name: "Hong Kong", label: "홍콩", source: "Numbeo", numbeoIndex: 75.2 },
  { name: "Singapore", label: "싱가포르", source: "Numbeo", numbeoIndex: 87.7 },
  { name: "Taiwan", label: "대만", source: "Numbeo", numbeoIndex: 49.7 },
  { name: "Indonesia", label: "인도네시아", source: "Numbeo", numbeoIndex: 26.1 },
  { name: "Japan", label: "일본", source: "Numbeo", numbeoIndex: 47.5 },
  { name: "Netherlands", label: "네덜란드", source: "Numbeo", numbeoIndex: 73.4 },
  { name: "Peru", label: "페루", source: "Numbeo", numbeoIndex: 33.5 },
  { name: "Sweden", label: "스웨덴", source: "Numbeo", numbeoIndex: 68.0 },
  { name: "Thailand", label: "태국", source: "Numbeo", numbeoIndex: 38.0 },
  { name: "Turkey", label: "튀르키예", source: "Numbeo", numbeoIndex: 39.2 },
  { name: "Vietnam", label: "베트남", source: "Numbeo", numbeoIndex: 26.4 },
];

function normalizeCountry(country: string): string {
  const normalized = country.trim().toLowerCase();
  const aliases: Record<string, string> = {
    uk: "united kingdom",
    usa: "united states",
    "united states of america": "united states",
    "hong kong sar": "hong kong",
    "hong kong (china)": "hong kong",
    korea: "south korea",
    "republic of korea": "south korea",
    brasil: "brazil",
  };
  return aliases[normalized] ?? normalized;
}

export function costIndexCountry(country: string): CostIndexCountry | undefined {
  const target = normalizeCountry(country);
  return costIndexCountries.find(({ name }) => normalizeCountry(name) === target);
}

export function costIndexCountryLabel(country: string): string {
  return costIndexCountry(country)?.label ?? country;
}

export function costOfLivingIndex(country: string, oecdIndices: Record<string, number> = {}): number | undefined {
  const item = costIndexCountry(country);
  if (!item) return undefined;
  if (item.source === "OECD") return item.oecdCode ? (oecdIndices[item.oecdCode] ?? item.fallbackIndex) : item.fallbackIndex;
  if (item.numbeoIndex === undefined) return undefined;
  return (item.numbeoIndex / NUMBEO_SOUTH_KOREA_INDEX) * 100;
}

function fallbackSnapshot(): CostOfLivingSnapshot {
  return {
    source: "OECD",
    period: OECD_FALLBACK_PERIOD,
    base: "Korea=100",
    indices: Object.fromEntries(costIndexCountries
      .filter((country) => country.source === "OECD" && country.oecdCode && country.fallbackIndex !== undefined)
      .map((country) => [country.oecdCode as string, country.fallbackIndex as number])),
    fallback: true,
  };
}

export async function loadCostOfLivingSnapshot(): Promise<CostOfLivingSnapshot> {
  const currentYear = new Date().getUTCFullYear();
  const startPeriod = `${currentYear - 1}-01`;
  const url = `https://sdmx.oecd.org/public/rest/data/OECD.SDD.TPS,DSD_PPP_M@DF_PP_CPL_M,1.0/${OECD_COUNTRIES}.M.CPL.IX.KRW.KOR?startPeriod=${startPeriod}&dimensionAtObservation=AllDimensions`;
  try {
    const response = await fetch(url, { headers: { Accept: "text/csv" }, next: { revalidate: 86400 } });
    if (!response.ok) return fallbackSnapshot();
    const lines = (await response.text()).trim().split(/\r?\n/);
    const headers = lines.shift()?.split(",") ?? [];
    const rows = lines.map((line) => Object.fromEntries(headers.map((header, index) => [header, line.split(",")[index]])));
    const period = rows.map((row) => String(row.TIME_PERIOD ?? "")).sort().at(-1);
    if (!period) return fallbackSnapshot();
    const indices = Object.fromEntries(rows
      .filter((row) => row.TIME_PERIOD === period && row.REF_AREA && Number.isFinite(Number(row.OBS_VALUE)))
      .map((row) => [String(row.REF_AREA), Number(row.OBS_VALUE)]));
    return Object.keys(indices).length >= 11
      ? { source: "OECD", period, base: "Korea=100", indices, fallback: false }
      : fallbackSnapshot();
  } catch {
    return fallbackSnapshot();
  }
}
