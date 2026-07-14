import { fallbackUniversities } from "./fallback-data";
import type { ExchangeProgram, University } from "./types";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

const knownCoordinates: Record<string, { latitude: number; longitude: number }> = {
  "city university of hong kong": { latitude: 22.3364, longitude: 114.1728 },
  "ichec brussels management school": { latitude: 50.8369, longitude: 4.4085 },
  "icn business school": { latitude: 48.6921, longitude: 6.1844 },
  "universite jean moulin lyon 3": { latitude: 45.7485, longitude: 4.8619 },
  "university of bristol": { latitude: 51.4584, longitude: -2.603 },
  "university of edinburgh": { latitude: 55.9445, longitude: -3.1892 },
  "ku leuven": { latitude: 50.879, longitude: 4.711 },
  "lut university": { latitude: 61.0639, longitude: 28.0947 },
  "mci innsbruck": { latitude: 47.2682, longitude: 11.3923 },
  "national institute for oriental languages and civilizations inalco": { latitude: 48.8276, longitude: 2.3766 },
  "universidad san francisco de quito": { latitude: -0.1967, longitude: -78.4353 },
  "university of copenhagen": { latitude: 55.6802, longitude: 12.5724 },
  "university of eastern finland": { latitude: 62.601, longitude: 29.7636 },
  "university of helsinki": { latitude: 60.1699, longitude: 24.9384 },
  "university of manitoba": { latitude: 49.8075, longitude: -97.1366 },
  "university of sao paulo": { latitude: -23.5614, longitude: -46.7308 },
  "university of southern denmark": { latitude: 55.368, longitude: 10.428 },
  "vorarlberg university of applied sciences": { latitude: 47.4075, longitude: 9.7445 },
};

function coordinateKey(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase();
}

async function request<T>(path: string): Promise<T> {
  if (!url || !key) throw new Error("Supabase public environment is not configured");
  const response = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    next: { revalidate: 300 },
  });
  if (!response.ok) throw new Error(`Supabase request failed: ${response.status}`);
  return response.json() as Promise<T>;
}

async function optionalRequest<T>(path: string, fallback: T): Promise<T> {
  try {
    return await request<T>(path);
  } catch {
    return fallback;
  }
}

function withCoordinates(university: University): University {
  const known = fallbackUniversities.find((item) => item.university_name === university.university_name);
  const mapped = knownCoordinates[coordinateKey(university.university_name)];
  return {
    ...university,
    latitude: university.latitude ?? known?.latitude ?? mapped?.latitude ?? 0,
    longitude: university.longitude ?? known?.longitude ?? mapped?.longitude ?? 0,
    image_url: university.image_url ?? known?.image_url,
  };
}

const childTables = [
  "application_deadlines",
  "language_requirements",
  "academic_periods",
  "housing_options",
  "estimated_costs",
  "required_documents",
] as const;

async function hydrateUniversity(university: University): Promise<University> {
  const programs = await request<ExchangeProgram[]>(
    `exchange_programs?select=*&university_id=eq.${encodeURIComponent(university.id)}&order=academic_year.desc`,
  );
  const sources = await optionalRequest<Record<string, unknown>[]>(
    `source_links?select=*&university_id=eq.${encodeURIComponent(university.id)}`,
    [],
  );
  const hydratedPrograms = await Promise.all(programs.map(async (program) => {
    const childRows = await Promise.all(childTables.map((table) =>
      optionalRequest<Record<string, unknown>[]>(
        `${table}?select=*&exchange_program_id=eq.${encodeURIComponent(program.id)}`,
        [],
      ),
    ));
    return Object.assign(
      program,
      Object.fromEntries(childTables.map((table, index) => [table, childRows[index]])),
      { source_links: sources },
    );
  }));
  return { ...withCoordinates(university), exchange_programs: hydratedPrograms };
}

export async function getUniversities(): Promise<University[]> {
  try {
    const rows = await request<University[]>("universities?select=*&order=university_name");
    return await Promise.all(rows.map(hydrateUniversity));
  } catch {
    return fallbackUniversities;
  }
}

export async function getUniversity(id: string): Promise<University | undefined> {
  const fallback = fallbackUniversities.find((item) => item.id === id || item.university_name.toLowerCase().includes(id.toLowerCase()));
  try {
    const universities = await request<University[]>(`universities?select=*&id=eq.${encodeURIComponent(id)}&limit=1`);
    if (!universities[0]) return fallback;
    return await hydrateUniversity(universities[0]);
  } catch {
    return fallback;
  }
}
