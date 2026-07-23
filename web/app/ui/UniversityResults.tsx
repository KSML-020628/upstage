"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import type { University } from "../lib/types";
import { presentCost } from "../lib/display/present-fact";
import { UniversityCardMedia } from "./LocalMedia";

const continentGroups: Record<string, string[]> = {
  유럽: ["United Kingdom", "UK", "England", "Scotland", "Wales", "France", "Germany", "Spain", "Italy", "Netherlands", "Sweden", "Denmark", "Finland", "FINLAND", "Norway", "Switzerland", "Austria", "Belgium", "Ireland", "Turkey", "Türkiye"],
  북미: ["United States", "USA", "Canada", "Mexico"],
  남미: ["Brazil", "Ecuador", "Argentina", "Chile", "Colombia", "Peru"],
  아시아: ["Japan", "China", "Singapore", "Hong Kong", "Taiwan", "South Korea", "Thailand"],
  오세아니아: ["Australia", "New Zealand"],
  아프리카: ["South Africa", "Morocco", "Egypt", "Kenya"],
};

const majorOptions = ["인문·사회", "경영·경제", "공학", "자연과학", "예술", "의학·생명"];
const tests = ["IELTS Academic", "TOEFL iBT", "Cambridge C1 Advanced", "Cambridge C2 Proficiency", "PTE Academic", "Duolingo English Test", "Oxford ELLT"];
const semesterLabels: Record<string, string> = { all: "학기 무관", autumn: "가을학기", spring: "봄학기", "full-year": "1년" };
const majorKeywords: Record<string, string[]> = {
  "인문·사회": ["humanities", "social science", "history", "language", "politic", "인문", "사회"],
  "경영·경제": ["business", "management", "economics", "finance", "경영", "경제"],
  공학: ["engineering", "computer", "technology", "공학", "컴퓨터"],
  자연과학: ["science", "mathematics", "physics", "chemistry", "biology", "과학", "수학", "물리", "화학"],
  예술: ["art", "design", "music", "architecture", "예술", "디자인", "건축"],
  "의학·생명": ["medicine", "medical", "health", "life science", "pharmacy", "의학", "생명", "보건"],
};

const CURRENCY_TO_KRW: Record<string, number> = { EUR: 1600, GBP: 1900, DKK: 215, CHF: 1700, NOK: 140, SEK: 145, USD: 1380, CAD: 1010, SGD: 1070, HKD: 176, TWD: 43, BRL: 255, JPY: 9.3 };

type CostSummary = { krw: number; display: string; components: string[] };

function matchesTest(stored: unknown, selected: string) {
  const value = String(stored ?? "").toLowerCase();
  const aliases: Record<string, string[]> = {
    "IELTS Academic": ["ielts"],
    "TOEFL iBT": ["toefl"],
    "Cambridge C1 Advanced": ["cambridge", "cae", "c1 advanced"],
    "Cambridge C2 Proficiency": ["cambridge", "cpe", "c2 proficiency"],
    "PTE Academic": ["pte", "pearson"],
    "Duolingo English Test": ["duolingo"],
    "Oxford ELLT": ["oxford", "ellt"],
  };
  return (aliases[selected] ?? []).some((alias) => value.includes(alias));
}

function toNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const match = value.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function detectCurrency(row: Record<string, unknown>) {
  const explicit = String(row.currency ?? "").trim().toUpperCase();
  if (CURRENCY_TO_KRW[explicit]) return explicit;
  const text = Object.values(row).join(" ").toUpperCase();
  if (/€|EUR/.test(text)) return "EUR";
  if (/£|GBP/.test(text)) return "GBP";
  if (/DKK/.test(text)) return "DKK";
  if (/CHF/.test(text)) return "CHF";
  if (/NOK/.test(text)) return "NOK";
  if (/SEK/.test(text)) return "SEK";
  if (/SGD/.test(text)) return "SGD";
  if (/HKD/.test(text)) return "HKD";
  if (/TWD/.test(text)) return "TWD";
  if (/CAD/.test(text)) return "CAD";
  if (/BRL/.test(text)) return "BRL";
  if (/JPY|¥/.test(text)) return "JPY";
  if (/USD|\$/.test(text)) return "USD";
  return null;
}

