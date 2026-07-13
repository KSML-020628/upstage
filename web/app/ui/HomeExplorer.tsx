"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { fallbackUniversities } from "../lib/fallback-data";
import { getUniversities } from "../lib/supabase";
import type { University } from "../lib/types";
import { Header } from "./Header";
import { InteractiveGlobe } from "./InteractiveGlobe";

const countryOptions = ["영국", "유럽", "북미", "아시아", "오세아니아"];
const majorOptions = ["인문·사회", "경영·경제", "공학", "자연과학", "예술", "의학·생명"];
const scoreOptions: Record<string, string[]> = {
  "IELTS Academic": ["5.5", "6.0", "6.5", "7.0", "7.5"],
  "TOEFL iBT": ["72", "80", "88", "92", "100"],
  "Cambridge CAE/CPE": ["169", "176", "185", "191"],
  "PTE Academic": ["51", "59", "62", "67", "76"],
  "Duolingo English Test": ["105", "115", "120", "130", "140"],
  "Oxford ELLT": ["6", "7", "8", "9"],
};

function toggle(current: string[], value: string) {
  return current.includes(value) ? current.filter((item) => item !== value) : [...current, value];
}

export function HomeExplorer() {
  const [universities, setUniversities] = useState(fallbackUniversities);
  const [countries, setCountries] = useState<string[]>([]);
  const [majors, setMajors] = useState<string[]>([]);
  const [semester, setSemester] = useState("all");
  const [languageTest, setLanguageTest] = useState("IELTS Academic");
  const [languageScore, setLanguageScore] = useState("6.5");
  const [gpa, setGpa] = useState("3.5");
  const [budget, setBudget] = useState("15000");
  const [housing, setHousing] = useState(false);
  const [priority, setPriority] = useState("academics");
  const [countryPopup, setCountryPopup] = useState<{ country: string; universities: University[] } | null>(null);
  useEffect(() => { getUniversities().then(setUniversities); }, []);

  const resultHref = useMemo(() => {
    const query = new URLSearchParams({ countries: countries.join(","), majors: majors.join(","), semester, languageTest, languageScore, gpa, budget, housing: String(housing), priority });
    return `/universities?${query.toString()}`;
  }, [countries, majors, semester, languageTest, languageScore, gpa, budget, housing, priority]);

  return <main className="home-shell"><Header/>
    <section className="hero-copy filter-hero"><div><p className="eyebrow">FIND YOUR EXCHANGE</p><h1>내 조건에 맞는<br/><em>교환대학</em>을 찾아보세요.</h1><p>희망 국가와 전공, 어학 성적, 예산을 함께 고려해<br/>지원 가능한 대학을 좁혀보세요.</p></div><div className="step-indicator"><b>01</b><span>조건 선택</span><i/><b>02</b><span>결과 확인</span><i/><b>03</b><span>대학 비교</span></div></section>
    <section className="explorer filter-explorer" aria-label="교환대학 조건 탐색">
      <div className="globe-stage"><InteractiveGlobe universities={universities} onCountryClick={setCountryPopup}/>{countryPopup && <div className="country-popup"><button className="popup-close" onClick={() => setCountryPopup(null)} aria-label="닫기">×</button><p>COUNTRY UNIVERSITIES</p><h2>{countryPopup.country}</h2><span>{countryPopup.universities.length}개 대학</span><div>{countryPopup.universities.map((item) => <Link key={item.id} href={`/universities/${item.id}`}><b>{item.university_name}</b><small>{item.city} · 상세 정보 보기 →</small></Link>)}</div></div>}</div>
      <aside className="finder-panel condition-panel">
        <div className="panel-title"><span>01</span><div><small>나의 교환학기 조건</small><h2>복수 조건을 선택할 수 있어요</h2></div></div>
        <fieldset className="field-label"><legend>관심 국가 <em>복수선택</em></legend><div className="multi-choice">{countryOptions.map((item) => <button type="button" key={item} className={countries.includes(item) ? "selected" : ""} onClick={() => setCountries(toggle(countries,item))}>{item}</button>)}</div></fieldset>
        <fieldset className="field-label"><legend>관심 전공 <em>복수선택</em></legend><div className="multi-choice">{majorOptions.map((item) => <button type="button" key={item} className={majors.includes(item) ? "selected" : ""} onClick={() => setMajors(toggle(majors,item))}>{item}</button>)}</div></fieldset>
        <div className="field-row"><label className="field-label">보유 어학시험<select value={languageTest} onChange={(event) => { setLanguageTest(event.target.value); setLanguageScore(scoreOptions[event.target.value][0]); }}>{Object.keys(scoreOptions).map((test) => <option key={test}>{test}</option>)}</select></label><label className="field-label">보유 점수<select value={languageScore} onChange={(event) => setLanguageScore(event.target.value)}>{scoreOptions[languageTest].map((score) => <option key={score}>{score}</option>)}</select></label></div>
        <div className="field-row"><label className="field-label">파견 학기<select value={semester} onChange={(event) => setSemester(event.target.value)}><option value="all">학기 무관</option><option value="autumn">가을학기</option><option value="spring">봄학기</option><option value="full-year">1년</option></select></label><label className="field-label">GPA (4.5 기준)<select value={gpa} onChange={(event) => setGpa(event.target.value)}><option>3.0</option><option>3.3</option><option>3.5</option><option>3.8</option><option>4.0</option><option>4.3</option></select></label></div>
        <label className="field-label range-label"><span>한 학기 예상 비용 상한 <b>£{Number(budget).toLocaleString()}</b></span><input type="range" min="3000" max="15000" step="500" value={budget} onChange={(event) => setBudget(event.target.value)}/><small>약 5개월 체류 기준 · 확인된 주거·생활비를 환산</small></label>
        <div className="field-label">가장 중요한 조건<div className="choice-row"><button className={priority === "academics" ? "selected" : ""} onClick={() => setPriority("academics")}>수업 선택</button><button className={priority === "cost" ? "selected" : ""} onClick={() => setPriority("cost")}>비용</button><button className={priority === "life" ? "selected" : ""} onClick={() => setPriority("life")}>생활 환경</button></div></div>
        <label className="toggle-row"><input type="checkbox" checked={housing} onChange={(event) => setHousing(event.target.checked)}/><span>기숙사 정보가 확인된 대학만</span></label>
        <Link className="result-button" href={resultHref}>내 조건으로 대학 찾기 <b>→</b></Link>
      </aside>
    </section>
  </main>;
}
