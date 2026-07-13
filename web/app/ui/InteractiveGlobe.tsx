"use client";

import { geoDistance, geoGraticule10, geoOrthographic, geoPath } from "d3-geo";
import { feature } from "topojson-client";
import worldData from "world-atlas/countries-110m.json";
import { useEffect, useMemo, useRef, useState } from "react";
import type { University } from "../lib/types";

type CountryGroup = { country: string; latitude: number; longitude: number; universities: University[] };
const SIZE = 800;
const land = feature(worldData as never, (worldData as unknown as { objects:{ countries:never } }).objects.countries) as GeoJSON.Feature;

export function InteractiveGlobe({ universities, onCountryClick }: { universities: University[]; onCountryClick:(group:CountryGroup)=>void }) {
  const rotationRef = useRef(4);
  const dragRef = useRef<{ x:number; rotation:number } | null>(null);
  const [rotation, setRotation] = useState(4);
  const [dragging, setDragging] = useState(false);
  const groups = useMemo<CountryGroup[]>(() => {
    const grouped = new Map<string,University[]>();
    universities.forEach((item) => grouped.set(item.country,[...(grouped.get(item.country) ?? []),item]));
    return [...grouped.entries()].map(([country,items]) => ({ country, universities:items, latitude:items.reduce((sum,item)=>sum+item.latitude,0)/items.length, longitude:items.reduce((sum,item)=>sum+item.longitude,0)/items.length }));
  },[universities]);

  useEffect(() => {
    let frame=0,last=0;
    const animate=(time:number) => {
      if (!dragRef.current && time-last>32) { rotationRef.current=(rotationRef.current+.16)%360; setRotation(rotationRef.current); last=time; }
      frame=requestAnimationFrame(animate);
    };
    frame=requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  },[]);

  const projection=geoOrthographic().translate([SIZE/2,SIZE/2]).scale(330).rotate([rotation,-10,0]).clipAngle(90).precision(.35);
  const path=geoPath(projection);
  const spherePath=path({type:"Sphere"});
  const landPath=path(land);
  const graticulePath=path(geoGraticule10());
  const center:[number,number]=[-rotation,10];

  return <div className={`interactive-globe ${dragging?"is-dragging":""}`} onPointerDown={(event)=>{if((event.target as HTMLElement).closest("button"))return;dragRef.current={x:event.clientX,rotation:rotationRef.current};setDragging(true);event.currentTarget.setPointerCapture(event.pointerId);}} onPointerMove={(event)=>{if(!dragRef.current)return;rotationRef.current=(dragRef.current.rotation+(event.clientX-dragRef.current.x)/2.2)%360;setRotation(rotationRef.current);}} onPointerUp={(event)=>{dragRef.current=null;setDragging(false);if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);}} onPointerCancel={()=>{dragRef.current=null;setDragging(false);}}>
    <svg className="geo-globe" viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label="드래그하여 회전하는 교환대학 세계 지도">
      <defs><radialGradient id="ocean" cx="34%" cy="28%"><stop offset="0%" stopColor="#eaf5ff"/><stop offset="65%" stopColor="#93c4ef"/><stop offset="100%" stopColor="#568bc9"/></radialGradient><filter id="land-shadow"><feDropShadow dx="0" dy="4" stdDeviation="4" floodColor="#194f45" floodOpacity=".22"/></filter></defs>
      <path className="globe-ocean" d={spherePath ?? undefined} fill="url(#ocean)"/>
      <path className="globe-graticule" d={graticulePath ?? undefined}/>
      <path className="globe-land" d={landPath ?? undefined} filter="url(#land-shadow)"/>
      <path className="globe-rim" d={spherePath ?? undefined}/>
    </svg>
    {groups.map((group) => { const point=projection([group.longitude,group.latitude]); const visible=point && geoDistance([group.longitude,group.latitude],center)<Math.PI/2; return point && <button className="country-pin" key={group.country} onClick={(event)=>{event.stopPropagation();onCountryClick(group);}} style={{left:`${point[0]/SIZE*100}%`,top:`${point[1]/SIZE*100}%`,opacity:visible?1:0,pointerEvents:visible?"auto":"none"}}><span>{group.universities.length}</span><b>{group.country}</b></button>; })}
    <p className="globe-help">드래그하여 회전 · 국가 핀을 눌러 대학 보기</p>
  </div>;
}
