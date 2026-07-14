"use client";

import Link from "next/link";
import { geoNaturalEarth1, geoPath } from "d3-geo";
import { feature } from "topojson-client";
import worldData from "world-atlas/countries-110m.json";
import { useEffect, useMemo, useRef, useState } from "react";
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
  const [zoom,setZoom]=useState(1);
  const [pan,setPan]=useState({x:0,y:0});
  const zoomRef=useRef(1);
  const dragRef=useRef<{x:number;y:number;panX:number;panY:number}|null>(null);
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
  const changeZoom=(next:number)=>{
    const value=Math.min(2.5,Math.max(1,Math.round(next*10)/10));
    zoomRef.current=value;setZoom(value);
    if(value===1)setPan({x:0,y:0});
    else { const max=300*(value-1);setPan((current)=>({x:Math.max(-max,Math.min(max,current.x)),y:Math.max(-max*.65,Math.min(max*.65,current.y))})); }
  };
  const resetMap=()=>{zoomRef.current=1;setZoom(1);setPan({x:0,y:0});};

  return <main className="world-explorer">
    <header className="world-header"><Link className="world-brand" href="/"><span>S</span><b>SKKU Exchange Atlas</b></Link><div><Link href="/filter">조건으로 찾기</Link><Link href="/universities">전체 대학</Link></div></header>
    <section className="world-copy"><p>EXPLORE BEFORE YOU DECIDE</p><h1>어디로 갈지 몰라도 괜찮아요.<br/><em>대륙부터</em> 천천히 둘러보세요.</h1><span>대륙을 선택하면 현재 탐색할 수 있는 국가와 대학을 보여드려요.</span></section>
    <div className="flat-world" aria-label="대륙별 교환대학 세계 지도" onWheel={(event)=>{event.preventDefault();changeZoom(zoomRef.current+(event.deltaY<0?.2:-.2));}} onPointerDown={(event)=>{if((event.target as HTMLElement).closest("button"))return;dragRef.current={x:event.clientX,y:event.clientY,panX:pan.x,panY:pan.y};event.currentTarget.setPointerCapture(event.pointerId);}} onPointerMove={(event)=>{if(!dragRef.current)return;const max=300*(zoomRef.current-1);setPan({x:Math.max(-max,Math.min(max,dragRef.current.panX+event.clientX-dragRef.current.x)),y:Math.max(-max*.65,Math.min(max*.65,dragRef.current.panY+event.clientY-dragRef.current.y))});}} onPointerUp={(event)=>{dragRef.current=null;if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);}} onPointerCancel={()=>{dragRef.current=null;}}>
      <div className="world-map-canvas" style={{transform:`translate(${pan.x}px,${pan.y}px) scale(${zoom})`}}>
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="세계 지도"><defs><linearGradient id="map-sea" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#dceeff"/><stop offset="1" stopColor="#9fc5e8"/></linearGradient></defs><rect width={WIDTH} height={HEIGHT} rx="36" fill="url(#map-sea)"/><path d={mapPath??undefined} className="world-land"/></svg>
        {continentOrder.map((name)=>{const count=[...groups.keys()].filter((item)=>continentFor(item)===name).length;return <button type="button" key={name} className={`continent-pin ${continent===name?"active":""}`} style={continentPoints[name]} onClick={()=>{setContinent(name);setCountry(null);}}><b>{name}</b><span>{count?`${count}개 국가`:"준비 중"}</span></button>;})}
      </div>
      <div className="world-map-controls" aria-label="세계 지도 확대 축소">
        <button type="button" onClick={()=>changeZoom(zoomRef.current+.2)} disabled={zoom>=2.5} aria-label="지도 확대">+</button>
        <button type="button" className="world-zoom-level" onClick={resetMap} aria-label="지도 배율과 위치 초기화">{Math.round(zoom*100)}%</button>
        <button type="button" onClick={()=>changeZoom(zoomRef.current-.2)} disabled={zoom<=1} aria-label="지도 축소">−</button>
      </div>
    </div>
    {continent && !country && <aside className="continent-drawer"><button className="drawer-close" onClick={()=>setContinent(null)} aria-label="닫기">×</button><p>SELECT A COUNTRY</p><h2>{continent}</h2><span>현재 정보가 등록된 국가를 선택하세요.</span><div>{countries.length?countries.map((item)=><button type="button" key={item} onClick={()=>setCountry(item)}><b>{item}</b><span>{groups.get(item)?.length??0}개 대학</span><i>→</i></button>):<p className="empty-continent">등록된 국가를 준비하고 있어요.</p>}</div></aside>}
    {country && <CountryDetailPanel className="world-country-panel" country={country} universities={selectedUniversities} onBack={()=>setCountry(null)} onClose={()=>{setCountry(null);setContinent(null);}}/>}
    <p className="world-hint">휠로 확대·축소하고 드래그하여 이동한 뒤 대륙을 선택하세요</p>
  </main>;
}
