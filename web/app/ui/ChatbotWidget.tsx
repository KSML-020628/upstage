"use client";

import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ChatDetailPanel, type ChatDetailResponse } from "./ChatDetailPanel";

export type ChatSource = {
  fact_id?: string;
  title: string;
  url: string;
  university_name?: string;
  source_type?: string;
  is_official?: boolean;
  field_key?: string;
  evidence_quote?: string;
};

export type ChatResultCard = {
  university_id: string;
  university_name: string;
  country: string;
  city: string;
  summary: string;
  badges: string[];
  highlights: string[];
  action_label: string;
  action_url: string;
  source_url?: string;
  source_title?: string;
  source_type?: string;
  source_field_key?: string;
  evidence_quote?: string;
  match_status?: "matched" | "partial";
  condition_checks?: Array<{ key: string; label: string; state: "met" | "unknown" | "failed"; detail: string }>;
  unknown_fields?: string[];
};

type Message = {
  role: "user" | "assistant";
  content: string;
  sources?: ChatSource[];
  cards?: ChatResultCard[];
  searchMode?: string;
  detailedAnswer?: string;
  detailResponse?: ChatDetailResponse;
};

type ChatbotWidgetProps = {
  mode?: "floating" | "panel";
  onSelectUniversity?: (card: ChatResultCard, intent?: string) => void;
};

const WELCOME: Message = {
  role: "assistant",
  content:
    "안녕하세요. 교환대학의 지원 조건, 어학 성적, 일정, 주거비를 물어보세요. Supabase에 저장된 구조화 데이터와 Solar Pro 3를 함께 사용해 답변합니다.",
};

const QUICK_QUESTIONS = [
  "IELTS 6.0으로 지원 가능한 유럽 대학 3개를 추천해줘.",
  "University of Helsinki 기숙사 정보 보여줘.",
  "University of Sheffield 어학 조건을 알려줘.",
  "지원 마감일이 빠른 유럽 대학 3개 보여줘.",
];

const V2_STAGES = [
  "Solar Pro 3가 질문의 조건을 분석하고 있습니다.",
  "Solar Pro 3의 분석을 바탕으로 대학 데이터를 검색하고 있습니다.",
  "후보 대학의 조건과 출처를 검증하고 있습니다.",
  "Solar Pro 3가 검증된 결과를 정리하고 있습니다.",
];

function inferIntent(card?: ChatResultCard, fallbackText = "") {
  const text = `${fallbackText} ${card?.action_label ?? ""} ${card?.highlights?.join(" ") ?? ""}`.toLowerCase();
  if (/비용|cost|fee|tuition|living/.test(text)) return "cost";
  if (/기숙사|숙소|주거|housing|accommodation|dorm|residence/.test(text)) return "housing";
  if (/ielts|toefl|어학|마감|deadline|application|nomination|지원/.test(text)) return "requirements";
  return "overview";
}

function MessageText({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s]+)/g);
  return (
    <>
      {parts.map((part, index) =>
        part.startsWith("http") ? (
          <a key={`${part}-${index}`} href={part.replace(/[),.;]+$/, "")} target="_blank" rel="noreferrer">
            {part.replace(/[),.;]+$/, "")}
          </a>
        ) : (
          <span key={`${part}-${index}`}>{part}</span>
        ),
      )}
    </>
  );
}

