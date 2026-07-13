from __future__ import annotations

import unittest

from quality_check import clean_document
from validate_university import DEFAULT_SCHEMA, load_json, validate_document


class QualityCheckTests(unittest.TestCase):
    def base_document(self):
        return {
            "schema_version": "1.0.0",
            "research_date": "2026-07-12",
            "university": {"university_name": "Example University", "country": None, "city": None},
            "exchange_program": {"academic_year": "2026/27", "program_name": "Study Abroad"},
            "application_deadlines": [],
            "language_requirements": [],
            "academic_periods": [],
            "housing_options": [],
            "estimated_costs": [],
            "required_documents": [],
            "source_links": [],
            "unverified_items": [],
        }

    def test_unsupported_false_guarantee_becomes_null(self):
        document = self.base_document()
        document["housing_options"] = [{
            "housing_category": "Residence",
            "is_guaranteed": False,
            "guarantee_conditions": None,
            "source_url": "https://example.edu/housing",
        }]
        cleaned, report = clean_document(document)
        self.assertIsNone(cleaned["housing_options"][0]["is_guaranteed"])
        self.assertEqual(report["summary"]["auto_fixed"], 1)
        validate_document(cleaned, load_json(DEFAULT_SCHEMA))

    def test_exact_duplicates_are_removed(self):
        document = self.base_document()
        row = {"cost_type": "food", "amount_min": 100, "currency": "GBP", "source_url": None}
        document["estimated_costs"] = [row, dict(row)]
        cleaned, report = clean_document(document)
        self.assertEqual(len(cleaned["estimated_costs"]), 1)
        self.assertTrue(any(item["code"] == "exact_duplicates_removed" for item in report["issues"]))

    def test_invalid_cost_range_is_swapped(self):
        document = self.base_document()
        document["estimated_costs"] = [{
            "cost_type": "rent", "amount_min": 800, "amount_max": 500,
            "currency": "GBP", "source_url": "https://example.edu/costs",
        }]
        cleaned, _ = clean_document(document)
        self.assertEqual(cleaned["estimated_costs"][0]["amount_min"], 500)
        self.assertEqual(cleaned["estimated_costs"][0]["amount_max"], 800)


if __name__ == "__main__":
    unittest.main()
