import { getUniversities } from "../lib/supabase";
import { Header } from "../ui/Header";
import { UniversityResults } from "../ui/UniversityResults";

export default async function UniversitiesPage() {
  const universities = await getUniversities();
  return <main><Header/><UniversityResults universities={universities}/></main>;
}
