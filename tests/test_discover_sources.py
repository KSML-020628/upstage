from __future__ import annotations

import unittest
from pathlib import Path

from discover_sources import (
    canonicalize_url,
    discover_sources,
    is_official_url,
    load_fixture,
    normalize_domain,
    score_candidate,
)


FIXTURE = Path(__file__).parent / "fixtures" / "bristol_search_results.json"


class DiscoverSourcesTests(unittest.TestCase):
    def test_domain_normalization_and_subdomains(self) -> None:
        self.assertEqual(normalize_domain("https://www.bristol.ac.uk/"), "bristol.ac.uk")
        self.assertTrue(is_official_url("https://students.bristol.ac.uk/a", "bristol.ac.uk"))
        self.assertFalse(is_official_url("https://fakebristol.ac.uk/a", "bristol.ac.uk"))

    def test_url_canonicalization_removes_tracking_and_fragment(self) -> None:
        result = canonicalize_url("https://EXAMPLE.edu/a?utm_source=x&id=2#section")
        self.assertEqual(result, "https://example.edu/a?id=2")

    def test_fixture_discovery_classifies_official_sources(self) -> None:
        result = discover_sources(
            "University of Bristol",
            "bristol.ac.uk",
            "2026/27",
            load_fixture(FIXTURE),
            provider="fixture",
        )
        self.assertGreaterEqual(len(result["candidates"]), 6)
        self.assertTrue(all(item["is_official"] for item in result["candidates"]))
        self.assertTrue(result["primary_sources"]["fact_sheet"]["is_pdf"])
        self.assertNotIn("utm_source", result["primary_sources"]["fact_sheet"]["url"])

    def test_calendar_ranking_penalizes_unrelated_fees_page(self) -> None:
        dates = score_candidate(
            "academic_calendar",
            "Study abroad dates",
            "Key dates for incoming students",
            "https://www.bristol.ac.uk/centre/study-abroad-dates/",
            True,
        )
        fees = score_candidate(
            "academic_calendar",
            "IFP Fees and dates",
            "Tuition fees and funding",
            "https://www.bristol.ac.uk/academic-language/fees-funding/",
            True,
        )
        self.assertGreater(dates, fees)

    def test_calendar_ranking_penalizes_department_specific_medicine(self) -> None:
        general = score_candidate(
            "academic_calendar",
            "Academic year 2026/27 - Semester Dates",
            "University semester dates",
            "https://semester-dates.ed.ac.uk/202627",
            True,
        )
        medicine = score_candidate(
            "academic_calendar",
            "MBChB Semester Dates 2026-27",
            "Medical School dates",
            "https://medicine-vet-medicine.ed.ac.uk/mbchb-2026.pdf",
            True,
        )
        self.assertGreater(general, medicine)

    def test_course_ranking_prefers_subject_guide(self) -> None:
        guide = score_candidate(
            "course_catalog",
            "What you can study at Bristol",
            "Subjects and study guides for exchange students",
            "https://www.bristol.ac.uk/study/subjects-and-study-guides/",
            True,
        )
        generic = score_candidate(
            "course_catalog",
            "Study Abroad programmes at Bristol",
            "Programme overview",
            "https://www.bristol.ac.uk/study-abroad/",
            True,
        )
        self.assertGreater(guide, generic)


if __name__ == "__main__":
    unittest.main()
