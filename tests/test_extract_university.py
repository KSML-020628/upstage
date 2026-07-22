from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from extract_university import (
    GROUPS,
    assemble_standard_document,
    clean_unverified,
    document_matches_group,
    dropped_unverified_items,
    extract_all,
    is_unverified_item_shape_valid,
    parse_json_object,
    reset_dropped_unverified_items,
)
from validate_university import DEFAULT_SCHEMA, load_json, validate_document


class FakeSolar:
    def __init__(self) -> None:
        self.index = 0

    def complete_json(self, _system: str, _user: str):
        group = GROUPS[self.index].name
        self.index += 1
        partials = {
            "core": {
                "university": {"university_name": "University of Bristol", "country": "United Kingdom", "city": "Bristol"},
                "exchange_program": {"minimum_gpa": 3.0, "tuition_waived": True},
                "unverified_items": [],
            },
            "application": {
                "application_deadlines": [],
                "language_requirements": [{"language": "English", "test_type": "IELTS Academic", "overall_score": 6.5}],
                "required_documents": [],
                "unverified_items": [],
            },
            "academic": {
                "academic_periods": [{"period_type": "semester", "start_text": "September 2026"}],
                "exchange_program_updates": {"course_registration_notes": "Choose units online."},
                "unverified_items": [],
            },
            "housing_costs": {
                "housing_options": [],
                "estimated_costs": [{"cost_type": "private_rent", "amount_min": 500, "amount_max": 800, "currency": "GBP"}],
                "unverified_items": [],
            },
            "student_life": {
                "university_updates": {"student_life": ["Individual reports mention active student societies."]},
                "unverified_items": [{"category": "student_life", "field_name": "student_life", "reason": "only_in_unofficial_sources", "details": "Student reports only", "source_url": None}],
            },
        }
        return partials[group], {"fake_group": group}


class ExtractUniversityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.documents = [{
            "source_kind": "web",
            "source_types": ["fact_sheet", "incoming_exchange"],
            "title": "Official fact sheet",
            "url": "https://example.edu/fact-sheet",
            "local_path": None,
            "content": "Official exchange information",
        }, {
            "source_kind": "manual",
            "source_types": ["student_report"],
            "title": "Student report",
            "url": None,
            "local_path": "manual/report.doc",
            "content": "My individual experience was positive.",
        }]

    def test_json_parser_accepts_fenced_json(self) -> None:
        self.assertEqual(parse_json_object('```json\n{"ok": true}\n```'), {"ok": True})

    def test_academic_group_excludes_department_specific_medicine_calendar(self) -> None:
        academic = next(group for group in GROUPS if group.name == "academic")
        document = {
            "source_types": ["academic_calendar"],
            "title": "MBChB Semester Dates 2026-27",
            "url": "https://medicine-vet-medicine.ed.ac.uk/mbchb.pdf",
        }
        self.assertFalse(document_matches_group(document, academic))

    def test_fake_extraction_produces_valid_standard_document(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            fake = FakeSolar()
            result = extract_all(
                self.documents,
                fake.complete_json,
                "University of Bristol",
                "2026/27",
                "Study Abroad",
                "2026-07-12",
                Path(temp),
            )
            validate_document(result, load_json(DEFAULT_SCHEMA))
            self.assertEqual(result["university"]["city"], "Bristol")
            self.assertEqual(result["exchange_program"]["academic_year"], "2026/27")
            self.assertEqual(len(result["source_links"]), 2)
            self.assertEqual(result["unverified_items"][0]["reason"], "only_in_unofficial_sources")

    def test_extraction_resumes_from_cached_partial(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            run_dir = Path(temp)
            fake = FakeSolar()
            first = extract_all(
                self.documents, fake.complete_json, "University of Bristol", "2026/27",
                "Study Abroad", "2026-07-12", run_dir,
            )
            second_fake = FakeSolar()
            second = extract_all(
                self.documents, second_fake.complete_json, "University of Bristol", "2026/27",
                "Study Abroad", "2026-07-12", run_dir,
            )
            self.assertEqual(second_fake.index, 0)
            self.assertEqual(first, second)

    def test_manual_sources_are_preserved_in_additional_requirements(self) -> None:
        result = assemble_standard_document(
            {}, self.documents, "University of Bristol", "2026/27", "Study Abroad", "2026-07-12"
        )
        manual = result["exchange_program"]["additional_requirements"]["manual_sources"]
        self.assertEqual(manual[0]["local_path"], "manual/report.doc")

    def test_string_additional_requirements_are_normalized(self) -> None:
        result = assemble_standard_document(
            {"core": {"exchange_program": {"additional_requirements": "Contact the office."}}},
            self.documents,
            "University of Bristol",
            "2026/27",
            "Study Abroad",
            "2026-07-12",
        )
        self.assertEqual(
            result["exchange_program"]["additional_requirements"]["extracted_notes"],
            "Contact the office.",
        )

    def test_model_type_variants_are_normalized(self) -> None:
        result = assemble_standard_document(
            {
                "core": {
                    "university": {"facilities": "Library and gym"},
                    "exchange_program": {"course_restrictions": "None specified"},
                },
                "application": {
                    "language_requirements": [{
                        "language": "English",
                        "test_type": "Cambridge C1",
                        "overall_score": "Grade B",
                        "score_details": "No component minimum published",
                        "exemption_conditions": ["Native speaker", "English-medium degree"],
                    }]
                },
            },
            self.documents,
            "University of Bristol",
            "2026/27",
            "Study Abroad",
            "2026-07-12",
        )
        self.assertEqual(result["university"]["facilities"], ["Library and gym"])
        self.assertEqual(result["exchange_program"]["course_restrictions"], ["None specified"])
        language = result["language_requirements"][0]
        self.assertIsNone(language["overall_score"])
        self.assertEqual(language["score_details"]["overall_requirement"], "Grade B")
        validate_document(result, load_json(DEFAULT_SCHEMA))

    def test_course_registration_note_objects_become_text(self) -> None:
        result = assemble_standard_document(
            {
                "academic": {
                    "exchange_program_updates": {
                        "course_registration_notes": [{
                            "note": "Take 60 credits per semester.",
                            "source_url": "https://example.edu/courses",
                        }]
                    }
                }
            },
            self.documents,
            "University of Edinburgh",
            "2026/27",
            "International Exchange",
            "2026-07-13",
        )
        notes = result["exchange_program"]["course_registration_notes"]
        self.assertIn("Take 60 credits", notes)
        self.assertIn("https://example.edu/courses", notes)
        validate_document(result, load_json(DEFAULT_SCHEMA))

    def test_contract_extras_are_cleaned_and_nested_unverified_is_moved(self) -> None:
        result = assemble_standard_document(
            {
                "core": {
                    "university": {
                        "source_url": "https://example.edu/about",
                        "unverified_items": [{
                            "category": "location",
                            "field_name": "city",
                            "reason": "not_found",
                        }],
                    },
                    "exchange_program": {
                        "source_url": "https://example.edu/exchange",
                        "unexpected_note": "Preserve this model output.",
                    },
                }
            },
            self.documents,
            "ICHEC Brussels Management School",
            "2026/27",
            "Incoming Exchange",
            "2026-07-13",
        )
        self.assertNotIn("source_url", result["university"])
        self.assertNotIn("source_url", result["exchange_program"])
        self.assertEqual(result["unverified_items"][0]["field_name"], "city")
        extras = result["exchange_program"]["additional_requirements"]["model_extra_fields"]
        self.assertEqual(extras["exchange_program.unexpected_note"], "Preserve this model output.")
        validate_document(result, load_json(DEFAULT_SCHEMA))

    def test_string_null_date_becomes_json_null(self) -> None:
        result = assemble_standard_document(
            {"academic": {"academic_periods": [{
                "period_type": "semester",
                "start_date": "2026-09-01",
                "end_date": "null",
            }]}},
            self.documents,
            "University of Edinburgh",
            "2026/27",
            "International Exchange",
            "2026-07-13",
        )
        self.assertIsNone(result["academic_periods"][0]["end_date"])
        validate_document(result, load_json(DEFAULT_SCHEMA))


def unverified(field_name: str, details: str | None = None) -> dict[str, object]:
    return {"category": "general", "field_name": field_name, "reason": "ambiguous", "details": details}


class UnverifiedItemShapeTests(unittest.TestCase):
    """Same real strings and same priority as web/tests/present-fact.golden.test.ts:
    a genuinely unverified item being dropped is a worse failure than noise slipping
    through, so that direction is checked first and on its own.
    """

    genuine_items = [
        unverified("교환학생 선발 인원(quota)"),
        unverified("정확한 GPA 기준"),
        unverified("비자 발급 소요 기간"),
        unverified("IU 학점 인정 기준"),
        unverified("Galápagos 캠퍼스 프로그램의 구체적인 지원 절차"),
    ]

    def test_never_drops_a_genuinely_unverified_noun_phrase(self) -> None:
        cleaned = clean_unverified(self.genuine_items)
        self.assertEqual(len(cleaned), len(self.genuine_items))

    def test_does_not_judge_a_noun_phrase_by_its_parenthetical_content_alone(self) -> None:
        self.assertTrue(is_unverified_item_shape_valid("교환학생 선발 인원(quota)", None))

    def test_drops_misclassified_confirmed_facts_and_summaries(self) -> None:
        items = [
            unverified("SDU Fitness", "월 149 DKK로 이용 가능."),
            unverified("Cumbayá 캠퍼스는 2,850m 고도에 위치하며, 역사적 중심지가 잘 보존된 도시입니다."),
            unverified("한눈에 보기", "헬싱키 대학교는 핀란드의 수도 헬싱키에 위치한 종합대학으로"),
            *self.genuine_items,
        ]
        cleaned = clean_unverified(items)
        cleaned_field_names = {row["field_name"] for row in cleaned}
        self.assertNotIn("SDU Fitness", cleaned_field_names)
        self.assertNotIn("한눈에 보기", cleaned_field_names)
        self.assertEqual(len(cleaned), len(self.genuine_items))

    def test_passes_the_etl_field_status_template(self) -> None:
        self.assertTrue(
            is_unverified_item_shape_valid("academic_periods", "공식 근거 기반 구조화 값 추가 확인 필요")
        )

    def test_does_not_treat_a_predicate_marker_used_as_a_bare_noun_modifier_as_an_assertion(self) -> None:
        for field_name in (
            "기숙사 식사 제공 여부",
            "Level 2 트랙의 정확한 수강 가능 과목 목록",
            "Level 2 트랙의 정확한 학기 운영 기간",
            "교환학생 수강신청 시 학점 제한 및 최대 수강 가능 과목 수",
        ):
            self.assertTrue(is_unverified_item_shape_valid(field_name, None), field_name)

    def test_still_drops_the_same_marker_when_actually_conjugated_as_a_predicate(self) -> None:
        self.assertFalse(is_unverified_item_shape_valid("캠퍼스는 시내 중심가에 위치한 대학으로", None))

    def test_does_not_flag_a_word_reused_once_across_two_clauses(self) -> None:
        self.assertTrue(is_unverified_item_shape_valid("교환학생 학점 인정 절차 및 학점 상한", None))

    def test_collapses_a_proliferation_chain_to_the_shortest_original(self) -> None:
        base = "교환학생 선발 후 수업 성적 인정 결과 발표"
        extension_words = [
            "시기", "방식", "확인", "절차", "기준", "일정", "안내", "공지", "여부", "방법",
            "조건", "사유", "형식", "단계", "범위", "시점", "구분", "항목", "내용", "현황",
        ]
        current = base
        chain: list[str] = []
        for word in extension_words:
            current = f"{current} {word}"
            chain.append(current)
        self.assertEqual(chain[0], "교환학생 선발 후 수업 성적 인정 결과 발표 시기")

        cleaned = clean_unverified([unverified(item) for item in chain])
        self.assertEqual([row["field_name"] for row in cleaned], [chain[0]])

    def test_drops_a_single_item_whose_own_words_repeat(self) -> None:
        cleaned = clean_unverified([unverified("교환학생 선발 후 수업 성적 인정 결과 발표 결과 발표 시기")])
        self.assertEqual(cleaned, [])

    def test_tracks_dropped_items_for_reporting(self) -> None:
        reset_dropped_unverified_items()
        clean_unverified([unverified("SDU Fitness", "월 149 DKK로 이용 가능.")])
        dropped = dropped_unverified_items()
        self.assertEqual(len(dropped), 1)
        self.assertEqual(dropped[0]["field_name"], "SDU Fitness")


if __name__ == "__main__":
    unittest.main()
