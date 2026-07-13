import { Suspense } from "react";
import { getUniversities } from "../lib/supabase";
import { CompareView } from "../ui/CompareView";
import { Header } from "../ui/Header";

export default async function ComparePage() {
  const universities = await getUniversities();
  return (
    <main>
      <Header />
      <Suspense fallback={<div className="page-loading">비교 정보를 불러오는 중...</div>}>
        <CompareView universities={universities} />
      </Suspense>
    </main>
  );
}
