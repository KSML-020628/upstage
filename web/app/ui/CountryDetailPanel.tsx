"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  costIndexCountries,
  costIndexCountry,
  costIndexCountryLabel,
  costOfLivingIndex,
  NUMBEO_SNAPSHOT_DATE,
  OECD_FALLBACK_PERIOD,
} from "../lib/cost-of-living";
import { countryDisplayName, countryProfile } from "../lib/country-data";
import type { University } from "../lib/types";
import { CountryCover, UniversityLogo } from "./LocalMedia";

type Rate = { date: string; base: string; quote: string; rate: number };
type OecdCostData = { source: "OECD"; period: string; base: string; indices: Record<string, number>; fallback?: boolean };

export function CountryDetailPanel({
  country,
  universities,
  onClose,
  onBack,
  className = "",
}: {
  country: string;
  universities: University[];
  onClose?: () => void;
  onBack?: () => void;
  className?: string;
}) {
  const [tab, setTab] = useState<"life" | "universities">("life");
  const [rate, setRate] = useState<Rate | null>(null);
  const [rateError, setRateError] = useState(false);
  const [comparisonCountry, setComparisonCountry] = useState("South Korea");
  const [oecdData, setOecdData] = useState<OecdCostData | null>(null);
  const [oecdError, setOecdError] = useState(false);
  const profile = countryProfile(country);
  const displayName = countryDisplayName(country);
  const countryCostProfile = costIndexCountry(displayName);
  const comparisonCostProfile = costIndexCountry(comparisonCountry);
  const oecdIndices = oecdData?.indices ?? {};
  const countryCostIndex = costOfLivingIndex(displayName, oecdIndices);
  const comparisonCostIndex = costOfLivingIndex(comparisonCountry, oecdIndices);
  const comparisonLabel = costIndexCountryLabel(comparisonCountry);
  const differentSources = countryCostProfile?.source !== comparisonCostProfile?.source;
  const costDifferencePercent = countryCostIndex === undefined || comparisonCostIndex === undefined
    ? undefined
    : ((countryCostIndex / comparisonCostIndex) - 1) * 100;

  const sourceCaption = (source: "OECD" | "Numbeo" | undefined) => {
    if (source === "OECD" && oecdData?.fallback) return `${oecdData.period} 최근 확인값`;
    if (source === "Numbeo") return `${NUMBEO_SNAPSHOT_DATE} 확인`;
    if (oecdData) return `${oecdData.period} · 월별 자동 갱신`;
    if (oecdError) return `${OECD_FALLBACK_PERIOD} 최근 확인값`;
    return "최신 월간값 확인 중";
  };

  useEffect(() => {
    fetch("/api/cost-of-living")
      .then((response) => {
        if (!response.ok) throw new Error("OECD");
        return response.json() as Promise<OecdCostData>;
      })
      .then(setOecdData)
      .catch(() => setOecdError(true));
  }, []);

  useEffect(() => {
    setTab("life");
    setRate(null);
    setRateError(false);
    fetch(`/api/exchange-rate?currency=${profile.currency}`)
      .then((response) => {
        if (!response.ok) throw new Error("rate");
        return response.json() as Promise<Rate>;
      })
      .then(setRate)
      .catch(() => setRateError(true));
  }, [country, profile.currency]);

  return (
    <section className={`country-detail-panel ${className}`} aria-label={`${displayName} 국가 정보`}>
      <header className="country-detail-head">
        {onBack && (
          <button type="button" onClick={onBack} aria-label="국가 목록으로 돌아가기">
            ←
          </button>
        )}
        <div>
          <p>{profile.continent}</p>
          <h2>{displayName}</h2>
          <span>등록 대학 {universities.length}곳</span>
        </div>
        {onClose && (
          <button type="button" onClick={onClose} aria-label="닫기">
            ×
          </button>
        )}
      </header>

      <div className="country-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "life"}
          className={tab === "life" ? "active" : ""}
          onClick={() => setTab("life")}
        >
          생활 · 물가
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "universities"}
          className={tab === "universities" ? "active" : ""}
          onClick={() => setTab("universities")}
        >
          대학 목록 <b>{universities.length}</b>
        </button>
      </div>

      {tab === "life" ? (
        <div className="country-life">
          <CountryCover name={displayName} universityName={universities[0]?.university_name} className="country-cover" />
          <div className="exchange-card">
            <small>최근 기준 환율</small>
            {rate ? (
              <>
                <strong>
                  1 {profile.currency} = {Math.round(rate.rate).toLocaleString("ko-KR")}원
                </strong>
                <span>{rate.date} 기준 · 실제 환전 시 차이 발생</span>
              </>
            ) : rateError ? (
              <strong>환율 확인 일시 불가</strong>
            ) : (
              <strong>환율 불러오는 중</strong>
            )}
          </div>

          <div className="country-facts">
            <div>
              <small>통화</small>
              <b>
                {profile.currencyName} ({profile.currency})
              </b>
            </div>
            <div>
              <small>주요 언어</small>
              <b>{profile.languages}</b>
            </div>
            <div>
              <small>{displayName} 물가지수</small>
              <b className="cost-index-value">{countryCostIndex?.toFixed(1) ?? "확인 중"}</b>
              {costDifferencePercent !== undefined && (
                Math.abs(costDifferencePercent) < 0.05
                  ? <span className="cost-same">{comparisonLabel}과 동일</span>
                  : <span className={costDifferencePercent > 0 ? "cost-higher" : "cost-lower"}>
                      {comparisonLabel}보다 {Math.abs(costDifferencePercent).toFixed(1)}% {costDifferencePercent > 0 ? "높음" : "낮음"}
                    </span>
              )}
              <span className={`cost-source-badge ${countryCostProfile?.source.toLowerCase()}`}>{countryCostProfile?.source} · {sourceCaption(countryCostProfile?.source)}</span>
            </div>
            <div>
              <label className="cost-compare-select">
                <small>비교 국가</small>
                <select value={comparisonCountry} onChange={(event) => setComparisonCountry(event.target.value)} aria-label="물가지수 비교 국가">
                  <optgroup label="OECD 월별 자동 갱신">
                    {costIndexCountries.filter(({ source }) => source === "OECD").map(({ name, label }) => <option key={name} value={name}>{label}</option>)}
                  </optgroup>
                  <optgroup label="Numbeo 스냅샷">
                    {costIndexCountries.filter(({ source }) => source === "Numbeo").map(({ name, label }) => <option key={name} value={name}>{label}</option>)}
                  </optgroup>
                </select>
              </label>
              <b className="cost-index-value">{comparisonCostIndex?.toFixed(1) ?? "확인 중"}</b>
              <span className={`cost-source-badge ${comparisonCostProfile?.source.toLowerCase()}`}>{comparisonCostProfile?.source} · {sourceCaption(comparisonCostProfile?.source)}</span>
            </div>
          </div>

          {differentSources && <p className="cost-cross-source-warning">서로 다른 출처의 한국=100 환산값을 비교한 참고치입니다.</p>}

          <p className="cost-index-source">
            출처별 한국=100 환산 · <a href="https://data-explorer.oecd.org/vis?df%5Bag%5D=OECD.SDD.TPS&df%5Bid%5D=DSD_PPP_M%40DF_PP_CPL_M" target="_blank" rel="noreferrer">OECD 월별 CPL ↗</a> · <a href="https://www.numbeo.com/cost-of-living/rankings_by_country.jsp" target="_blank" rel="noreferrer">Numbeo 2026 ↗</a>
          </p>

          <article>
            <small>주거</small>
            <p>{profile.housing}</p>
          </article>
          <article>
            <small>교통</small>
            <p>{profile.transport}</p>
          </article>
          <article>
            <small>현지 생활</small>
            <p>{profile.life}</p>
          </article>
          <p className="country-note">생활 정보는 탐색을 위한 요약입니다. 출국 전에는 대사관, 정부, 대학 공식 안내를 다시 확인하세요.</p>
        </div>
      ) : (
        <div className="country-university-list">
          {universities.length ? (
            universities.map((university) => (
              <Link key={university.id} href={`/universities/${university.id}`}>
                <UniversityLogo name={university.university_name} className="country-university-logo" />
                <span>{university.city}</span>
                <b>{university.university_name}</b>
                <small>수업 · 지원 · 주거 정보 보기 →</small>
              </Link>
            ))
          ) : (
            <p>아직 등록된 대학이 없습니다.</p>
          )}
        </div>
      )}
    </section>
  );
}
