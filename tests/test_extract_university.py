from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from extract_university import (
    GROUPS,
    assemble_standard_document,
    document_matches_group,
    extract_all,
    parse_json_object,
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


if __name__ == "__main__":
    unittest.main()
