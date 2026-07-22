import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  moneyLabel,
  periodLabel,
  presentConditionCheck,
  presentCost,
  presentFieldValue,
  presentHousingApplication,
  presentHousingAvailability,
  presentHousingGuarantee,
  presentHousingRow,
  presentLanguage,
  presentUnknowns,
} from "../app/lib/display/present-fact.ts";

describe("cost presentation", () => {
  it("collapses equal ranges", () => assert.equal(moneyLabel(3337, 3337, "GBP"), "GBP 3,337"));
  it("keeps real ranges", () => assert.equal(moneyLabel(800, 1200, "EUR"), "EUR 800~1,200"));
  it("does not invent missing amounts", () => assert.equal(moneyLabel(null, null, "EUR"), undefined));
  it("maps billing periods", () => assert.equal(periodLabel("per_semester"), "학기"));
  it("keeps reference years separate", () => {
    assert.equal(presentCost({ cost_type: "Housing", amount_min: 3337, amount_max: 3337, currency: "GBP", billing_period: "per_semester", reference_period: "2025/26" }).value, "GBP 3,337 / 학기 · 2025/26 기준");
  });
});

describe("housing three-state presentation", () => {
  it("separates availability from application", () => {
    assert.equal(presentHousingAvailability({ housing_available: true }).value, "있음");
    assert.equal(presentHousingApplication({ application_required: true }).value, "필요");
  });
  it("does not treat unavailable as application status", () => assert.equal(presentHousingAvailability({ housing_available: false }).value, "없음"));
  it("keeps unknown availability unknown", () => assert.equal(presentHousingAvailability({ housing_available: null }).status, "unknown"));
  it("renders explicit non-guarantee precisely", () => assert.equal(presentHousingGuarantee({ housing_guaranteed: false }).value, "명시적으로 보장되지 않음"));
  it("does not turn unknown guarantee into false", () => assert.equal(presentHousingGuarantee({ housing_guaranteed: null }).status, "unknown"));
  it("renders guaranteed housing", () => assert.equal(presentHousingGuarantee({ housing_guaranteed: true }).value, "보장"));
  it("does not repeat housing in field values", () => {
    const values = presentHousingRow({ housing_available: true, housing_guaranteed: null, room_type: "Single", cost_min: 400, cost_max: 400, currency: "EUR", billing_period: "per_month" })
      .map((field) => field.value ?? "");
    assert.ok(values.every((value) => !value.startsWith("기숙사:")));
  });
});

describe("language presentation", () => {
  it("formats IELTS decimals", () => assert.equal(presentLanguage({ test_type: "IELTS Academic", minimum_score: 6, is_required: true }).value, "최소 6.0 · 필수"));
  it("formats subscores", () => assert.equal(presentLanguage({ test_type: "IELTS Academic", minimum_score: 6.5, minimum_subscores: { writing: 6, listening: 6 }, is_required: true }).value, "최소 6.5 · 각 영역 6.0 이상 · 필수"));
  it("does not treat unknown required status as required", () => assert.equal(presentLanguage({ test_type: "TOEFL iBT", minimum_score: 90, is_required: null }).value, "최소 90 · 필수 여부 확인 필요"));
  it("uses CEFR without inventing a score", () => assert.equal(presentLanguage({ language: "English", cefr_level: "B2", is_required: false }).value, "CEFR B2 · 필수 아님"));
});

describe("condition check presentation", () => {
  it("humanizes IELTS comparisons", () => assert.equal(presentConditionCheck({ key: "language", label: "IELTS Academic", state: "met", detail: "요구 6, 입력 6" }).value, "IELTS 6.0 기준 충족 · 보유 6.0"));
  it("humanizes housing guarantee", () => assert.equal(presentConditionCheck({ key: "housing_guaranteed", label: "배정 보장", state: "failed", detail: "보장 아님" }).value, "명시적으로 보장되지 않음"));
  it("keeps unknown distinct", () => assert.equal(presentConditionCheck({ key: "housing_available", label: "기숙사 제공", state: "unknown", detail: "" }).value, "확인 필요"));
});

describe("field value presentation", () => {
  it("maps contextual false values", () => assert.equal(presentFieldValue("housing_guaranteed", false), "명시적으로 보장되지 않음"));
  it("hides null values", () => assert.equal(presentFieldValue("housing_guaranteed", null), null));
  it("does not map reference years as billing enums", () => assert.equal(presentFieldValue("reference_period", "2025/26"), "2025/26"));
});

