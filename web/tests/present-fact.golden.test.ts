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
