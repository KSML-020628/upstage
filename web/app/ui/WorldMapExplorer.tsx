"use client";

import Link from "next/link";
import { geoNaturalEarth1, geoPath } from "d3-geo";
import { feature } from "topojson-client";
import worldData from "world-atlas/countries-110m.json";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  continentFor,
  continentOrder,
  countryDisplayName,
  countryProfile,
  type ContinentName,
} from "../lib/country-data";
import { fallbackUniversities } from "../lib/fallback-data";
import { getUniversities } from "../lib/supabase";
import type { University } from "../lib/types";
import { CountryDetailPanel } from "./CountryDetailPanel";
import { BrandMark } from "./LocalMedia";

const WIDTH = 1200;
const HEIGHT = 650;
const world = feature(
  worldData as never,
  (worldData as unknown as { objects: { countries: never } }).objects.countries,
) as never;

const continentCoordinates: Record<ContinentName, [number, number]> = {
  북아메리카: [-105, 45],
  남아메리카: [-60, -18],
  유럽: [15, 51],
  아프리카: [20, 4],
  아시아: [92, 42],
  오세아니아: [135, -25],
};

function uniqueCurrencies(universities: University[]): string[] {
  const priority = ["EUR", "GBP", "JPY", "SEK", "HKD", "SGD", "CAD", "TWD", "THB", "TRY", "IDR", "VND", "PEN", "USD", "DKK", "BRL"];
  const present = new Set(
    universities.map((university) => countryProfile(university.country).currency).filter(Boolean),
  );
  return priority.filter((currency) => present.has(currency)).slice(0, 8);
}

