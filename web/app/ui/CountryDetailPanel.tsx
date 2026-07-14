"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { countryProfile } from "../lib/country-data";
import type { University } from "../lib/types";

type Rate = { date:string; base:string; quote:string; rate:number };

export function CountryDetailPanel({ country, universities, onClose, onBack, className="" }: { country:string; universities:University[]; onClose?:()=>void; onBack?:()=>void; className?:string }) {
  const [tab, setTab] = useState<"life"|"universities">("life");
  const [rate, setRate] = useState<Rate|null>(null);
  const [rateError, setRateError] = useState(false);
  const profile = countryProfile(country);

  useEffect(() => {
    setTab("life"); setRate(null); setRateError(false);
    fetch(`/api/exchange-rate?currency=${profile.currency}`).then((response) => {
      if (!response.ok) throw new Error("rate");
      return response.json() as Promise<Rate>;
    }).then(setRate).catch(() => setRateError(true));
  }, [country, profile.currency]);

  return <section className={`country-detail-panel ${className}`} aria-label={`${country} 국가 정보`}>
    <header className="country-detail-head">
      {onBack && <button type="button" onClick={onBack} aria-label="국가 목록으로 돌아가기">←</button>}
      <div><p>{profile.continent}</p><h2>{country}</h2><span>등록 대학 {universities.length}곳</span></div>
      {onClose && <button type="button" onClick={onClose} aria-label="닫기">×</button>}
    </header>
    <div className="country-tabs" role="tablist">
      <button type="button" role="tab" aria-selected={tab==="life"} className={tab==="life"?"active":""} onClick={()=>setTab("life")}>생활 · 물가</button>
      <button type="button" role="tab" aria-selected={tab==="universities"} className={tab==="universities"?"active":""} onClick={()=>setTab("universities")}>대학 목록 <b>{universities.length}</b></button>
    </div>
    {tab === "life" ? <div className="country-life">
      <div className="exchange-card"><small>최신 기준 환율</small>{rate ? <><strong>1 {profile.currency} = {Math.round(rate.rate).toLocaleString("ko-KR")}원</strong><span>{rate.date} 기준 · 실제 환전 시 차이 발생</span></> : rateError ? <strong>환율 확인 일시 불가</strong> : <strong>환율 불러오는 중…</strong>}</div>
      <div className="country-facts"><div><small>통화</small><b>{profile.currencyName} ({profile.currency})</b></div><div><small>주요 언어</small><b>{profile.languages}</b></div><div><small>생활비 수준</small><b>{profile.costLevel}</b></div><div><small>한 학기 예산 특징</small><b>{profile.semesterBudget}</b></div></div>
      <article><small>주거</small><p>{profile.housing}</p></article><article><small>교통</small><p>{profile.transport}</p></article><article><small>현지 생활</small><p>{profile.life}</p></article>
      <p className="country-note">생활 정보는 탐색을 위한 요약이며, 출국 전 대학·정부 공식 안내를 확인하세요.</p>
    </div> : <div className="country-university-list">
      {universities.length ? universities.map((university) => <Link key={university.id} href={`/universities/${university.id}`}><span>{university.city}</span><b>{university.university_name}</b><small>수업·지원·주거 정보 보기 →</small></Link>) : <p>아직 등록된 대학이 없습니다.</p>}
    </div>}
  </section>;
}
