import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { groundPlannerFields } from "../app/lib/chat/planner-grounding.ts";
import type { QueryPlan } from "../app/lib/chat/query-plan.ts";

function plan(overrides: Partial<QueryPlan["hardFilters"]> = {}, requestedFields: string[] = []): QueryPlan {
  return {
    intent: "housing",
    universityNames: [],
    hardFilters: {
      regions: [], countries: [], excludedRegions: [], excludedCountries: [],
      semesters: [], academicYears: [], majors: [],
      ...overrides,
    },
    softPreferences: {},
    requestedFields,
    limit: 4,
    followupReference: { enabled: false },
    clarificationNeeded: false,
  } as QueryPlan;
}

describe("groundPlannerFields: housingAvailable vs housingGuaranteed are never conflated", () => {
  it("drops a Planner-claimed housingGuaranteed when the question never says 'guaranteed'", () => {
    const result = groundPlannerFields({
      question: "셰필드 기숙사 알려줘",
      validatedPlan: plan({ housingAvailable: true, housingGuaranteed: true }),
    });
    assert.equal(result.housingAvailable.value, true);
    assert.equal(result.housingAvailable.provenance, "current_turn");
    assert.equal(result.housingGuaranteed.value, undefined);
    assert.equal(result.housingGuaranteed.provenance, "planner_ungrounded");
    assert.ok(result.issues.includes("planner_ungrounded_housing_guaranteed"));
  });

  it("keeps housingGuaranteed when the question actually says 배정 보장", () => {
    const result = groundPlannerFields({
      question: "기숙사 배정이 보장되는 대학을 추천해줘",
      validatedPlan: plan({ housingAvailable: true, housingGuaranteed: true }),
    });
    assert.equal(result.housingGuaranteed.value, true);
    assert.equal(result.housingGuaranteed.provenance, "current_turn");
  });
});

describe("groundPlannerFields: semester", () => {
  it("drops a Planner-claimed semester when the question has no semester word at all", () => {
    const result = groundPlannerFields({
      question: "셰필드 기숙사 알려줘",
      validatedPlan: plan({ semesters: ["spring"] }),
    });
    assert.deepEqual(result.semesters.value, []);
    assert.ok(result.issues.includes("planner_ungrounded_semester:spring"));
  });

  it("keeps a semester when the question actually names one", () => {
    const result = groundPlannerFields({
      question: "봄학기에 갈 수 있는 곳",
      validatedPlan: plan({ semesters: ["spring"] }),
    });
    assert.deepEqual(result.semesters.value, ["spring"]);
  });
});

describe("groundPlannerFields: major", () => {
  it("drops a Planner-claimed major when the question never mentions one", () => {
    const result = groundPlannerFields({
      question: "셰필드 기숙사 알려줘",
      validatedPlan: plan({ majors: ["engineering"] }),
    });
    assert.deepEqual(result.majors.value, []);
    assert.ok(result.issues.includes("planner_ungrounded_major:engineering"));
  });

  it("keeps a major when the question actually names one", () => {
    const result = groundPlannerFields({
      question: "경영학 전공인데 지원 가능한 대학",
      validatedPlan: plan({ majors: ["business"] }),
    });
    assert.deepEqual(result.majors.value, ["business"]);
  });
});

describe("groundPlannerFields: officialSourceRequired / cost", () => {
  it("does not adopt officialSourceRequired without a source/official-link request", () => {
    const result = groundPlannerFields({
      question: "셰필드 기숙사 알려줘",
      validatedPlan: plan({ officialSourceRequired: true }),
    });
    assert.equal(result.officialSourceRequired.value, undefined);
    assert.ok(result.issues.includes("planner_ungrounded_official_source"));
  });

  it("adopts officialSourceRequired when the question asks for a source/link", () => {
    const result = groundPlannerFields({
      question: "공식 출처를 보여줘",
      validatedPlan: plan({ officialSourceRequired: true }),
    });
    assert.equal(result.officialSourceRequired.value, true);
  });

  it("does not adopt a cost condition without a cost/budget request", () => {
    const result = groundPlannerFields({
      question: "셰필드 기숙사 알려줘",
      validatedPlan: plan({ numericCostRequired: true }),
    });
    assert.equal(result.requireClearCost.value, undefined);
    assert.ok(result.issues.includes("planner_ungrounded_cost"));
  });
});

describe("groundPlannerFields: requestedFields", () => {
  it("drops a requestedField the question never asked for", () => {
    const result = groundPlannerFields({
      question: "셰필드 기숙사 알려줘",
      validatedPlan: plan({}, ["housing_options", "estimated_costs"]),
    });
    assert.deepEqual(result.requestedFields.value, ["housing_options"]);
    assert.ok(result.issues.includes("planner_unsupported_requested_field:estimated_costs"));
  });

  it("always allows the base 'universities' field", () => {
    const result = groundPlannerFields({
      question: "셰필드 기숙사 알려줘",
      validatedPlan: plan({}, ["universities", "housing_options"]),
    });
    assert.deepEqual(result.requestedFields.value, ["universities", "housing_options"]);
  });
});

describe("groundPlannerFields: conversation context", () => {
  it("grounds a field via prior-turn text when the current turn alone doesn't mention it", () => {
    const result = groundPlannerFields({
      question: "그중 기숙사 배정이 보장되는 곳은?",
      conversationText: "봄학기에 갈 수 있는 유럽 대학 추천해줘",
      validatedPlan: plan({ semesters: ["spring"] }),
    });
    assert.deepEqual(result.semesters.value, ["spring"]);
    assert.equal(result.semesters.provenance, "conversation_context");
  });
});