function toSemester(amount: number, period: unknown) {
  const label = String(period ?? "").toLowerCase();
  if (/month|monthly|per month|월/.test(label)) return amount * 5;
  if (/week|weekly|per week|주/.test(label)) return amount * 20;
  if (/academic year|full year|annual|per year|year|연간|1년|until/.test(label)) return amount / 2;
  return amount;
}

function costCategory(row: Record<string, unknown>) {
  const text = Object.entries(row)
    .filter(([key]) => !/url|source|evidence|title/i.test(key))
    .map(([key, value]) => `${key} ${String(value ?? "")}`)
    .join(" ")
    .toLowerCase();
  if (/housing|accommodation|dorm|residence|hall|lodging|기숙|숙소|주거/.test(text)) return "housing";
  if (/living|meal|food|transport|book|insurance|incidentals|생활|식비|교통|보험/.test(text)) return "living";
  if (/tuition|registration|등록금|학비/.test(text)) return "tuition";
  return "other";
}

function amountFromRow(row: Record<string, unknown>) {
  for (const key of ["amount_max", "amount_min", "cost_max", "cost_min", "price_max", "price_min", "amount", "cost", "fee", "price"]) {
    const value = toNumber(row[key]);
    if (value !== null) return value;
  }
  const text = Object.values(row).join(" ");
  if (/waived|exempt|free|면제/.test(text) && /tuition|registration|등록금|학비/i.test(text)) return 0;
  return null;
}

function semesterCost(university: University): CostSummary | null {
  const program = university.exchange_programs?.[0];
  const rows = [...(program?.estimated_costs ?? []), ...(program?.housing_options ?? [])];
  const selected = new Map<string, { krw: number; label: string }>();
  for (const row of rows) {
    const amount = amountFromRow(row);
    if (amount === null) continue;
    const currency = detectCurrency(row) ?? (amount === 0 ? "KRW" : null);
    const rate = currency === "KRW" ? 1 : CURRENCY_TO_KRW[currency ?? ""];
    if (!currency || !rate) continue;
    const category = costCategory(row);
    if (category === "other") continue;
    if ((category === "housing" || category === "living") && amount <= 0) continue;
    const period = row.billing_period ?? row.reference_period ?? row.period;
    const semesterAmount = toSemester(amount, period);
    const krw = semesterAmount * rate;
    const presented = presentCost(row);
    const label = `${presented.label}: ${presented.value ?? "확인된 금액 없음"}`;
    const existing = selected.get(category);
    if (!existing || krw < existing.krw) selected.set(category, { krw, label });
  }
  const components = [...selected.values()];
  if (!components.length || (!selected.has("housing") && !selected.has("living"))) return null;
  const krw = components.reduce((sum, item) => sum + item.krw, 0);
  if (krw <= 0) return null;
  return { krw, display: `약 ${Math.round(krw / 10000).toLocaleString()}만원`, components: components.map((item) => item.label) };
}

function semesterMatches(university: University, semester: string) {
  if (semester === "all") return true;
  const program = university.exchange_programs?.[0];
  const rows = [...(program?.academic_periods ?? []), ...(program?.application_deadlines ?? [])];
  if (!rows.length) return true;
  const corpus = JSON.stringify(rows).toLowerCase();
  if (semester === "autumn") return /autumn|fall|semester 1|1학기|가을/.test(corpus);
  if (semester === "spring") return /spring|semester 2|2학기|봄/.test(corpus);
  return /full year|full academic year|academic year|1년|연간/.test(corpus);
}