export function WorldMapExplorer() {
  const [universities, setUniversities] = useState<University[]>(fallbackUniversities);
  const [continent, setContinent] = useState<ContinentName | null>(null);
  const [country, setCountry] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  const [krwRates, setKrwRates] = useState<Record<string, number>>({});
  const zoomRef = useRef(1);
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);

  useEffect(() => {
    void getUniversities().then(setUniversities);
  }, []);

  const rateCurrencies = useMemo(() => uniqueCurrencies(universities), [universities]);

  useEffect(() => {
    if (!rateCurrencies.length) return;

    Promise.all(
      rateCurrencies.map(async (currency) => {
        const response = await fetch(`/api/exchange-rate?currency=${currency}`);
        if (!response.ok) throw new Error("rate");
        const data = (await response.json()) as { rate: number };
        return [currency, data.rate] as const;
      }),
    )
      .then((rows) => setKrwRates(Object.fromEntries(rows)))
      .catch(() => setKrwRates({}));
  }, [rateCurrencies]);

  const projection = useMemo(
    () => geoNaturalEarth1().fitExtent([[20, 20], [WIDTH - 20, HEIGHT - 20]], { type: "Sphere" }),
    [],
  );
  const mapPath = useMemo(() => geoPath(projection)(world), [projection]);

  const groups = useMemo(() => {
    const result = new Map<string, University[]>();
    universities.forEach((university) => {
      const country = countryDisplayName(university.country);
      result.set(country, [...(result.get(country) ?? []), university]);
    });
    return result;
  }, [universities]);

  const countries = continent
    ? [...groups.keys()]
        .filter((item) => continentFor(item) === continent)
        .sort((a, b) => countryDisplayName(a).localeCompare(countryDisplayName(b)))
    : [];
  const selectedUniversities = country ? groups.get(country) ?? [] : [];

  const continentPosition = (name: ContinentName) => {
    const point = projection(continentCoordinates[name]);
    return {
      left: `${((point?.[0] ?? 0) / WIDTH) * 100}%`,
      top: `${((point?.[1] ?? 0) / HEIGHT) * 100}%`,
    };
  };

  const panLimits = (value: number) => ({
    x: (typeof window === "undefined" ? 700 : window.innerWidth * 0.62) * (value - 1),
    y: (typeof window === "undefined" ? 400 : window.innerHeight * 0.55) * (value - 1),
  });

  const changeZoom = (next: number) => {
    const value = Math.min(2.5, Math.max(1, Math.round(next * 10) / 10));
    zoomRef.current = value;
    setZoom(value);
    if (value === 1) {
      setPan({ x: 0, y: 0 });
      return;
    }
    const limit = panLimits(value);
    setPan((current) => ({
      x: Math.max(-limit.x, Math.min(limit.x, current.x)),
      y: Math.max(-limit.y, Math.min(limit.y, current.y)),
    }));
  };

  const resetMap = () => {
    zoomRef.current = 1;
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const selectContinent = (name: ContinentName) => {
    const point = projection(continentCoordinates[name]);
    const rect = canvasRef.current?.getBoundingClientRect();
    const currentZoom = zoomRef.current;
    const width = (rect?.width ?? (typeof window === "undefined" ? WIDTH : window.innerWidth)) / currentZoom;
    const height = (rect?.height ?? (typeof window === "undefined" ? HEIGHT : window.innerHeight)) / currentZoom;
    const targetZoom = 1.8;
    const limit = panLimits(targetZoom);
    const x = -(((point?.[0] ?? WIDTH / 2) / WIDTH) - 0.5) * width * targetZoom;
    const y = -(((point?.[1] ?? HEIGHT / 2) / HEIGHT) - 0.5) * height * targetZoom;
    zoomRef.current = targetZoom;
    setZoom(targetZoom);
    setPan({
      x: Math.max(-limit.x, Math.min(limit.x, x)),
      y: Math.max(-limit.y, Math.min(limit.y, y)),
    });
    setContinent(name);
    setCountry(null);
  };

  return (
    <main className="world-explorer">
      <header className="world-header">
        <Link className="world-brand" href="/">
          <BrandMark />
          <b>SKKU Exchange Atlas</b>
        </Link>
        <div>
          <Link href="/filter">조건으로 찾기</Link>
          <Link href="/universities">전체 대학</Link>
        </div>
      </header>

      {!continent && (
        <section className="world-copy">
          <p>EXPLORE BEFORE YOU DECIDE</p>
          <h1>
            어디로 갈지 모르겠다면 <em>지도를</em> 먼저 둘러보세요.
          </h1>
          <div className="krw-rate-strip">
            <small>등록 대학 국가 통화 기준</small>
            {rateCurrencies.map((currency) => (
              <span key={currency}>
                <b>{currency}</b> {krwRates[currency] ? `${Math.round(krwRates[currency]).toLocaleString("ko-KR")}원` : "확인 중"}
              </span>
            ))}
          </div>
        </section>
      )}

      <div
        className={`flat-world ${panning ? "is-panning" : ""}`}
        aria-label="세계 교환대학 지도"
        onWheel={(event) => {
          event.preventDefault();
          changeZoom(zoomRef.current + (event.deltaY < 0 ? 0.2 : -0.2));
        }}
        onPointerDown={(event) => {
          if ((event.target as HTMLElement).closest("button")) return;
          dragRef.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
          setPanning(true);
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!dragRef.current) return;
          const limit = panLimits(zoomRef.current);
          setPan({
            x: Math.max(-limit.x, Math.min(limit.x, dragRef.current.panX + event.clientX - dragRef.current.x)),
            y: Math.max(-limit.y, Math.min(limit.y, dragRef.current.panY + event.clientY - dragRef.current.y)),
          });
        }}
        onPointerUp={(event) => {
          dragRef.current = null;
          setPanning(false);
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          dragRef.current = null;
          setPanning(false);
        }}
      >
        <div className="world-map-stage" style={{ transform: `translate(${pan.x}px,${pan.y}px) scale(${zoom})` }}>
          <div className="world-map-canvas" ref={canvasRef}>
            <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="세계 지도">
              <defs>
                <linearGradient id="map-sea" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stopColor="#dceeff" />
                  <stop offset="1" stopColor="#9fc5e8" />
                </linearGradient>
              </defs>
              <rect width={WIDTH} height={HEIGHT} fill="url(#map-sea)" />
              <path d={mapPath ?? undefined} className="world-land" />
            </svg>

            {continentOrder.map((name) => {
              const count = [...groups.keys()].filter((item) => continentFor(item) === name).length;
              return (
                <button
                  type="button"
                  key={name}
                  className={`continent-pin ${continent === name ? "active" : ""}`}
                  style={continentPosition(name)}
                  onClick={() => selectContinent(name)}
                >
                  <b>{name}</b>
                  <span>{count ? `${count}개 국가` : "준비 중"}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="world-map-controls" aria-label="세계 지도 확대 축소">
          <button type="button" onClick={() => changeZoom(zoomRef.current + 0.2)} disabled={zoom >= 2.5} aria-label="지도 확대">
            +
          </button>
          <button type="button" className="world-zoom-level" onClick={resetMap} aria-label="지도 배율과 위치 초기화">
            {Math.round(zoom * 100)}%
          </button>
          <button type="button" onClick={() => changeZoom(zoomRef.current - 0.2)} disabled={zoom <= 1} aria-label="지도 축소">
            -
          </button>
        </div>
      </div>

      {continent && !country && (
        <aside className="continent-drawer">
          <button
            className="drawer-close"
            onClick={() => {
              setContinent(null);
              resetMap();
            }}
            aria-label="닫기"
          >
            ×
          </button>
          <p>SELECT A COUNTRY</p>
          <h2>{continent}</h2>
          <span>현재 정보가 등록된 국가를 선택하세요.</span>
          <div>
            {countries.length ? (
              countries.map((item) => (
                <button type="button" key={item} onClick={() => setCountry(item)}>
                  <b>{countryDisplayName(item)}</b>
                  <span>{groups.get(item)?.length ?? 0}개 대학</span>
                  <i>→</i>
                </button>
              ))
            ) : (
              <p className="empty-continent">등록된 국가를 준비하고 있어요.</p>
            )}
          </div>
        </aside>
      )}

      {country && (
        <CountryDetailPanel
          className="world-country-panel"
          country={country}
          universities={selectedUniversities}
          onBack={() => setCountry(null)}
          onClose={() => {
            setCountry(null);
            setContinent(null);
            resetMap();
          }}
        />
      )}
    </main>
  );
}
