"use client";

import { useState, type ReactNode } from "react";
import type { ChatResultCard, ChatSource } from "./ChatbotWidget";

export type DetailTab = "summary" | "universities" | "sources";

export type ChatDetailResponse = {
  question: string;
  detailedAnswer: string;
  cards: ChatResultCard[];
  sources: ChatSource[];
  createdAt: Date;
};

type ChatDetailPanelProps = {
  response: ChatDetailResponse;
  onClose: () => void;
  summaryContent: ReactNode;
  universityContent: ReactNode;
  sourceContent: ReactNode;
};

export function ChatDetailPanel({ response, onClose, summaryContent, universityContent, sourceContent }: ChatDetailPanelProps) {
  const [activeTab, setActiveTab] = useState<DetailTab>("summary");

  return (
    <aside className="chat-detail-panel" aria-label="챗봇 상세 결과">
      <header className="chat-detail-header">
        <div>
          <span>AI SEARCH RESULT</span>
          <h2>{response.question}</h2>
          <p>검색 결과 {response.cards.length}개 · {response.createdAt.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })} 확인</p>
        </div>
        <button type="button" onClick={onClose} aria-label="상세 결과 닫기">×</button>
      </header>

      <nav className="chat-detail-tabs" aria-label="상세 결과 탭">
        <button type="button" className={activeTab === "summary" ? "active" : ""} onClick={() => setActiveTab("summary")}>핵심 결과</button>
        <button type="button" className={activeTab === "universities" ? "active" : ""} onClick={() => setActiveTab("universities")}>대학 정보</button>
        <button type="button" className={activeTab === "sources" ? "active" : ""} onClick={() => setActiveTab("sources")}>공식 근거</button>
      </nav>

      <div className="chat-detail-body">
        {activeTab === "summary" && summaryContent}
        {activeTab === "universities" && universityContent}
        {activeTab === "sources" && sourceContent}
      </div>

      <footer>숫자와 날짜는 등록된 구조화 데이터만 사용합니다. 최종 지원 전 대학 공식 자료를 확인해 주세요.</footer>
    </aside>
  );
}
