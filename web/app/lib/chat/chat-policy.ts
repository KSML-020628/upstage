// Small, independently-testable safety utilities used by app/api/chat/route.ts.
//
// This module intentionally stays narrow: every export here is wired into the
// live chat route and covered by tests against realistic inputs. Do not add
// exports "for later" -- unused policy code is worse than no policy code,
// because it looks like a safeguard is in place when it isn't.

export type DateComparator = "gt" | "gte" | "lt" | "lte" | "eq";

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isValidIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() + 1 === Number(match[2]) &&
    date.getUTCDate() === Number(match[3])
  );
}

// "2026-05-01 이후" / "before 2026-05-01" style relative-date filtering. Both
// sides must already be plain YYYY-MM-DD strings (callers extract these from
// deadline_date / normalized question text before calling this).
export function compareIsoDate(actual: string, comparator: DateComparator, expected: string): boolean {
  if (!isValidIsoDate(actual) || !isValidIsoDate(expected)) return false;
  const a = Date.parse(`${actual}T00:00:00Z`);
  const b = Date.parse(`${expected}T00:00:00Z`);
  if (comparator === "gt") return a > b;
  if (comparator === "gte") return a >= b;
  if (comparator === "lt") return a < b;
  if (comparator === "lte") return a <= b;
  return a === b;
}

export type DeadlineDateConstraint = { comparator: DateComparator; date: string };

// Extracts a single "YYYY-MM-DD 이후/이전/이상/이하" style constraint from a
// question. Only one is extracted per question (the same simplification the
// rest of route.ts's regex-based constraint detection already uses for other
// fields) -- if a question needs more than one date bound, that's a case for
// a real planner, not a regex.
export function parseDeadlineDateConstraint(question: string): DeadlineDateConstraint | undefined {
  const text = question.normalize("NFKC");
  const match = text.match(/(20\d{2}-\d{2}-\d{2})\s*(이후|이상|초과|이전|이하|미만|after|before)?/i);
  if (!match || !isValidIsoDate(match[1])) return undefined;
  const word = match[2] ?? "";
  const comparator: DateComparator = /이후|초과|after/i.test(word)
    ? "gt"
    : /이상/.test(word)
      ? "gte"
      : /이전|미만|before/i.test(word)
        ? "lt"
        : /이하/.test(word)
          ? "lte"
          : "eq";
  return { comparator, date: match[1] };
}

// Refuses to search or hand back structured data for requests trying to
// extract the system prompt, API keys/env vars, or a raw database dump.
// This is a deterministic pre-filter in front of the LLM: the system prompt
// already tells the model not to comply with these, but a code-level check
// that runs before any model call is a much harder guarantee to bypass.
export function isPromptInjectionRequest(question: string): boolean {
  return /(?:system|시스템)\s*(?:prompt|프롬프트)|(?:api|환경\s*변수|env(?:ironment)?|secret|비밀)\s*(?:key|키|출력|보여|공개)|원본\s*(?:db|데이터베이스).*(?:전체|모두|dump|출력)|ignore (?:all |previous )?instructions|지시(?:를|사항을)?\s*무시/i.test(
    question.normalize("NFKC"),
  );
}

// The final answer text is composed by a deterministic template plus,
// sometimes, a Solar reasoner pass -- both are supposed to be projections of
// the same verified `cards`, never an independent description of them. If a
// card that's actually attached to the response is never named in the prose,
// that's a sign the answer drifted from the data it's supposed to represent.
export function findCardsMissingFromAnswer<T extends { university_name: string }>(cards: T[], answerText: string): T[] {
  return cards.filter((card) => !answerText.includes(card.university_name));
}
