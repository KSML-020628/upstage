import { fallbackUniversities } from "./fallback-data";
import type { ExchangeProgram, University } from "./types";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

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
  return { ...university, latitude: university.latitude ?? known?.latitude ?? 0, longitude: university.longitude ?? known?.longitude ?? 0, image_url: university.image_url ?? known?.image_url };
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
