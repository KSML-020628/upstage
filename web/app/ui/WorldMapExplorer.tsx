"use client";

import Link from "next/link";
import { geoNaturalEarth1, geoPath } from "d3-geo";
import { feature } from "topojson-client";
import worldData from "world-atlas/countries-110m.json";
import { useEffect, useMemo, useState } from "react";
import { continentFor, continentOrder, type ContinentName } from "../lib/country-data";
import { fallbackUniversities } from "../lib/fallback-data";
import { getUniversities } from "../lib/supabase";
import type { University } from "../lib/types";
import { CountryDetailPanel } from "./CountryDetailPanel";

const WIDTH=1200, HEIGHT=650;
const world = feature(worldData as never, (worldData as unknown as { objects:{ countries:never } }).objects.countries) as GeoJSON.Feature;
const continentPoints:Record<ContinentName,{left:string;top:string}>={"북아메리카":{left:"20%",top:"34%"},"남아메리카":{left:"31%",top:"67%"},"유럽":{left:"51%",top:"31%"},"아프리카":{left:"53%",top:"55%"},"아시아":{left:"70%",top:"38%"},"오세아니아":{left:"82%",top:"70%"}};

export function WorldMapExplorer() {
  const [universities,setUniversities]=useState<University[]>(fallbackUniversities);
  const [continent,setContinent]=useState<ContinentName|null>(null);
  const [country,setCountry]=useState<string|null>(null);
  useEffect(()=>{getUniversities().then(setUniversities);},[]);
  const projection=useMemo(()=>geoNaturalEarth1().fitExtent([[20,20],[WIDTH-20,HEIGHT-20]],{type:"Sphere"}),[]);
  const mapPath=geoPath(projection)(world);
  const groups=useMemo(()=>{
    const result=new Map<string,University[]>();
    universities.forEach((university)=>result.set(university.country,[...(result.get(university.country)??[]),university]));
    return result;
  },[universities]);
  const countries=continent?[...groups.keys()].filter((item)=>continentFor(item)===continent).sort():[];
  const selectedUniversities=country?groups.get(country)??[]:[];

  return <main className="world-explorer">
    <header className="world-header"><Link className="world-brand" href="/"><span>S</span><b>SKKU Exchange Atlas</b></Link><div><Link href="/filter">조건으로 찾기</Link><Link href="/universities">전체 대학</Link></div></header>
    <section className="world-copy"><p>EXPLORE BEFORE YOU DECIDE</p><h1>어디로 갈지 몰라도 괜찮아요.<br/><em>대륙부터</em> 천천히 둘러보세요.</h1><span>대륙을 선택하면 현재 탐색할 수 있는 국가와 대학을 보여드려요.</span></section>
    <div className="flat-world" aria-label="대륙별 교환대학 세계지도">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="세계지도"><defs><linearGradient id="map-sea" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#dceeff"/><stop offset="1" stopColor="#9fc5e8"/></linearGradient></defs><rect width={WIDTH} height={HEIGHT} rx="36" fill="url(#map-sea)"/><path d={mapPath??undefined} className="world-land"/></svg>
      {continentOrder.map((name)=>{const count=[...groups.keys()].filter((item)=>continentFor(item)===name).length;return <button type="button" key={name} className={`continent-pin ${continent===name?"active":""}`} style={continentPoints[name]} onClick={()=>{setContinent(name);setCountry(null);}}><b>{name}</b><span>{count?`${count}개 국가`:"준비 중"}</span></button>;})}
    </div>
    {continent && !country && <aside className="continent-drawer"><button className="drawer-close" onClick={()=>setContinent(null)} aria-label="닫기">×</button><p>SELECT A COUNTRY</p><h2>{continent}</h2><span>현재 정보가 등록된 국가를 선택하세요.</span><div>{countries.length?countries.map((item)=><button type="button" key={item} onClick={()=>setCountry(item)}><b>{item}</b><span>{groups.get(item)?.length??0}개 대학</span><i>→</i></button>):<p className="empty-continent">등록된 국가를 준비하고 있어요.</p>}</div></aside>}
    {country && <CountryDetailPanel className="world-country-panel" country={country} universities={selectedUniversities} onBack={()=>setCountry(null)} onClose={()=>{setCountry(null);setContinent(null);}}/>}
    <p className="world-hint">지도 위 대륙 이름을 눌러 탐색을 시작하세요</p>
  </main>;
}
