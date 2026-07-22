from __future__ import annotations

import json
import time
import urllib.request
from pathlib import Path

API = "http://localhost:3000/api/chat"
OUTPUT = Path(__file__).resolve().parents[1] / ".chat-audit" / "regression-30.json"

GROUPS = {
    "A": [
        "University of Sheffield의 교환학생 어학 조건을 알려줘.",
        "University of Helsinki의 기숙사 신청 방법과 보장 여부를 알려줘.",
        "University of Bristol의 지원 절차를 순서대로 알려줘.",
        "Linkoping University의 2026년 가을학기 지원 마감일은 언제야?",
        "University of Eastern Finland의 최소 GPA와 IELTS 조건을 알려줘.",
    ],
    "B": [
        "IELTS 6.0으로 지원 가능한 유럽 대학 3개를 추천해줘.",
        "2026년 가을학기 지원 마감일이 가장 빠른 유럽 대학 3개를 알려줘.",
        "IELTS 6.5, GPA 3.0/4.5, 경영학 전공, 봄학기, 기숙사 정보가 있는 유럽 대학 3개를 추천해줘.",
        "University of Bristol과 University of Sheffield의 IELTS와 지원 마감일을 표로 비교해줘.",
        "핀란드 대학 중 기숙사 정보가 있고 IELTS 6.5로 지원 가능한 곳을 알려줘.",
    ],
    "D": [
        "셰필드 대학교 아이엘츠 몇점이야?",
        "쉐필드대 영어성적 알려줘.",
        "헬싱키대 기숙사 있엉?",
        "브리스톨 교환학생 지원할 때 뭐 내야 해?",
        "링셰핑대 봄학기 마감 언제임?",
    ],
    "E": [
        "Harvard University의 교환학생 어학 조건을 알려줘.",
        "마감일 알려줘.",
        "기숙사 있는 대학 추천해줘.",
        "IELTS 4.0으로 지원 가능한 유럽 대학을 추천해줘.",
        "2028년 가을학기 마감일을 알려줘.",
    ],
    "F": [
        "오늘 서울 날씨 알려줘.",
        "내 합격 확률을 정확히 계산해줘.",
        "공식 자료에 없는 기숙사 월세를 예상해서 알려줘.",
        "University of Bristol 정보의 공식 출처 링크를 보여줘.",
        "영국과 핀란드 중 한국 대비 생활 물가가 더 낮은 나라는 어디야?",
    ],
}


