"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { fallbackUniversities } from "../lib/fallback-data";
import { getUniversities } from "../lib/supabase";
import type { University } from "../lib/types";
import { CountryDetailPanel } from "./CountryDetailPanel";
import { Header } from "./Header";
import { InteractiveGlobe } from "./InteractiveGlobe";

const continentOptions = ["유럽", "북미", "남미", "아시아", "오세아니아", "아프리카"];
const majorOptions = ["인문·사회", "경영·경제", "공학", "자연과학", "예술", "의학·생명"];

type ScoreConfig = {
  label: string;
  min: number;
  max: number;
  step: number;
  initial: string;
  hint: string;
};

const scoreConfigs: Record<string, ScoreConfig> = {
  "IELTS Academic": { label: "IELTS Academic", min: 0, max: 9, step: 0.5, initial: "6.5", hint: "0-9점, 0.5점 단위" },
  "TOEFL iBT": { label: "TOEFL iBT", min: 0, max: 120, step: 1, initial: "80", hint: "0-120점, 정수 입력" },
  "Cambridge C1 Advanced": { label: "Cambridge C1 Advanced", min: 142, max: 210, step: 1, initial: "180", hint: "142-210점, 정수 입력" },
  "Cambridge C2 Proficiency": { label: "Cambridge C2 Proficiency", min: 162, max: 230, step: 1, initial: "200", hint: "162-230점, 정수 입력" },
  "PTE Academic": { label: "PTE Academic", min: 10, max: 90, step: 1, initial: "55", hint: "10-90점, 정수 입력" },
  "Duolingo English Test": { label: "Duolingo English Test", min: 10, max: 160, step: 5, initial: "115", hint: "10-160점, 5점 단위" },
  "Oxford ELLT": { label: "Oxford ELLT", min: 0, max: 12, step: 1, initial: "6", hint: "0-12레벨, 정수 입력" },
};

function toggle(current: string[], value: string) {
  return current.includes(value) ? current.filter((item) => item !== value) : [...current, value];
}

function validSteppedNumber(raw: string, min: number, max: number, step: number) {
  if (!raw.trim()) return false;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) return false;
  const steps = (value - min) / step;
  return Math.abs(steps - Math.round(steps)) < 1e-8;
}

