import { getUniversities } from "../lib/supabase";
import { CompareView } from "../ui/CompareView";
import { Header } from "../ui/Header";

export default async function ComparePage() {
  const universities = await getUniversities();
  return <main><Header/><CompareView universities={universities}/></main>;
}
