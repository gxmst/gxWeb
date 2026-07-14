import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import spider  # noqa: E402


class SpiderUtilityTests(unittest.TestCase):
    def test_sanitize_url_allows_only_http_and_https(self):
        self.assertEqual(spider.sanitize_url("https://example.com/a"), "https://example.com/a")
        self.assertEqual(spider.sanitize_url("http://example.com"), "http://example.com")
        self.assertEqual(spider.sanitize_url("javascript:alert(1)"), "")
        self.assertEqual(spider.sanitize_url("//example.com/path"), "")

    def test_build_ticker_entry_calculates_change(self):
        config = {
            "symbol": "demo",
            "name": "Demo",
            "category": "test",
            "decimals": 2,
        }

        entry = spider.build_ticker_entry(config, price=105, previous_close=100, source="fixture")

        self.assertEqual(entry["price"], "105.00")
        self.assertEqual(entry["change"], "+5.00%")
        self.assertEqual(entry["source"], "fixture")

    def test_build_ticker_entry_rejects_missing_previous_close(self):
        config = {
            "symbol": "demo",
            "name": "Demo",
            "category": "test",
            "decimals": 2,
        }

        with self.assertRaises(ValueError):
            spider.build_ticker_entry(config, price=100, previous_close=0)

    def test_atomic_save_json_replaces_with_valid_json(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "payload.json"
            target.write_text('{"old": true}', encoding="utf-8")

            spider.atomic_save_json(str(target), {"new": [1, 2, 3]})

            self.assertEqual(json.loads(target.read_text(encoding="utf-8")), {"new": [1, 2, 3]})
            self.assertFalse(Path(f"{target}.tmp").exists())


if __name__ == "__main__":
    unittest.main()