describe("unverified items presentation (section 22)", () => {
  // These are real unverified_items strings: bare noun phrases naming only what
  // could not be confirmed, with no predicate. Wrongly dropping one of these is
  // a worse failure than letting a piece of noise through, so this is checked
  // first and on its own, independent of the noise-rejection cases below.
  const genuineUnverifiedItems = [
    "교환학생 선발 인원(quota)",
    "정확한 GPA 기준",
    "비자 발급 소요 기간",
    "IU 학점 인정 기준",
    "Galápagos 캠퍼스 프로그램의 구체적인 지원 절차",
  ];

  it("never drops a genuinely unverified noun phrase", () => {
    const { shown, filtered } = presentUnknowns(genuineUnverifiedItems);
    for (const item of genuineUnverifiedItems) {
      assert.ok(shown.includes(item), `expected "${item}" to survive the filter, but it was dropped`);
    }
    assert.equal(filtered.length, 0);
  });

  it("does not judge a noun phrase by its parenthetical content alone", () => {
    assert.deepEqual(presentUnknowns(["교환학생 선발 인원(quota)"]).shown, ["교환학생 선발 인원(quota)"]);
  });

  it("drops misclassified confirmed facts and section summaries, keeping the genuine items", () => {
    const items = [
      "SDU Fitness: 월 149 DKK로 이용 가능.",
      "Cumbayá 캠퍼스는 2,850m 고도에 위치하며, 역사적 중심지가 잘 보존된 도시입니다.",
      "한눈에 보기: 헬싱키 대학교는 핀란드의 수도 헬싱키에 위치한 종합대학으로",
      ...genuineUnverifiedItems,
    ];
    const { shown, filtered } = presentUnknowns(items);
    assert.ok(!shown.includes("SDU Fitness: 월 149 DKK로 이용 가능."));
    assert.ok(!shown.includes("Cumbayá 캠퍼스는 2,850m 고도에 위치하며, 역사적 중심지가 잘 보존된 도시입니다."));
    assert.ok(!shown.includes("한눈에 보기: 헬싱키 대학교는 핀란드의 수도 헬싱키에 위치한 종합대학으로"));
    for (const item of genuineUnverifiedItems) assert.ok(shown.includes(item));
    assert.equal(filtered.length, 3);
  });

  it("collapses a proliferation chain of 20+ self-extending items to the shortest original", () => {
    const base = "교환학생 선발 후 수업 성적 인정 결과 발표";
    // None of these overlap with the base's own tokens or each other, so the
    // chain is rejected for growing-prefix duplication only, not because any
    // single item repeats a word internally.
    const extensionWords = [
      "시기", "방식", "확인", "절차", "기준", "일정", "안내", "공지", "여부", "방법",
      "조건", "사유", "형식", "단계", "범위", "시점", "구분", "항목", "내용", "현황",
    ];
    const chain: string[] = [];
    let current = base;
    for (const word of extensionWords) {
      current = `${current} ${word}`;
      chain.push(current);
    }
    assert.equal(chain.length, 20);
    assert.equal(chain[0], "교환학생 선발 후 수업 성적 인정 결과 발표 시기");

    const { shown, filtered } = presentUnknowns(chain);
    assert.deepEqual(shown, [chain[0]]);
    assert.equal(filtered.length, chain.length - 1);
  });

  it("drops a single item whose own words repeat, without needing a chain", () => {
    const { shown, filtered } = presentUnknowns(["교환학생 선발 후 수업 성적 인정 결과 발표 결과 발표 시기"]);
    assert.equal(shown.length, 0);
    assert.equal(filtered.length, 1);
  });

  it("shows an explicit empty result instead of leaving nothing when everything is noise", () => {
    const { shown, overflow, filtered } = presentUnknowns(["SDU Fitness: 월 149 DKK로 이용 가능."]);
    assert.equal(shown.length, 0);
    assert.equal(overflow.length, 0);
    assert.equal(filtered.length, 1);
  });

  it("shows at most 8 items immediately and folds the rest into overflow", () => {
    const items = Array.from({ length: 12 }, (_, index) => `확인되지 않은 항목 ${index + 1}`);
    const { shown, overflow, filtered } = presentUnknowns(items);
    assert.equal(shown.length, 8);
    assert.equal(overflow.length, 4);
    assert.equal(filtered.length, 0);
  });

  // Found via a full 53-university audit against live data. These are all real
  // unknowns entries that the first version of the filter wrongly dropped.
  it("passes the ETL's own field-status template instead of treating it as a leaked sentence", () => {
    assert.deepEqual(
      presentUnknowns(["academic_periods: 공식 근거 기반 구조화 값 추가 확인 필요"]).shown,
      ["academic_periods: 공식 근거 기반 구조화 값 추가 확인 필요"],
    );
  });

  it("does not treat a predicate marker used as a bare noun modifier as an assertion", () => {
    const items = [
      "기숙사 식사 제공 여부",
      "Level 2 트랙의 정확한 수강 가능 과목 목록",
      "Level 2 트랙의 정확한 학기 운영 기간",
      "교환학생 수강신청 시 학점 제한 및 최대 수강 가능 과목 수",
    ];
    const { shown, filtered } = presentUnknowns(items);
    assert.deepEqual(shown, items);
    assert.equal(filtered.length, 0);
  });

  it("still drops the same marker when it is actually conjugated as a predicate", () => {
    assert.equal(presentUnknowns(["캠퍼스는 시내 중심가에 위치한 대학으로"]).shown.length, 0);
  });

  it("does not flag a word reused once across two 및-joined clauses as proliferation", () => {
    assert.deepEqual(
      presentUnknowns(["교환학생 학점 인정 절차 및 학점 상한"]).shown,
      ["교환학생 학점 인정 절차 및 학점 상한"],
    );
  });
});
