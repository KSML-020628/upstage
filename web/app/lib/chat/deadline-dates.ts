import { cleanText } from "./utils.ts";

const ENGLISH_MONTHS: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
  july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
};

// deadline_date (the structured column) is null for a real, sizeable chunk
// of rows (69 of the current dataset) -- the only date information for
// those lives in deadline_text as free text, often in a non-ISO format
// (Korean "2026년 5월 3일", or English "3 May 2026"). Only handling ISO
// meant deadlineRowTime silently returned undefined for all of them, which
// matchingDeadlineRows treats as "no matching year" -- e.g. Bristol's own
// deadline rows (deadline_text: "2026년 5월 3일", deadline_date: null) were
// being filtered out of every year-scoped deadline query even though the
// actual date was right there, just not in the one format this parsed.
// Rows with no year at all in the text ("15th January", "30 April") are
// left unparsed -- inferring a year from surrounding context is a separate,
// harder problem this doesn't attempt to solve.
export function parseKoreanDate(text: string): string | undefined {
  const match = text.match(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/);
  if (!match) return undefined;
  const [, year, month, day] = match;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

export function parseEnglishDate(text: string): string | undefined {
  const match = text.match(/(\d{1,2})(?:st|nd|rd|th)?\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i);
  if (!match) return undefined;
  const [, day, monthName, year] = match;
  const month = ENGLISH_MONTHS[monthName.toLowerCase()];
  return month ? `${year}-${month}-${day.padStart(2, "0")}` : undefined;
}

export function deadlineRowTime(row: Record<string, unknown>) {
  const text = cleanText(row.deadline_date, cleanText(row.date, cleanText(row.deadline_text)));
  const iso = text.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? parseKoreanDate(text) ?? parseEnglishDate(text);
  if (iso) return Date.parse(iso);
  return undefined;
}