function majorMatches(university: University, major: string) {
  if (!major) return true;
  const restrictions = university.exchange_programs?.[0]?.course_restrictions ?? [];
  const keywords = majorKeywords[major] ?? [];
  const relevant = restrictions.filter((row) => {
    const text = `${row.department_or_school ?? ""} ${row.restriction_text ?? ""}`.toLowerCase();
    return keywords.some((keyword) => text.includes(keyword));
  });
  if (!relevant.length) return true;
  return !relevant.some((row) => {
    const text = `${row.restriction_type ?? ""} ${row.restriction_text ?? ""}`.toLowerCase();
    return /closed|not available|not open|prohibited|지원 불가|수강 불가/.test(text);
  });
}

function gpaMatches(university: University, skkuGpa: number) {
  const corpus = JSON.stringify(university.exchange_programs?.[0] ?? {});
  const match = corpus.match(/(?:gpa|grade point average|평점|학점)[^\d]{0,40}(\d+(?:\.\d+)?)[^\d]{0,20}(?:out of|\/|on a|scale|만점)[^\d]{0,10}(4(?:\.0|\.3|\.5)?|5(?:\.0)?|100)/i)
    ?? corpus.match(/(\d+(?:\.\d+)?)\s*(?:\/|out of)\s*(4(?:\.0|\.3|\.5)?|5(?:\.0)?|100)[^\n]{0,60}(?:gpa|grade point average|평점|학점)/i);
  if (!match) return true;
  const required = Number(match[1]);
  const scale = Number(match[2]);
  if (!Number.isFinite(required) || !Number.isFinite(scale) || scale <= 0) return true;
  return (skkuGpa / 4.5) * scale >= required;
}

