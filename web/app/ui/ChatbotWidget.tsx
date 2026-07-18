"use client";

import Link from "next/link";
import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

type Source = {
  fact_id?: string;
  title: string;
  url: string;
  university_name?: string;
  source_type?: string;
  is_official?: boolean;
  field_key?: string;
  evidence_quote?: string;
};

type ResultCard = {
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
};

type Message = {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  cards?: ResultCard[];
  searchMode?: string;
};

const WELCOME: Message = {
  role: "assistant",
  content:
    "안녕하세요. 교환대학의 지원 조건, 어학 성적, 일정, 주거비를 물어보세요. Supabase에 저장된 구조화 데이터와 Solar Pro 3를 함께 사용해 답변합니다.",
};

const QUICK_QUESTIONS = [
  "유럽 대학 중 기숙사 비용이 명확한 학교 3개만 알려줘.",
  "IELTS 6.0으로 지원 가능한 유럽 대학을 비용 낮은 순서로 추천해줘.",
  "유럽 대학 중 지원 마감일이 빠른 학교 3개를 보여줘.",
  "정원 quota가 3명 이상이고 기숙사 정보가 있는 학교만 추천해줘.",
  "프랑스 대학 중 공식 출처가 있는 주거비 정보를 비교해줘.",
];

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
  return <MessageText text={text.replace(/\*\*/g, "")} />;
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

function AssistantMessage({ text }: { text: string }) {
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

    blocks.push(
      <p key={`p-${index}`}>
        <InlineText text={line} />
      </p>,
    );
    index += 1;
  }

  return <div className="chat-markdown">{blocks}</div>;
}

function ResultCards({ cards }: { cards?: ResultCard[] }) {
  if (!cards?.length) return null;

  return (
    <div className="chat-result-cards" aria-label="추천 대학 카드">
      {cards.map((card) => (
        <article key={card.university_id} className="chat-result-card">
          <div className="chat-result-card-head">
            <div>
              <b>{card.university_name}</b>
              <span>
                {card.country} · {card.city}
              </span>
            </div>
            <Link href={card.action_url}>보기 →</Link>
          </div>
          <p>{card.summary}</p>
          <div className="chat-card-badges">
            {card.badges.map((badge) => (
              <span key={badge}>{badge}</span>
            ))}
          </div>
          <ul>
            {card.highlights.map((highlight) => (
              <li key={highlight}>{highlight}</li>
            ))}
          </ul>
          {card.evidence_quote && <blockquote>{card.evidence_quote}</blockquote>}
          {card.source_url && (
            <a className="chat-card-source" href={card.source_url} target="_blank" rel="noreferrer">
              {card.source_title || "원문 출처"} ↗
            </a>
          )}
        </article>
      ))}
    </div>
  );
}

function fieldLabel(value?: string) {
  if (!value) return "";
  if (value === "cost_facts") return "비용 근거";
  if (value === "housing_facts") return "기숙사 근거";
  if (value === "language_requirements") return "어학 근거";
  if (value === "application_deadlines") return "마감일 근거";
  if (value === "source_links") return "공식 링크";
  return value.replace(/_/g, " ");
}

function SourceCards({ sources }: { sources?: Source[] }) {
  if (!sources?.length) return null;

  return (
    <div className="chat-source-cards" aria-label="답변 근거 출처">
      <p>DB 근거 출처</p>
      {sources.map((source) => (
        <a key={`${source.url}-${source.title}`} href={source.url} target="_blank" rel="noreferrer">
          <span>{source.is_official === false ? "비공식 보조 자료" : "공식 자료"}</span>
          <b>{source.title || "Source"}</b>
          {source.field_key && <em>{fieldLabel(source.field_key)}</em>}
          {source.university_name && <small>{source.university_name}</small>}
          {source.evidence_quote && <q>{source.evidence_quote}</q>}
        </a>
      ))}
    </div>
  );
}

export function ChatbotWidget() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([WELCOME]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
    }
  }, [open, messages, loading]);

  useEffect(() => {
    const closeWithEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", closeWithEscape);
    return () => window.removeEventListener("keydown", closeWithEscape);
  }, []);

  function resetChat() {
    setMessages([WELCOME]);
    setInput("");
    setLoading(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  async function send(question: string) {
    const content = question.trim();
    if (!content || loading) return;

    const nextMessages = [...messages, { role: "user" as const, content }];
    setMessages(nextMessages);
    setInput("");
    setLoading(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: nextMessages.slice(-8).map(({ role, content }) => ({ role, content })),
        }),
      });
      const result = (await response.json()) as {
        answer?: string;
        error?: string;
        sources?: Source[];
        cards?: ResultCard[];
        searchMode?: string;
      };

      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          content: result.answer || result.error || "답변을 불러오지 못했습니다.",
          sources: result.sources,
          cards: result.cards,
          searchMode: result.searchMode,
        },
      ]);
    } catch {
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          content: "네트워크 연결을 확인한 뒤 다시 질문해 주세요.",
        },
      ]);
    } finally {
      setLoading(false);
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

  return (
    <div className={`chatbot ${open ? "is-open" : ""}`}>
      {open && (
        <section className="chatbot-panel" role="dialog" aria-label="교환대학 AI 도우미">
          <header className="chatbot-header">
            <div className="chatbot-avatar">AI</div>
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
                {message.searchMode && <p className="chat-search-mode">검색 방식: {message.searchMode}</p>}
                {message.role === "assistant" && <ResultCards cards={message.cards} />}
                {message.role === "assistant" && <SourceCards sources={message.sources} />}
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
              <div className="chat-message assistant chatbot-typing">
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
              →
            </button>
          </form>
          <p className="chatbot-disclaimer">AI 답변은 DB 출처와 함께 최종 확인해 주세요.</p>
        </section>
      )}

      <button
        type="button"
        className="chatbot-toggle"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={open ? "챗봇 닫기" : "교환대학 AI 도우미 열기"}
      >
        <span>{open ? "×" : "AI"}</span>
        {!open && <b>대학 정보 물어보기</b>}
      </button>
    </div>
  );
}