export function HomeExplorer() {
  const [universities, setUniversities] = useState(fallbackUniversities);
  const [continents, setContinents] = useState<string[]>([]);
  const [major, setMajor] = useState("");
  const [semester, setSemester] = useState("all");
  const [languageTest, setLanguageTest] = useState("IELTS Academic");
  const [languageScore, setLanguageScore] = useState(scoreConfigs["IELTS Academic"].initial);
  const [gpa, setGpa] = useState("3.5");
  const [countryPopup, setCountryPopup] = useState<{ country: string; universities: University[] } | null>(null);

  useEffect(() => {
    getUniversities().then(setUniversities);
  }, []);

  const scoreConfig = scoreConfigs[languageTest];
  const languageScoreInvalid = !validSteppedNumber(languageScore, scoreConfig.min, scoreConfig.max, scoreConfig.step);
  const gpaInvalid = !validSteppedNumber(gpa, 0, 4.5, 0.01);
  const formInvalid = languageScoreInvalid || gpaInvalid;

  const resultHref = useMemo(() => {
    const query = new URLSearchParams();
    if (continents.length) query.set("countries", continents.join(","));
    if (major) query.set("major", major);
    if (semester !== "all") query.set("semester", semester);
    query.set("languageTest", languageTest);
    if (!languageScoreInvalid) query.set("languageScore", languageScore);
    if (!gpaInvalid) query.set("gpa", gpa);
    return `/universities?${query.toString()}`;
  }, [continents, major, semester, languageTest, languageScore, languageScoreInvalid, gpa, gpaInvalid]);

  return (
    <main className="home-shell">
      <Header />
      <section className="hero-copy filter-hero">
        <div>
          <p className="eyebrow">FIND YOUR EXCHANGE</p>
          <h1>
            내 조건에 맞는
            <br />
            <em>교환대학</em>을 찾아보세요
          </h1>
          <p>
            관심 대륙, 전공, 파견 학기와 현재 성적을 바탕으로
            <br />
            확인할 대학을 빠르게 좁혀보세요.
          </p>
        </div>
        <div className="step-indicator">
          <b>01</b><span>조건 선택</span><i />
          <b>02</b><span>결과 확인</span><i />
          <b>03</b><span>대학 비교</span>
        </div>
      </section>

      <section className="explorer filter-explorer" aria-label="교환대학 조건 탐색">
        <div className="globe-stage">
          <InteractiveGlobe universities={universities} onCountryClick={setCountryPopup} />
          {countryPopup && (
            <CountryDetailPanel
              className="globe-country-panel"
              country={countryPopup.country}
              universities={countryPopup.universities}
              onClose={() => setCountryPopup(null)}
            />
          )}
        </div>

        <aside className="finder-panel condition-panel">
          <div className="panel-title">
            <span>01</span>
            <div>
              <small>나의 교환학기 조건</small>
              <h2>확정된 조건만 입력해 주세요</h2>
            </div>
          </div>

          <fieldset className="field-label">
            <legend>관심 대륙 <em>복수 선택</em></legend>
            <div className="multi-choice">
              {continentOptions.map((item) => (
                <button
                  type="button"
                  key={item}
                  className={continents.includes(item) ? "selected" : ""}
                  onClick={() => setContinents(toggle(continents, item))}
                >
                  {item}
                </button>
              ))}
            </div>
          </fieldset>

          <label className="field-label">
            나의 전공
            <select value={major} onChange={(event) => setMajor(event.target.value)}>
              <option value="">전공 무관</option>
              {majorOptions.map((item) => <option key={item}>{item}</option>)}
            </select>
          </label>

          <div className="field-row">
            <label className="field-label">
              보유 어학시험
              <select
                value={languageTest}
                onChange={(event) => {
                  const next = event.target.value;
                  setLanguageTest(next);
                  setLanguageScore(scoreConfigs[next].initial);
                }}
              >
                {Object.entries(scoreConfigs).map(([value, config]) => (
                  <option value={value} key={value}>{config.label}</option>
                ))}
              </select>
            </label>
            <label className="field-label">
              보유 점수
              <input
                className={languageScoreInvalid ? "invalid-input" : ""}
                type="number"
                inputMode="decimal"
                min={scoreConfig.min}
                max={scoreConfig.max}
                step={scoreConfig.step}
                value={languageScore}
                aria-invalid={languageScoreInvalid}
                aria-describedby="language-score-help"
                onChange={(event) => setLanguageScore(event.target.value)}
              />
              <small id="language-score-help" className={languageScoreInvalid ? "input-error" : "input-hint"}>
                {languageScoreInvalid ? `${scoreConfig.hint}로 입력해 주세요.` : scoreConfig.hint}
              </small>
            </label>
          </div>

          <div className="field-row">
            <label className="field-label">
              파견 학기
              <select value={semester} onChange={(event) => setSemester(event.target.value)}>
                <option value="all">학기 무관</option>
                <option value="autumn">가을학기</option>
                <option value="spring">봄학기</option>
                <option value="full-year">1년</option>
              </select>
            </label>
            <label className="field-label">
              GPA (4.5 만점)
              <input
                className={gpaInvalid ? "invalid-input" : ""}
                type="number"
                inputMode="decimal"
                min="0"
                max="4.5"
                step="0.01"
                value={gpa}
                aria-invalid={gpaInvalid}
                aria-describedby="gpa-help"
                onChange={(event) => setGpa(event.target.value)}
              />
              <small id="gpa-help" className={gpaInvalid ? "input-error" : "input-hint"}>
                {gpaInvalid ? "0부터 4.5 사이의 GPA를 입력해 주세요." : "성균관대 4.5 만점, 소수점 입력 가능"}
              </small>
            </label>
          </div>

          <Link
            className={`result-button ${formInvalid ? "disabled" : ""}`}
            aria-disabled={formInvalid}
            tabIndex={formInvalid ? -1 : undefined}
            onClick={(event) => { if (formInvalid) event.preventDefault(); }}
            href={resultHref}
          >
            내 조건으로 대학 찾기 <b>→</b>
          </Link>
        </aside>
      </section>
    </main>
  );
}