def post(messages, context_ids, session, sequence):
    payload = json.dumps({"messages": messages, "contextUniversityIds": context_ids, "sessionId": session}, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(API, data=payload, method="POST", headers={
        "Content-Type": "application/json; charset=utf-8",
        "X-Forwarded-For": f"127.20.{sequence // 250}.{sequence % 250 + 1}",
    })
    with urllib.request.urlopen(request, timeout=90) as response:
        return json.loads(response.read().decode("utf-8"))


def summarize(group, number, question, result, previous_ids=None):
    cards = result.get("cards") or []
    matched = result.get("matched") or []
    partial = result.get("partially_matched") or []
    ids = [card.get("university_id") for card in cards if card.get("university_id")]
    fields = sorted({fact.get("field_key") for card in cards for fact in (card.get("fact_bundle") or []) if fact.get("field_key")})
    short = result.get("shortAnswer") or result.get("answer") or ""
    detailed = result.get("detailedAnswer") or result.get("answer") or ""
    positive_names = [card.get("university_name") for card in matched] if matched else [card.get("university_name") for card in cards]
    partial_names = [card.get("university_name") for card in partial]
    short_consistent = all(name in short for name in positive_names[:3]) if positive_names and "추천" in question else True
    confirmed_section = short.split("일부 조건", 1)[0]
    partial_not_promoted = all(name not in confirmed_section for name in partial_names) if partial_names else True
    case_id = f"{group}{number}"
    special_checks = {}
    if case_id == "E1":
        special_checks["unknown_university_rejected"] = not cards and not result.get("sources") and "찾지 못했습니다" in short
    elif case_id == "E5":
        special_checks["future_period_not_invented"] = not cards and not result.get("sources")
    elif case_id == "F4":
        special_checks["direct_source_link"] = bool(result.get("sources")) and "http" in short
    elif case_id == "F5":
        special_checks["cost_index_sources"] = len(result.get("sources") or []) >= 2

    return {
        "id": case_id, "question": question,
        "status": "ok", "search_mode": result.get("searchMode"),
        "cards": [card.get("university_name") for card in cards],
        "card_ids": ids, "matched": positive_names if matched else [], "partial": partial_names,
        "fact_fields": fields, "source_count": len(result.get("sources") or []),
        "short_answer": short, "detailed_answer": detailed,
        "checks": {
            "short_matched_consistent": short_consistent,
            "partial_not_promoted": partial_not_promoted,
            "followup_subset": previous_ids is None or set(ids).issubset(set(previous_ids)),
            "no_internal_ids": "fact_id" not in short and "confidence" not in short,
            **special_checks,
        },
    }


def run_one(group, number, question, sequence, messages=None, context_ids=None, previous_ids=None):
    messages = list(messages or []) + [{"role": "user", "content": question}]
    try:
        result = post(messages, context_ids or [], f"regression-{group}", sequence)
        return summarize(group, number, question, result, previous_ids), result, messages
    except Exception as error:
        return {"id": f"{group}{number}", "question": question, "status": "error", "error": str(error)}, {}, messages


def main():
    OUTPUT.parent.mkdir(exist_ok=True)
    records = []
    sequence = 1
    seeds = {}
    for group, questions in GROUPS.items():
        for number, question in enumerate(questions, 1):
            record, result, _ = run_one(group, number, question, sequence)
            records.append(record)
            if group == "B" and number in (1, 4):
                seeds[number] = result
            sequence += 1
            time.sleep(0.15)

    first = seeds.get(1, {})
    first_ids = [card.get("university_id") for card in (first.get("cards") or []) if card.get("university_id")]
    first_messages = [
        {"role": "user", "content": GROUPS["B"][0]},
        {"role": "assistant", "content": first.get("shortAnswer") or first.get("answer") or ""},
    ]
    followups = [
        "그중 봄학기에 갈 수 있는 곳만 알려줘.",
        "그 학교들 중 기숙사 배정이 보장되는 곳이 있어?",
        "첫 번째 대학의 공식 출처를 보여줘.",
    ]
    context_ids = first_ids
    messages = first_messages
    previous_ids = first_ids
    for number, question in enumerate(followups, 1):
        record, result, sent = run_one("C", number, question, sequence, messages, context_ids, previous_ids)
        records.append(record)
        answer = result.get("shortAnswer") or result.get("answer") or ""
        messages = sent + [{"role": "assistant", "content": answer}]
        ids = [card.get("university_id") for card in (result.get("cards") or []) if card.get("university_id")]
        if ids:
            context_ids = ids
            previous_ids = ids
        sequence += 1

    comparison = seeds.get(4, {})
    comparison_ids = [card.get("university_id") for card in (comparison.get("cards") or []) if card.get("university_id")]
    messages = [
        {"role": "user", "content": GROUPS["B"][3]},
        {"role": "assistant", "content": comparison.get("shortAnswer") or comparison.get("answer") or ""},
    ]
    for number, question in enumerate(["둘 중 어학 조건이 더 낮은 곳만 자세히 설명해줘.", "거기 지원 마감일은 언제야?"], 4):
        record, result, sent = run_one("C", number, question, sequence, messages, comparison_ids, comparison_ids)
        records.append(record)
        messages = sent + [{"role": "assistant", "content": result.get("shortAnswer") or result.get("answer") or ""}]
        ids = [card.get("university_id") for card in (result.get("cards") or []) if card.get("university_id")]
        if ids:
            comparison_ids = ids
        sequence += 1

    records.sort(key=lambda row: (row["id"][0], int(row["id"][1:])))
    summary = {
        "total": len(records),
        "errors": sum(record["status"] == "error" for record in records),
        "check_failures": sum(not value for record in records if record.get("checks") for value in record["checks"].values()),
    }
    OUTPUT.write_text(json.dumps({"summary": summary, "results": records}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    for record in records:
        failed = [key for key, value in record.get("checks", {}).items() if not value]
        print(f"{record['id']} {record['status']} cards={len(record.get('cards', []))} sources={record.get('source_count', 0)} failed={','.join(failed) or '-'}")


if __name__ == "__main__":
    main()
