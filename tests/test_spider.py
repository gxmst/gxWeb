import hashlib
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

import spider


class WorkingDirectory:
    def __init__(self, path):
        self.path = path
        self.previous = None

    def __enter__(self):
        self.previous = os.getcwd()
        os.chdir(self.path)
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        os.chdir(self.previous)


class AtomicWriteTests(unittest.TestCase):
    def test_atomic_save_json_returns_true_on_success(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "data.json"

            self.assertTrue(spider.atomic_save_json(str(target), {"ok": True}))
            self.assertEqual(json.loads(target.read_text(encoding="utf-8")), {"ok": True})

    def test_atomic_save_json_propagates_replace_failure_and_keeps_old_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "data.json"
            target.write_text('{"old": true}', encoding="utf-8")

            with mock.patch.object(spider.os, "replace", side_effect=OSError("disk failure")):
                with self.assertRaisesRegex(OSError, "disk failure"):
                    spider.atomic_save_json(str(target), {"new": True})

            self.assertEqual(target.read_text(encoding="utf-8"), '{"old": true}')
            self.assertEqual(list(Path(tmp).glob("*.tmp")), [])


class TranslationCacheTests(unittest.TestCase):
    def setUp(self):
        self.old_cache = spider._translate_cache
        self.old_dirty = spider._translate_dirty
        spider._translate_cache = {}
        spider._translate_dirty = False

    def tearDown(self):
        spider._translate_cache = self.old_cache
        spider._translate_dirty = self.old_dirty

    def test_batch_translation_failure_falls_back_without_caching_original(self):
        with mock.patch.object(
            spider, "_translate_text", side_effect=RuntimeError("translator unavailable")
        ):
            result = spider.translate_batch(["hello"], max_workers=1)

        key = hashlib.md5(b"hello").hexdigest()
        self.assertEqual(result, {"hello": "hello"})
        self.assertNotIn(key, spider._translate_cache)
        self.assertFalse(spider._translate_dirty)

    def test_http_translation_parses_joined_segments(self):
        response = mock.Mock()
        response.json.return_value = [[['你', 'you'], ['好', 'good']], None, 'en']
        session = mock.Mock()
        session.get.return_value = response

        with mock.patch.object(spider, "get_session", return_value=session):
            self.assertEqual(spider._translate_text("hello"), "你好")

        response.raise_for_status.assert_called_once()

    def test_persist_failure_keeps_dirty_flag_for_retry(self):
        spider._translate_cache = {"key": "value"}
        spider._translate_dirty = True

        with mock.patch.object(spider, "atomic_save_json", side_effect=OSError("read only")):
            with self.assertRaisesRegex(OSError, "read only"):
                spider._persist_translate_cache()

        self.assertTrue(spider._translate_dirty)

    def test_persist_success_clears_dirty_flag(self):
        spider._translate_cache = {"key": "value"}
        spider._translate_dirty = True

        with mock.patch.object(spider, "atomic_save_json", return_value=True):
            self.assertTrue(spider._persist_translate_cache())

        self.assertFalse(spider._translate_dirty)


class LastKnownGoodTests(unittest.TestCase):
    def test_startup_recovers_bounded_news_snapshots(self):
        finance_data = {
            "last_updated": 123,
            "news_list": [
                {"content": "sina", "source": "sina", "category": "news", "raw_time": 3},
                {"content": "rss", "source": "BBC", "category": "foreign", "raw_time": 2},
                {"content": "tech", "source": "hn", "category": "tech", "raw_time": 1},
                {"broken": True},
            ],
        }
        with tempfile.TemporaryDirectory() as tmp, WorkingDirectory(tmp):
            public = Path("public")
            public.mkdir()
            (public / "finance-news.json").write_text(
                json.dumps(finance_data), encoding="utf-8"
            )

            app = spider.SpiderApp()

        self.assertEqual([item["content"] for item in app.sina_news], ["sina"])
        self.assertEqual([item["content"] for item in app.rss_news], ["rss"])
        self.assertEqual([item["content"] for item in app.tech_news], ["tech"])

    def test_source_merge_retains_old_blocks_missing_from_partial_result(self):
        app = spider.SpiderApp.__new__(spider.SpiderApp)
        old = [
            {"content": "old hn", "source": "hn", "raw_time": 1},
            {"content": "old v2ex", "source": "v2ex", "raw_time": 1},
        ]
        fresh = [{"content": "new hn", "source": "hn", "raw_time": 2}]

        merged = app._merge_by_source(old, fresh, 10)

        self.assertEqual([item["content"] for item in merged], ["new hn", "old v2ex"])

    def test_empty_job_is_reported_failed_without_advancing_last_success(self):
        with tempfile.TemporaryDirectory() as tmp, WorkingDirectory(tmp):
            Path("public").mkdir()
            app = spider.SpiderApp()
            with mock.patch.object(app, "_persist_pipeline_status", return_value=True):
                ok, result = app._run_job(
                    "rss",
                    lambda: [],
                    success_if=bool,
                    failure_message="empty; keep old",
                )

        state = app._pipeline_status["jobs"]["rss"]
        self.assertFalse(ok)
        self.assertEqual(result, [])
        self.assertIsNone(state["last_success"])
        self.assertEqual(state["last_error"], "empty; keep old")
        self.assertIsNotNone(state["last_attempt"])
        self.assertIsInstance(state["duration"], float)
        self.assertEqual(state["count"], 0)


class RuntimeReliabilityTests(unittest.TestCase):
    def test_weather_atomic_write_failure_is_not_swallowed(self):
        response = mock.Mock()
        response.json.return_value = {
            "current_weather": {"temperature": 22, "weathercode": 0}
        }
        session = mock.Mock()
        session.get.return_value = response

        with mock.patch.object(spider, "get_session", return_value=session), mock.patch.object(
            spider, "atomic_save_text", side_effect=OSError("no space")
        ):
            with self.assertRaisesRegex(OSError, "no space"):
                spider.fetch_weather()

    def test_dead_worker_makes_run_raise_for_nonzero_process_exit(self):
        class DeadThread:
            def __init__(self, target, name, daemon):
                self.name = name

            def start(self):
                return None

            def is_alive(self):
                return False

            def join(self, timeout=None):
                return None

        with tempfile.TemporaryDirectory() as tmp, WorkingDirectory(tmp):
            Path("public").mkdir()
            app = spider.SpiderApp()
            with mock.patch.object(spider.threading, "Thread", DeadThread), mock.patch.object(
                spider.signal, "signal"
            ):
                with self.assertRaisesRegex(RuntimeError, "fast worker"):
                    app.run()

    def test_running_job_timeout_is_marked_for_watchdog_restart(self):
        with tempfile.TemporaryDirectory() as tmp, WorkingDirectory(tmp):
            Path("public").mkdir()
            app = spider.SpiderApp()
            app.job_timeout_seconds = 10
            app._pipeline_status["jobs"]["tech"].update(
                {"running": True, "last_attempt": int(time.time()) - 20}
            )
            with mock.patch.object(app, "_persist_pipeline_status", return_value=True):
                stalled = app._mark_stalled_job(now=time.time())

        self.assertEqual(stalled[0], "tech")
        state = app._pipeline_status["jobs"]["tech"]
        self.assertFalse(state["running"])
        self.assertIn("触发进程重启", state["last_error"])
        self.assertGreaterEqual(state["duration"], 20)


if __name__ == "__main__":
    unittest.main()