function normalizeSearchText(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

export function UniversityResults({ universities }: { universities: University[] }) {
  const params = useSearchParams();
  const [continents, setContinents] = useState((params.get("countries") ?? "").split(",").filter(Boolean));
  const [major, setMajor] = useState(params.get("major") ?? params.get("primaryMajor") ?? "");
  const [semester, setSemester] = useState(params.get("semester") ?? "all");
  const [languageTest, setLanguageTest] = useState(params.get("languageTest") ?? "");
  const [languageScore, setLanguageScore] = useState(Number(params.get("languageScore") ?? 0));
  const [gpa, setGpa] = useState(Number(params.get("gpa") ?? 3.5));
  const [searchQuery, setSearchQuery] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);

  const toggleContinent = (continent: string) => setContinents((current) => current.includes(continent) ? current.filter((item) => item !== continent) : [...current, continent]);
  const reset = () => {
    setContinents([]);
    setMajor("");
    setSemester("all");
    setLanguageTest("");
    setLanguageScore(0);
    setGpa(3.5);
    setSearchQuery("");
  };

  const filtered = useMemo(() => {
    const query = normalizeSearchText(searchQuery.trim());
    return universities.filter((item) => {
      const nameMatch = !query || normalizeSearchText(item.university_name).includes(query);
      const continentMatch = !continents.length || continents.some((group) => (continentGroups[group] ?? [group]).includes(item.country));
      const requirements = item.exchange_programs?.[0]?.language_requirements ?? [];
      const matching = languageTest ? requirements.filter((row) => matchesTest(row.test_type, languageTest)) : [];
      const languageMatch = !languageTest || (matching.length > 0 && matching.some((row) => {
        const required = toNumber(row.minimum_score ?? row.overall_score);
        return required !== null && languageScore >= required;
      }));
      return nameMatch && continentMatch && languageMatch && semesterMatches(item, semester) && majorMatches(item, major) && gpaMatches(item, gpa);
    });
  }, [universities, searchQuery, continents, major, semester, languageTest, languageScore, gpa]);

  const toggleCompare = (id: string) => setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : current.length < 3 ? [...current, id] : current);

  return (
    <>
      <section className="list-hero result-hero">
        <p className="eyebrow">PARTNER UNIVERSITIES</p>
        <h1>{params.toString() ? "내 조건에 맞는 대학" : "교환대학 목록"}</h1>
        <p><b>{filtered.length}개</b> 대학을 확인할 수 있어요. 이 페이지에서 조건을 바로 수정할 수 있습니다.</p>
      </section>

      <section className="active-conditions">
        <span>현재 조건</span>
        <b>{continents.length ? continents.join(" · ") : "전체 대륙"}</b>
        {major && <b>{major}</b>}
        {semester !== "all" && <b>{semesterLabels[semester]}</b>}
        {languageTest && <b>{languageTest} {languageScore}</b>}
        <b>GPA {gpa.toFixed(2)} / 4.5</b>
        <label className="university-search">
          <span className="sr-only">대학명 검색</span>
          <input type="search" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="대학명을 입력해 검색하세요" autoComplete="off" />
        </label>
        <button className="edit-filter" onClick={() => setFilterOpen(!filterOpen)}>{filterOpen ? "조건 닫기" : "조건 수정"}</button>
        <button className="reset-filter" onClick={reset}>전체 초기화</button>
      </section>

      {filterOpen && (
        <section className="inline-filter approved-filter">
          <div>
            <label>관심 대륙</label>
            <div className="multi-choice">
              {Object.keys(continentGroups).map((continent) => (
                <button key={continent} className={continents.includes(continent) ? "selected" : ""} onClick={() => toggleContinent(continent)}>{continent}</button>
              ))}
            </div>
          </div>
          <label>나의 전공
            <select value={major} onChange={(event) => setMajor(event.target.value)}>
              <option value="">전공 무관</option>
              {majorOptions.map((item) => <option key={item}>{item}</option>)}
            </select>
          </label>
          <label>파견 학기
            <select value={semester} onChange={(event) => setSemester(event.target.value)}>
              <option value="all">학기 무관</option>
              <option value="autumn">가을학기</option>
              <option value="spring">봄학기</option>
              <option value="full-year">1년</option>
            </select>
          </label>
          <label>어학시험
            <select value={languageTest} onChange={(event) => setLanguageTest(event.target.value)}>
              <option value="">시험 조건 없음</option>
              {tests.map((test) => <option key={test}>{test}</option>)}
            </select>
          </label>
          <label>보유 점수
            <input type="number" min="0" step="0.1" value={languageScore} disabled={!languageTest} onChange={(event) => setLanguageScore(Number(event.target.value))} />
          </label>
          <label>GPA (4.5 만점)
            <input type="number" min="0" max="4.5" step="0.01" value={gpa} onChange={(event) => setGpa(Number(event.target.value))} />
          </label>
        </section>
      )}

      <section className="university-grid">
        {filtered.map((item, index) => {
          const cost = semesterCost(item);
          return (
            <article className="university-card" key={item.id}>
              <UniversityCardMedia name={item.university_name} city={item.city} fallback={item.image_url} tone={index} />
              <div className="card-content">
                <div className="card-top">
                  <p>{item.country} · {item.city}</p>
                  <label className="compare-check"><input type="checkbox" checked={selected.includes(item.id)} onChange={() => toggleCompare(item.id)} /> 비교</label>
                </div>
                <h2>{item.university_name}</h2>
                <div className="chips">
                  <span>{item.exchange_programs?.[0]?.academic_year ?? "최신 학년도"}</span>
                  <span>{cost === null ? "비용 확인 중" : `한 학기 ${cost.display}`}</span>
                </div>
                <p className="summary">{item.summary}</p>
                <Link href={`/universities/${item.id}`}>상세 정보 보기 <b>→</b></Link>
              </div>
            </article>
          );
        })}
      </section>

      {!filtered.length && <section className="no-results"><h2>현재 조건에 맞는 대학이 없어요.</h2><p>조건을 수정하거나 초기화해 보세요.</p><button onClick={reset}>조건 초기화</button></section>}
      {selected.length > 0 && <div className="compare-bar"><div><b>{selected.length}개 대학 선택</b><span>최대 3개까지 비교할 수 있어요.</span></div><button onClick={() => setSelected([])}>선택 초기화</button><Link href={`/compare?ids=${selected.join(",")}`}>선택 대학 비교하기 →</Link></div>}
    </>
  );
}
