"use client";

import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";

type Message = {
  role: "user" | "assistant";
  content: string;
};

const WELCOME: Message = {
  role: "assistant",
  content: "안녕하세요! 교환대학의 지원 조건, 어학 성적, 일정, 주거비를 물어보세요. 확인된 데이터와 출처를 바탕으로 답할게요.",
};

const QUICK_QUESTIONS = [
  "IELTS 조건을 비교해줘",
  "기숙사 정보가 있는 대학은?",
  "한 학기 비용을 비교해줘",
];

function MessageText({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s]+)/g);
  return <>{parts.map((part, index) => part.startsWith("http") ? (
    <a key={`${part}-${index}`} href={part.replace(/[),.;]+$/, "")} target="_blank" rel="noreferrer">
      {part.replace(/[),.;]+$/, "")}
    </a>
  ) : <span key={`${part}-${index}`}>{part}</span>)}</>;
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
        body: JSON.stringify({ messages: nextMessages.slice(-8) }),
      });
      const result = await response.json() as { answer?: string; error?: string };
      setMessages((current) => [...current, {
        role: "assistant",
        content: result.answer || result.error || "답변을 불러오지 못했습니다.",
      }]);
    } catch {
      setMessages((current) => [...current, {
        role: "assistant",
        content: "네트워크 연결을 확인한 뒤 다시 질문해 주세요.",
      }]);
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
              <span><i /> Supabase 대학 정보 기반</span>
            </div>
            <button type="button" onClick={() => setOpen(false)} aria-label="챗봇 닫기">×</button>
          </header>

          <div className="chatbot-messages" ref={listRef} aria-live="polite">
            {messages.map((message, index) => (
              <div className={`chat-message ${message.role}`} key={`${message.role}-${index}`}>
                <MessageText text={message.content} />
              </div>
            ))}
            {messages.length === 1 && (
              <div className="chatbot-quick">
                {QUICK_QUESTIONS.map((question) => (
                  <button type="button" key={question} onClick={() => void send(question)}>{question}</button>
                ))}
              </div>
            )}
            {loading && <div className="chat-message assistant chatbot-typing"><i /><i /><i /></div>}
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
            <button type="submit" disabled={!input.trim() || loading} aria-label="질문 보내기">↑</button>
          </form>
          <p className="chatbot-disclaimer">AI 답변은 원문 출처와 함께 최종 확인해 주세요.</p>
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
