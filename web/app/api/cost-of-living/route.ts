import { NextResponse } from "next/server";
import { OECD_FALLBACK_PERIOD, costIndexCountries } from "../../lib/cost-of-living";

const OECD_COUNTRIES = "KOR+AUT+BEL+CAN+DNK+FIN+FRA+DEU+ITA+GBR+USA";

type CsvRow = {
  REF_AREA?: string;
  TIME_PERIOD?: string;
  OBS_VALUE?: string;
};

function parseCsv(text: string): CsvRow[] {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines.shift()?.split(",") ?? [];
  return lines.map((line) => {
    const values = line.split(",");
    return Object.fromEntries(headers.map((header, index) => [header, values[index]])) as CsvRow;
  });
}

function fallbackResponse() {
  const indices = Object.fromEntries(
    costIndexCountries
      .filter((country) => country.source === "OECD" && country.oecdCode && country.fallbackIndex !== undefined)
      .map((country) => [country.oecdCode as string, country.fallbackIndex as number]),
  );

  return NextResponse.json(
    { source: "OECD", period: OECD_FALLBACK_PERIOD, base: "Korea=100", indices, fallback: true },
    { headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" } },
  );
}

export async function GET() {
  const currentYear = new Date().getUTCFullYear();
  const startPeriod = `${currentYear - 1}-01`;
  const url = `https://sdmx.oecd.org/public/rest/data/OECD.SDD.TPS,DSD_PPP_M@DF_PP_CPL_M,1.0/${OECD_COUNTRIES}.M.CPL.IX.KRW.KOR?startPeriod=${startPeriod}&dimensionAtObservation=AllDimensions`;

  try {
    const response = await fetch(url, {
      headers: { Accept: "text/csv" },
      next: { revalidate: 86400 },
    });
    if (!response.ok) return fallbackResponse();

    const rows = parseCsv(await response.text());
    const period = rows.map((row) => row.TIME_PERIOD ?? "").sort().at(-1);
    if (!period) return fallbackResponse();

    const indices = Object.fromEntries(
      rows
        .filter((row) => row.TIME_PERIOD === period && row.REF_AREA && Number.isFinite(Number(row.OBS_VALUE)))
        .map((row) => [row.REF_AREA as string, Number(row.OBS_VALUE)]),
    );
    if (Object.keys(indices).length < 11) return fallbackResponse();

    return NextResponse.json(
      { source: "OECD", period, base: "Korea=100", indices, fallback: false },
      { headers: { "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800" } },
    );
  } catch {
    return fallbackResponse();
  }
}
