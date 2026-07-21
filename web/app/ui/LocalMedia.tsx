"use client";

/* eslint-disable @next/next/no-img-element */
import { useState, type ReactNode } from "react";
import { countryCoverImage, skkuLogoImage, universityCoverImage, universityLogoImage } from "../lib/media";

type ManagedImageProps = {
  src: string;
  alt: string;
  className?: string;
  onLoad?: () => void;
  fallback?: ReactNode;
};

function ManagedImage({ src, alt, className, onLoad, fallback = null }: ManagedImageProps) {
  const [failed, setFailed] = useState(false);

  if (failed) return fallback;

  return <img className={className} src={src} alt={alt} onLoad={onLoad} onError={() => setFailed(true)} />;
}

export function BrandMark({ className = "brand-mark" }: { className?: string }) {
  const source = skkuLogoImage();
  const fallback = <span className={className}>S</span>;

  if (!source) return fallback;

  return (
    <span className={`${className} has-image`}>
      <ManagedImage key={source} src={source} alt="SKKU Exchange Atlas logo" fallback={fallback} />
    </span>
  );
}

export function UniversityLogo({ name, className = "university-logo" }: { name: string; className?: string }) {
  const source = universityLogoImage(name);

  if (!source) return null;

  return <ManagedImage key={source} className={className} src={source} alt={`${name} logo`} />;
}

export function CountryCover({ name, universityName, className = "country-cover" }: { name: string; universityName?: string; className?: string }) {
  const source = countryCoverImage(name) ?? (universityName ? universityCoverImage(universityName) : undefined);

  if (!source) return null;

  return <ManagedImage key={source} className={className} src={source} alt={`${name} country cover`} />;
}

export function UniversityCover({
  name,
  fallback,
  className = "university-cover",
  onLoad,
}: {
  name: string;
  fallback?: string;
  className?: string;
  onLoad?: () => void;
}) {
  const source = universityCoverImage(name, fallback);

  if (!source) return null;

  return (
    <ManagedImage
      key={source}
      className={className}
      src={source}
      alt={`${name} university cover`}
      onLoad={onLoad}
    />
  );
}

function UniversityCardMediaContent({
  name,
  city,
  fallback,
  tone,
}: {
  name: string;
  city: string;
  fallback?: string;
  tone: number;
}) {
  const [loaded, setLoaded] = useState(false);

  return (
    <div className={`card-visual visual-${tone % 3} ${loaded ? "has-photo" : ""}`}>
      <UniversityCover name={name} fallback={fallback} onLoad={() => setLoaded(true)} />
      <UniversityLogo name={name} className="card-university-logo" />
      {!loaded && <span>{city.slice(0, 1)}</span>}
      <small>{city}</small>
    </div>
  );
}

export function UniversityCardMedia({
  name,
  city,
  fallback,
  tone = 0,
}: {
  name: string;
  city: string;
  fallback?: string;
  tone?: number;
}) {
  return (
    <UniversityCardMediaContent
      key={`${name}|${fallback ?? ""}`}
      name={name}
      city={city}
      fallback={fallback}
      tone={tone}
    />
  );
}
