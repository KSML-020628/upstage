import { brandImages, countryCoverImages, universityCoverImages, universityLogoImages } from "./generated-media";

export function universityCoverImage(universityName: string, fallback?: string): string | undefined {
  return universityCoverImages[universityName] ?? fallback;
}

export function universityLogoImage(universityName: string): string | undefined {
  return universityLogoImages[universityName];
}

export function countryCoverImage(countryName: string): string | undefined {
  return countryCoverImages[countryName];
}

export function skkuLogoImage(): string | undefined {
  return brandImages["skku-logo"];
}
