import { Suspense } from "react";
import { getUniversities } from "../lib/supabase";
import { Header } from "../ui/Header";
import { UniversityResults } from "../ui/UniversityResults";

export default async function UniversitiesPage() {
  const universities = await getUniversities();
  return (
    <main>
      <Header />
      <Suspense fallback={<div className="page-loading">대학 정보를 불러오는 중...</div>}>
        <UniversityResults universities={universities} />
      </Suspense>
    </main>
  );
}
