from __future__ import annotations

import unittest

from run_pipeline import expected_row_counts, manifest_fingerprint, slugify, stage_enabled


class RunPipelineTests(unittest.TestCase):
    def test_slugify(self):
        self.assertEqual(slugify("University of Bristol"), "university_of_bristol")

    def test_stage_range(self):
        self.assertFalse(stage_enabled("discover", "collect", "quality"))
        self.assertTrue(stage_enabled("collect", "collect", "quality"))
        self.assertTrue(stage_enabled("quality", "collect", "quality"))
        self.assertFalse(stage_enabled("save", "collect", "quality"))

    def test_manifest_fingerprint_changes_with_content(self):
        config = {
            "university_name": "Example University",
            "academic_year": "2026/27",
            "program_name": "Study Abroad",
        }
        first = {"documents": [{"status": "succeeded", "content_sha256": "a"}]}
        second = {"documents": [{"status": "succeeded", "content_sha256": "b"}]}
        self.assertNotEqual(manifest_fingerprint(first, config), manifest_fingerprint(second, config))


if __name__ == "__main__":
    unittest.main()
