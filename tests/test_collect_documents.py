from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from collect_documents import (
    collect_all,
    document_id,
    infer_manual_source_type,
    select_manual_sources,
    select_sources,
)
from validate_university import load_json, validate_document


MANIFEST_SCHEMA = Path(__file__).parents[1] / "schemas" / "collection_manifest.schema.json"


def html_fixture(url: str):
    return f"# HTML fixture\n\nSource: {url}", ".md", {"success": True, "data": {"markdown": "fixture"}}


def pdf_fixture(url: str):
    return f"<h1>PDF fixture</h1><p>{url}</p>", ".html", {"content": {"html": "fixture"}}


def local_fixture(path: Path):
    return f"<p>Local fixture: {path.name}</p>", ".html", {"content": {"html": "fixture"}}


class CollectDocumentsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.discovery = {
            "university_name": "Example University",
            "primary_sources": {
                "incoming_exchange": {
                    "source_type": "incoming_exchange",
                    "title": "Incoming",
                    "url": "https://example.edu/incoming/",
                    "is_pdf": False,
                },
                "fact_sheet": {
                    "source_type": "fact_sheet",
                    "title": "Fact sheet",
                    "url": "https://example.edu/facts.pdf",
                    "is_pdf": True,
                },
                "application_guide": {
                    "source_type": "application_guide",
                    "title": "Incoming duplicate",
                    "url": "https://example.edu/incoming/",
                    "is_pdf": False,
                },
                "housing": None,
            },
            "candidates": [],
        }

    def test_select_sources_deduplicates_urls_and_merges_types(self) -> None:
        sources = select_sources(self.discovery, False)
        self.assertEqual(len(sources), 2)
        incoming = next(item for item in sources if not item["is_pdf"])
        self.assertEqual(set(incoming["source_types"]), {"incoming_exchange", "application_guide"})

    def test_collection_writes_content_raw_response_and_manifest_records(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp)
            manifest = collect_all(self.discovery, output, html_fixture, pdf_fixture)
            self.assertEqual(manifest["summary"]["succeeded"], 2)
            self.assertEqual(manifest["summary"]["failed"], 0)
            validate_document(manifest, load_json(MANIFEST_SCHEMA))
            for item in manifest["documents"]:
                self.assertTrue(Path(item["content_path"]).exists())
                self.assertTrue(Path(item["raw_response_path"]).exists())
                self.assertEqual(len(item["content_sha256"]), 64)

    def test_second_collection_skips_existing_documents(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp)
            collect_all(self.discovery, output, html_fixture, pdf_fixture)
            manifest = collect_all(self.discovery, output, html_fixture, pdf_fixture)
            self.assertEqual(manifest["summary"]["skipped"], 2)

    def test_document_id_is_stable(self) -> None:
        self.assertEqual(document_id("https://example.edu/a"), document_id("https://example.edu/a"))
        self.assertEqual(len(document_id("https://example.edu/a")), 16)

    def test_manual_source_type_inference(self) -> None:
        self.assertEqual(infer_manual_source_type("브리스톨 수학보고서.doc"), "student_report")
        self.assertEqual(infer_manual_source_type("수학보고서.doc"), "student_report")
        self.assertEqual(infer_manual_source_type("2022학년도 파견 학생.doc"), "student_report")
        self.assertEqual(infer_manual_source_type("Study_Abroad_Guide.pdf"), "fact_sheet")

    def test_manual_source_discovery_preserves_original(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            inbox = Path(temp) / "inbox"
            inbox.mkdir()
            report = inbox / "수학보고서.doc"
            report.write_bytes(b"legacy-word-fixture")
            sources = select_manual_sources(inbox)
            self.assertEqual(len(sources), 1)
            self.assertEqual(sources[0]["source_types"], ["student_report"])
            self.assertEqual(report.read_bytes(), b"legacy-word-fixture")

    def test_manual_source_is_added_to_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            inbox = root / "inbox"
            output = root / "parsed"
            inbox.mkdir()
            (inbox / "수학보고서.doc").write_bytes(b"legacy-word-fixture")
            manual_sources = select_manual_sources(inbox)
            manifest = collect_all(
                self.discovery,
                output,
                html_fixture,
                pdf_fixture,
                manual_sources=manual_sources,
                local_collect=local_fixture,
            )
            manual = next(item for item in manifest["documents"] if item["source_kind"] == "manual")
            self.assertIsNone(manual["url"])
            self.assertTrue(manual["local_path"].endswith("수학보고서.doc"))
            self.assertEqual(manual["status"], "succeeded")
            validate_document(manifest, load_json(MANIFEST_SCHEMA))


if __name__ == "__main__":
    unittest.main()