function InlineText({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  return (
    <>
      {parts.map((part, index) =>
        part.startsWith("**") && part.endsWith("**") ? (
          <strong key={`${part}-${index}`}><MessageText text={part.slice(2, -2)} /></strong>
        ) : (
          <MessageText key={`${part}-${index}`} text={part} />
        ),
      )}
    </>
  );
}

function readableText(value: string, maxLength = 280) {
  const cleaned = value
    .replace(/<[^>]+>/g, " ")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength).trim()}…` : cleaned;
}

function shortAnswerFromResult(answer: string, cards: ChatResultCard[]) {
  if (cards.length === 1) {
    const card = cards[0];
    const facts = card.highlights.slice(0, 3).map((item) => readableText(item, 100));
    return [
      `### ${card.university_name}`,
      "",
      facts.length ? facts.map((fact) => `- ${fact}`).join("\n") : readableText(answer, 260),
    ].join("\n");
  }
  if (cards.length > 1) {
    const names = cards.slice(0, 3).map((card) => card.university_name).join(", ");
    return [
      "### 검색 결과",
      "",
      `조건과 관련된 대학 ${cards.length}개를 확인했습니다.`,
      "",
      `- 주요 후보: ${names}${cards.length > 3 ? " 외" : ""}`,
    ].join("\n");
  }
  const plain = readableText(answer.replace(/^#{1,4}\s+/gm, "").replace(/^[-*>]\s+/gm, ""), 360);
  return `### 안내\n\n${plain}`;
}

function sourceTitle(source: ChatSource) {
  const title = readableText(source.title || "", 90);
  const normalized = title.toLowerCase().replace(/[\s_-]+/g, " ").trim();

  if (!title || normalized === "source") return "공식 교환학생 안내";
  if (normalized === "target university official") return "대학 공식 자료";
  if (normalized === "fact sheet pdf") return "교환학생 Fact Sheet";
  if (normalized === "student review") return "교환학생 후기 자료";
  return title;
}

function isMarkdownTable(lines: string[], index: number) {
  return (
    lines[index]?.trim().startsWith("|") &&
    lines[index + 1]?.trim().startsWith("|") &&
    /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(lines[index + 1].trim())
  );
}

function tableCells(line: string) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

export function AssistantMessage({ text }: { text: string }) {
  const lines = text.split(/\r?\n/);
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (isMarkdownTable(lines, index)) {
      const header = tableCells(lines[index]);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].trim().startsWith("|")) {
        rows.push(tableCells(lines[index]));
        index += 1;
      }
      blocks.push(
        <div className="chat-markdown-table" key={`table-${index}`}>
          <table>
            <thead>
              <tr>
                {header.map((cell, cellIndex) => (
                  <th key={`${cell}-${cellIndex}`}>
                    <InlineText text={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={`row-${rowIndex}`}>
                  {header.map((_, cellIndex) => (
                    <td key={`cell-${cellIndex}`}>
                      <InlineText text={row[cellIndex] ?? ""} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      blocks.push(<h3 className="chat-markdown-heading" key={`heading-${index}`}><InlineText text={heading[2]} /></h3>);
      index += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quotes: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quotes.push(lines[index].replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push(<blockquote key={`quote-${index}`}><InlineText text={quotes.join(" ")} /></blockquote>);
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*]\s+/, ""));
        index += 1;
      }
      blocks.push(
        <ul className="chat-markdown-list" key={`list-${index}`}>
          {items.map((item, itemIndex) => (
            <li key={`${item}-${itemIndex}`}>
              <InlineText text={item} />
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+[.)]\s+/, ""));
        index += 1;
      }
      blocks.push(
        <ol className="chat-markdown-list" key={`ordered-${index}`}>
          {items.map((item, itemIndex) => <li key={`${item}-${itemIndex}`}><InlineText text={item} /></li>)}
        </ol>,
      );
      continue;
    }

    blocks.push(
      <p key={`p-${index}`}>
        <InlineText text={line} />
      </p>,
    );
    index += 1;
  }

  return <div className="chat-markdown">{blocks}</div>;
}

export function ResultCards({
  cards,
  onSelectUniversity,
  activeQuestion,
}: {
  cards?: ChatResultCard[];
  onSelectUniversity?: (card: ChatResultCard, intent?: string) => void;
  activeQuestion?: string;
}) {
  if (!cards?.length) return null;

  return (
    <div className="chat-result-cards" aria-label="추천 대학 카드">
      {cards.map((card) => (
        <article key={card.university_id} className={`chat-result-card ${card.match_status === "partial" ? "is-partial" : ""}`}>
          {card.match_status && (
            <span className={`chat-match-status ${card.match_status}`}>
              {card.match_status === "matched" ? "조건 충족" : "추가 확인 필요"}
            </span>
          )}
          <div className="chat-result-card-head">
            <div>
              <b>{card.university_name}</b>
              <span>
                {card.country} · {card.city}
              </span>
            </div>
            <button
              type="button"
              onClick={() => {
                if (onSelectUniversity) onSelectUniversity(card, inferIntent(card, activeQuestion));
                else window.location.assign(card.action_url);
              }}
            >
              보기 →
            </button>
          </div>
          <p>{readableText(card.summary, 190)}</p>
          <div className="chat-card-badges">
            {card.badges.map((badge) => (
              <span key={badge}>{badge}</span>
            ))}
          </div>
          <ul>
            {card.highlights.map((highlight) => (
              <li key={highlight}>{readableText(highlight, 220)}</li>
            ))}
          </ul>
          {!!card.unknown_fields?.length && (
            <p className="chat-card-unknown">미확인: {card.unknown_fields.join(", ")}</p>
          )}
          {card.source_url && (
            <a className="chat-card-source" href={card.source_url} target="_blank" rel="noreferrer">
              공식 출처 보기 ↗
            </a>
          )}
        </article>
      ))}
    </div>
  );
}

function fieldLabel(value?: string) {
  if (!value) return "근거";
  if (value === "cost_facts") return "비용 근거";
  if (value === "housing_facts") return "기숙사 근거";
  if (value === "language_requirements") return "어학 근거";
  if (value === "application_deadlines") return "마감일 근거";
  if (value === "source_links") return "공식 링크";
  return value.replace(/_/g, " ");
}

export function SourceCards({ sources }: { sources?: ChatSource[] }) {
  if (!sources?.length) return null;

  return (
    <div className="chat-source-cards" aria-label="답변 근거 출처">
      <p>공식 근거</p>
      {sources.map((source) => (
        <a key={`${source.url}-${source.title}`} href={source.url} target="_blank" rel="noreferrer">
          <span>{source.is_official === false ? "비공식 보조 자료" : "공식 자료"}</span>
          <b>{sourceTitle(source)}</b>
          {source.field_key && <em>{fieldLabel(source.field_key)}</em>}
          {source.university_name && <small>{source.university_name}</small>}
          {source.evidence_quote && <q>{readableText(source.evidence_quote, 220)}</q>}
        </a>
      ))}
    </div>
  );
}

export function ChatbotWidget({ mode = "floating" }: ChatbotWidgetProps) {
  const isPanel = mode === "panel";
  const [open, setOpen] = useState(isPanel);
  const [messages, setMessages] = useState<Message[]>([WELCOME]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingStage, setLoadingStage] = useState(0);
  const [sessionId, setSessionId] = useState(() => crypto.randomUUID());
  const [detailResponse, setDetailResponse] = useState<ChatDetailResponse | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const requestSequenceRef = useRef(0);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
    }
  }, [open, messages, loading]);

  useEffect(() => {
    if (isPanel) return;
    const closeWithEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", closeWithEscape);
    return () => window.removeEventListener("keydown", closeWithEscape);
  }, [isPanel]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  function resetChat() {
    controllerRef.current?.abort();
    controllerRef.current = null;
    requestSequenceRef.current += 1;
    setMessages([WELCOME]);
    setInput("");
    setLoading(false);
    setSessionId(crypto.randomUUID());
    setDetailResponse(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  async function send(question: string) {
    const content = question.trim();
    if (!content || loading) return;

    const nextMessages = [...messages, { role: "user" as const, content }];
    const requestSequence = ++requestSequenceRef.current;
    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;
    setMessages(nextMessages);
    setInput("");
    setLoading(true);

    try {
      const contextUniversityIds = [...messages]
        .reverse()
        .find((message) => message.role === "assistant" && message.cards?.length)
        ?.cards?.map((card) => card.university_id)
        .slice(0, 8) ?? [];
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
        signal: controller.signal,
        body: JSON.stringify({
          sessionId,
          contextUniversityIds,
          messages: nextMessages.slice(-8).map(({ role, content }) => ({ role, content })),
        }),
      });
      type ApiResult = {
        answer?: string;
        shortAnswer?: string;
        detailedAnswer?: string;
        error?: string;
        sources?: ChatSource[];
        cards?: ChatResultCard[];
        searchMode?: string;
        solarUsed?: { planner: boolean; reasoner: boolean };
        fallbackUsed?: boolean;
        suggestedDetailTab?: string;
      };
      let result: ApiResult = {};
      const reader = response.body?.getReader();
      if (!reader) throw new Error("응답 스트림을 열 수 없습니다.");
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (requestSequence !== requestSequenceRef.current) return;
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as { type?: string; stage?: string; message?: string; data?: ApiResult };
          if (event.type === "status") {
            if (requestSequence !== requestSequenceRef.current) return;
            const stageIndex = ["planning", "searching", "validating", "reasoning"].indexOf(event.stage ?? "");
            if (stageIndex >= 0) setLoadingStage(stageIndex);
          }
          if (event.type === "result" && event.data) result = event.data;
          if (event.type === "error") throw new Error(event.message || "챗봇 요청에 실패했습니다.");
        }
      }

      const cards = result.cards ?? [];
      const sources = result.sources ?? [];
      const detailedAnswer = result.detailedAnswer || result.answer || result.error || "답변을 불러오지 못했습니다.";
      const shortAnswer = result.shortAnswer || shortAnswerFromResult(detailedAnswer, cards);
      const nextDetail: ChatDetailResponse = {
        question: content,
        detailedAnswer,
        cards,
        sources,
        createdAt: new Date(),
      };

      if (requestSequence !== requestSequenceRef.current) return;
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          content: shortAnswer,
          sources,
          cards,
          searchMode: result.searchMode,
          detailedAnswer,
          detailResponse: nextDetail,
        },
      ]);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (requestSequence !== requestSequenceRef.current) return;
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          content: "네트워크 연결을 확인한 뒤 다시 질문해 주세요.",
        },
      ]);
    } finally {
      if (requestSequence === requestSequenceRef.current) {
        controllerRef.current = null;
        setLoading(false);
      }
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void send(input);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send(input);
    }
  }

  const panel = (
    <section className="chatbot-panel" role={isPanel ? "region" : "dialog"} aria-label="교환대학 AI 도우미">
      <header className="chatbot-header">
        <div className="chatbot-avatar">
          <img src="/images/upstage-color.png" alt="Upstage" />
        </div>
        <div>
          <strong>Exchange Atlas AI</strong>
          <span>
            <i /> Supabase 구조화 데이터 + Solar Pro 3
          </span>
        </div>
        <button type="button" className="chatbot-reset" onClick={resetChat}>
          새 대화
        </button>
        <button type="button" onClick={() => setOpen(false)} aria-label="챗봇 닫기">
          ×
        </button>
      </header>

      <div className="chatbot-messages" ref={listRef} aria-live="polite">
        {messages.map((message, index) => (
          <div className={`chat-message ${message.role}`} key={`${message.role}-${index}`}>
            {message.role === "assistant" ? <AssistantMessage text={message.content} /> : <MessageText text={message.content} />}
            {message.role === "assistant" && message.detailResponse && (
              <button type="button" className="chat-detail-open" onClick={() => setDetailResponse(message.detailResponse ?? null)}>
                {(message.cards?.length ?? 0) > 1 ? "비교 결과 자세히 보기" : "상세 결과 보기"} →
              </button>
            )}
            {message.role === "assistant" && index > 0 && <time>방금 전</time>}
          </div>
        ))}
        {messages.length === 1 && (
          <div className="chatbot-quick">
            {QUICK_QUESTIONS.map((question) => (
              <button type="button" key={question} onClick={() => void send(question)}>
                {question}
              </button>
            ))}
          </div>
        )}
        {loading && (
          <div className="chat-message assistant chatbot-typing" role="status">
            <span>{V2_STAGES[loadingStage]}</span>
            <i />
            <i />
            <i />
          </div>
        )}
      </div>

      <form className="chatbot-form" onSubmit={submit}>
        <textarea
          ref={inputRef}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={handleKeyDown}
          maxLength={2000}
          rows={1}
          placeholder="대학 정보에 대해 질문해 보세요"
          aria-label="챗봇 질문"
        />
        <button type="submit" disabled={!input.trim() || loading} aria-label="질문 보내기">
          ↑
        </button>
      </form>
      <p className="chatbot-disclaimer">AI 답변은 참고용 정보이며, 정확한 정보는 각 대학 공식 웹사이트를 확인해 주세요.</p>
    </section>
  );

  if (isPanel) {
    return (
      <div className={`chatbot chatbot-panel-mode ${open ? "is-open" : ""}`}>
        {open ? (
          panel
        ) : (
          <button type="button" className="chatbot-panel-reopen" onClick={() => setOpen(true)}>
            Exchange Atlas AI 열기
          </button>
        )}
      </div>
    );
  }

  return (
    <>
      {detailResponse && (
        <ChatDetailPanel
          response={detailResponse}
          onClose={() => setDetailResponse(null)}
          summaryContent={<AssistantMessage text={detailResponse.detailedAnswer} />}
          universityContent={detailResponse.cards.length ? <ResultCards cards={detailResponse.cards} activeQuestion={detailResponse.question} /> : <div className="chat-detail-empty">표시할 대학 카드가 없습니다.</div>}
          sourceContent={detailResponse.sources.length ? <SourceCards sources={detailResponse.sources} /> : <div className="chat-detail-empty">연결된 공식 근거가 없습니다.</div>}
        />
      )}
      <div className={`chatbot ${open ? "is-open" : ""}`}>
        {open && panel}
        <button
          type="button"
          className="chatbot-toggle"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-label={open ? "챗봇 닫기" : "교환대학 AI 도우미 열기"}
        >
          <span>
            {open ? "×" : <img src="/images/upstage-color.png" alt="Upstage" />}
          </span>
          {!open && <b>대학 정보 물어보기</b>}
        </button>
      </div>
    </>
  );
}
