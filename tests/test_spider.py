import hashlib
import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

import crawler.app
import crawler.feeds
import crawler.io_utils
import crawler.markets
import crawler.media
import crawler.tech
import crawler.translator
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

    def test_atomic_save_json_compact_omits_whitespace(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "compact.json"

            self.assertTrue(spider.atomic_save_json(str(target), {"a": 1, "b": [2, 3]}, compact=True))
            self.assertEqual(target.read_text(encoding="utf-8"), '{"a":1,"b":[2,3]}')

    def test_atomic_save_json_propagates_replace_failure_and_keeps_old_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "data.json"
            target.write_text('{"old": true}', encoding="utf-8")

            with mock.patch.object(crawler.io_utils.os, "replace", side_effect=OSError("disk failure")):
                with self.assertRaisesRegex(OSError, "disk failure"):
                    spider.atomic_save_json(str(target), {"new": True})

            self.assertEqual(target.read_text(encoding="utf-8"), '{"old": true}')
            self.assertEqual(list(Path(tmp).glob("*.tmp")), [])

    def test_load_cache_with_legacy_migrates_old_public_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            primary = Path(tmp) / "state" / "cache.json"
            legacy = Path(tmp) / "public" / "cache.json"
            legacy.parent.mkdir()
            legacy.write_text('{"k": "v"}', encoding="utf-8")

            loaded = crawler.io_utils.load_cache_with_legacy(str(primary), str(legacy), default={})
            self.assertEqual(loaded, {"k": "v"})


class TranslationCacheTests(unittest.TestCase):
    def setUp(self):
        self.old_cache = crawler.translator._translate_cache
        self.old_dirty = crawler.translator._translate_dirty
        crawler.translator._translate_cache = {}
        crawler.translator._translate_dirty = False

    def tearDown(self):
        crawler.translator._translate_cache = self.old_cache
        crawler.translator._translate_dirty = self.old_dirty

    def test_batch_translation_failure_falls_back_without_caching_original(self):
        with mock.patch.object(
            crawler.translator, "_translate_text", side_effect=RuntimeError("translator unavailable")
        ):
            result = spider.translate_batch(["hello"], max_workers=1)

        key = hashlib.md5(b"hello").hexdigest()
        self.assertEqual(result, {"hello": "hello"})
        self.assertNotIn(key, crawler.translator._translate_cache)
        self.assertFalse(crawler.translator._translate_dirty)

    def test_http_translation_parses_joined_segments(self):
        response = mock.Mock()
        response.json.return_value = [[["你", "you"], ["好", "good"]], None, "en"]
        session = mock.Mock()
        session.get.return_value = response

        with mock.patch.object(crawler.translator, "get_session", return_value=session):
            self.assertEqual(crawler.translator._translate_text("hello"), "你好")

        response.raise_for_status.assert_called_once()

    def test_persist_failure_keeps_dirty_flag_for_retry(self):
        crawler.translator._translate_cache = {"key": "value"}
        crawler.translator._translate_dirty = True

        with mock.patch.object(crawler.translator, "atomic_save_json", side_effect=OSError("read only")):
            with self.assertRaisesRegex(OSError, "read only"):
                spider._persist_translate_cache()

        self.assertTrue(crawler.translator._translate_dirty)

    def test_persist_success_clears_dirty_flag(self):
        crawler.translator._translate_cache = {"key": "value"}
        crawler.translator._translate_dirty = True

        with mock.patch.object(crawler.translator, "atomic_save_json", return_value=True):
            self.assertTrue(spider._persist_translate_cache())

        self.assertFalse(crawler.translator._translate_dirty)


class NewsImportanceTests(unittest.TestCase):
    def test_sina_parser_publishes_score_and_reason_from_current_fields(self):
        response = mock.Mock()
        response.json.return_value = {
            "result": {
                "data": {
                    "feed": {
                        "list": [
                            {
                                "id": 9981,
                                "rich_text": "焦点快讯",
                                "create_time": "2026-07-16 20:00:00",
                                "is_focus": 1,
                                "top_value": 0,
                            }
                        ]
                    }
                }
            }
        }
        session = mock.Mock()
        session.get.return_value = response

        with mock.patch.object(crawler.feeds, "get_session", return_value=session):
            news = spider._fetch_sina_page(1)

        self.assertTrue(news[0]["is_important"])
        self.assertEqual(news[0]["id"], "sina-9981")
        self.assertEqual(news[0]["importance_score"], 100)
        self.assertEqual(news[0]["importance_reason"], "新浪焦点")

    def test_current_sina_focus_field_marks_news_important(self):
        score, reason = spider.classify_news_importance(
            "普通快讯文本", {"is_focus": 1, "top_value": 0}
        )

        self.assertEqual(score, 100)
        self.assertEqual(reason, "新浪焦点")

    def test_current_sina_top_value_marks_news_important(self):
        score, reason = spider.classify_news_importance(
            "普通快讯文本", {"is_focus": 0, "top_value": "20"}
        )

        self.assertEqual(score, 95)
        self.assertEqual(reason, "新浪置顶")

    def test_high_confidence_rule_returns_explainable_score(self):
        score, reason = spider.classify_news_importance(
            "美联储宣布降息25个基点，基准利率降至4.25%。"
        )

        self.assertGreaterEqual(score, spider.IMPORTANCE_THRESHOLD)
        self.assertEqual(reason, "央行与利率决议")

    def test_routine_market_move_is_not_marked_important(self):
        score, reason = spider.classify_news_importance(
            "纳斯达克指数期货跌幅扩大，最新下跌1%。"
        )

        self.assertEqual(score, 0)
        self.assertEqual(reason, "")


class MarketTickerTests(unittest.TestCase):
    def test_market_tickers_replace_dead_nikkei_and_kospi_codes(self):
        sina_codes = {item["sina"] for item in spider.MARKET_TICKERS if item.get("sina")}
        self.assertIn("b_NKY", sina_codes)
        self.assertIn("b_KOSPI", sina_codes)
        self.assertNotIn("b_NIKKEI225", sina_codes)
        self.assertNotIn("b_KS200F", sina_codes)

    def test_global_b_indices_parse_both_full_and_six_field_sina_rows(self):
        payload = "\n".join([
            'var hq_str_b_NKY="日经225指数,61142.1300,322.77,0.53,2:12 AM,14:12:00,2026-11-13,14:30:01,61223.4100,60819.3600,61902.5000,61082.2300,0";',
            'var hq_str_b_TWSE="台湾台北指数,25580.32,-443.53,-1.70,9/26/2025,2025-09-26";',
        ])
        response = mock.Mock(text=payload)
        session = mock.Mock()
        session.get.return_value = response

        configs = [
            {"symbol": "n225", "name": "日经225", "category": "亚太", "decimals": 2, "sina": "b_NKY"},
            {"symbol": "twii", "name": "台湾加权", "category": "亚太", "decimals": 2, "sina": "b_TWSE"},
        ]
        with mock.patch.object(crawler.markets, "get_session", return_value=session):
            parsed = crawler.markets._fetch_sina_all(configs)

        self.assertEqual(parsed["n225"]["price"], "61142.13")
        self.assertEqual(parsed["n225"]["change"], "+0.53%")
        self.assertEqual(parsed["twii"]["price"], "25580.32")
        self.assertEqual(parsed["twii"]["change"], "-1.70%")


class RssFeedTests(unittest.TestCase):
    def setUp(self):
        self.old_retry = dict(crawler.feeds._rss_retry_state)
        crawler.feeds._rss_retry_state.clear()

    def tearDown(self):
        crawler.feeds._rss_retry_state.clear()
        crawler.feeds._rss_retry_state.update(self.old_retry)

    def test_undated_rss_entries_keep_zero_timestamp_and_failing_source_backs_off(self):
        rss_xml = (
            "<rss version='2.0'><channel><title>Demo</title>"
            "<item><title>Undated Headline</title><link>https://example.com/a</link></item>"
            "<item><title>Dated Headline</title><link>https://example.com/b</link>"
            "<pubDate>Sun, 08 Nov 2026 14:00:00 GMT</pubDate></item>"
            "</channel></rss>"
        )
        ok_resp = mock.Mock(status_code=200, text=rss_xml)
        fail_resp = mock.Mock(status_code=503)
        fail_resp.raise_for_status.side_effect = RuntimeError("503 service unavailable")

        session = mock.Mock()
        session.get.side_effect = lambda url, **kwargs: ok_resp if "good" in url else fail_resp
        sources = [
            {"name": "Good", "url": "https://good.example/rss"},
            {"name": "Bad", "url": "https://bad.example/rss"},
        ]

        with mock.patch.object(crawler.feeds, "get_session", return_value=session), mock.patch.object(
            crawler.feeds.time, "monotonic", return_value=100.0
        ):
            items = spider.fetch_rss_news(sources=sources)
            self.assertIn("Bad", crawler.feeds._rss_retry_state)
            self.assertEqual(crawler.feeds._rss_retry_state["Bad"]["until"], 700.0)

            session.get.reset_mock()
            spider.fetch_rss_news(sources=sources)
            called_urls = [call.args[0] for call in session.get.call_args_list]
            self.assertEqual(called_urls, ["https://good.example/rss"])

        self.assertEqual(len(items), 2)
        self.assertEqual(items[0]["raw_time"], 0)
        self.assertEqual(items[0]["time"], "")
        self.assertTrue(items[0]["id"].startswith("rss-"))
        self.assertEqual(items[1]["raw_time"], 1794146400)
        self.assertEqual(items[1]["time"], "22:00")


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
    def test_weather_coordinates_fall_back_when_environment_is_invalid(self):
        with mock.patch.dict(
            os.environ,
            {"WEATHER_LATITUDE": "north", "WEATHER_LONGITUDE": "999"},
        ):
            self.assertEqual(spider.get_weather_coordinates(), (41.80, 123.43))

    def test_weather_atomic_write_failure_is_not_swallowed(self):
        response = mock.Mock()
        response.json.return_value = {
            "current_weather": {"temperature": 22, "weathercode": 0}
        }
        session = mock.Mock()
        session.get.return_value = response

        with mock.patch.object(crawler.media, "get_session", return_value=session), mock.patch.object(
            crawler.media, "atomic_save_text", side_effect=OSError("no space")
        ):
            with self.assertRaisesRegex(OSError, "no space"):
                spider.fetch_weather()

        _, kwargs = session.get.call_args
        self.assertEqual(kwargs["params"]["latitude"], 41.80)
        self.assertEqual(kwargs["params"]["longitude"], 123.43)

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
            with mock.patch.object(crawler.app.threading, "Thread", DeadThread), mock.patch.object(
                crawler.app.signal, "signal"
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


class TechFetchRecoveryTests(unittest.TestCase):
    def test_empty_http_200_trends_preserve_all_previous_sources_and_do_not_write_cache(self):
        response = mock.Mock(status_code=200, text="<html><body>Maintenance</body></html>")
        response.json.return_value = []
        session = mock.Mock()
        session.get.return_value = response
        old = [
            {"id": source, "source": source, "content": f"old {source}", "raw_time": 1}
            for source in ("github", "hn", "v2ex")
        ]
        with mock.patch.object(crawler.tech, "get_session", return_value=session), mock.patch.object(
            crawler.tech, "fetch_github_trends", return_value=[]
        ), mock.patch.object(crawler.tech, "load_cache_with_legacy", return_value={}), mock.patch.object(
            crawler.tech, "atomic_save_json"
        ) as save, mock.patch.object(crawler.tech, "_persist_translate_cache", return_value=False):
            fresh = spider.fetch_tech_news()

        app = spider.SpiderApp.__new__(spider.SpiderApp)
        self.assertEqual(fresh, [])
        self.assertEqual(app._merge_by_source(old, fresh, 50), old)
        save.assert_not_called()

    def test_valid_hn_replaces_only_its_source_when_other_sources_are_empty(self):
        response = mock.Mock(status_code=200, text="""<rss version="2.0"><channel><title>HN</title>
            <item><title>Show HN: Useful project</title><link>https://example.com/project</link></item>
            </channel></rss>""")
        response.json.return_value = []
        session = mock.Mock()
        session.get.return_value = response
        old = [
            {"id": source, "source": source, "content": f"old {source}", "raw_time": 1}
            for source in ("github", "hn", "v2ex")
        ]
        with mock.patch.object(crawler.tech, "get_session", return_value=session), mock.patch.object(
            crawler.tech, "fetch_github_trends", return_value=[]
        ), mock.patch.object(crawler.tech, "load_cache_with_legacy", return_value={}), mock.patch.object(
            crawler.tech, "translate_batch", return_value={}
        ), mock.patch.object(crawler.tech, "_persist_translate_cache", return_value=False):
            fresh = spider.fetch_tech_news()

        app = spider.SpiderApp.__new__(spider.SpiderApp)
        merged = app._merge_by_source(old, fresh, 50)
        self.assertEqual([item["source"] for item in fresh], ["hn"])
        by_source = {item["source"]: item for item in merged}
        self.assertIn("Useful project", by_source["hn"]["content"])
        self.assertEqual(by_source["github"]["content"], "old github")
        self.assertEqual(by_source["v2ex"]["content"], "old v2ex")


class TechDataAndHtmlBuilderTests(unittest.TestCase):
    def test_structured_tech_builders_produce_plain_data_and_legacy_html(self):
        sections = [
            {
                "label": "Last 7 Days",
                "items": [
                    {
                        "full_name": "org/repo",
                        "stargazers_count": 2450,
                        "description": "Fast web UI",
                        "html_url": "https://github.com/org/repo",
                    }
                ],
            }
        ]
        with mock.patch.object(crawler.tech, "translate_batch", return_value={"Fast web UI": "快速 Web 界面"}):
            gh_summary, gh_data = spider.build_github_data(sections)
            gh_html = spider.build_github_html(sections)

        self.assertEqual(gh_data["brand"], "GitHub Trends")
        self.assertEqual(gh_data["sections"][0]["items"][0]["stars"], "2.5k")
        self.assertEqual(gh_data["sections"][0]["items"][0]["desc_zh"], "快速 Web 界面")
        self.assertNotIn("<div", gh_summary)
        self.assertIn("tech-card-item", gh_html)
        self.assertIn("★ 2.5k", gh_html)

        hn_summary, hn_data = spider.build_hn_data(
            [{"link": "https://news.ycombinator.com/item?id=1"}],
            ["Show HN: Demo"],
            {"Show HN: Demo": "展示 HN：演示"},
        )
        hn_html = spider.build_hn_html(
            [{"link": "https://news.ycombinator.com/item?id=1"}],
            ["Show HN: Demo"],
            {"Show HN: Demo": "展示 HN：演示"},
        )
        self.assertEqual(hn_data["brand"], "Hacker News")
        self.assertEqual(hn_data["sections"][0]["items"][0]["desc_zh"], "展示 HN：演示")
        self.assertIn("展示 HN：演示", hn_summary)
        self.assertIn("Hacker News", hn_html)

        v2_summary, v2_data = spider.build_v2ex_data(
            [{"id": 100, "title": "热门话题"}],
            [{"id": 101, "title": "最新话题"}],
        )
        v2ex_html = spider.build_v2ex_html(
            [{"id": 100, "title": "热门话题"}],
            [{"id": 101, "title": "最新话题"}],
        )
        self.assertEqual([sec["label"] for sec in v2_data["sections"]], ["Hot Topics", "Latest"])
        self.assertTrue(v2_data["sections"][0]["compact"])
        self.assertIn("热门话题", v2_summary)
        self.assertIn("Hot Topics", v2ex_html)
        self.assertIn("Latest", v2ex_html)


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


class ArchiveAndNotifierTests(unittest.TestCase):
    def test_tech_archive_accumulates_and_restart_restores_only_latest_sources(self):
        old = {"id": "old-hn", "content": "old", "source": "hn", "category": "tech", "raw_time": 100}
        new = {"id": "new-hn", "content": "new", "source": "hn", "category": "tech", "raw_time": 200}
        gh = {"id": "gh", "content": "GitHub", "source": "github", "category": "tech", "raw_time": 150}
        with tempfile.TemporaryDirectory() as tmp, WorkingDirectory(tmp):
            Path("public").mkdir()
            app = spider.SpiderApp()
            app.tech_news = [old, gh]
            app.tech_archive = [old, gh]
            app.last_wallpaper_date = spider.get_beijing_time().strftime("%Y-%m-%d")
            Path("public/bg_0.jpg").touch()
            with mock.patch.object(app, "_run_job", side_effect=lambda name, *a, **kw: (True, [new]) if name == "tech" else (False, [])), mock.patch.object(
                app, "_interruptible_sleep", side_effect=lambda seconds: setattr(app, "shutdown", True)
            ):
                app._slow_loop()
            app._publish_finance_news()
            restarted = spider.SpiderApp()
        self.assertEqual([n["id"] for n in restarted.tech_archive], ["new-hn", "gh", "old-hn"])
        self.assertEqual([n["id"] for n in restarted.tech_news], ["new-hn", "gh"])

    def test_slow_webhook_does_not_block_publish_and_queue_stays_bounded(self):
        started = threading.Event()
        release = threading.Event()

        def slow_post(*args, **kwargs):
            started.set()
            release.wait(5)
            return mock.Mock()

        notifier = spider.AlertNotifier("https://hooks.example.com/notify", queue_size=2)
        with mock.patch("crawler.notify.requests.post", side_effect=slow_post):
            try:
                self.assertTrue(notifier.send("first", "text", key="first"))
                self.assertTrue(started.wait(1))
                self.assertTrue(notifier.send("second", "text", key="second"))
                self.assertTrue(notifier.send("third", "text", key="third"))
                self.assertFalse(notifier.send("fourth", "text", key="fourth"))
                self.assertEqual(notifier._queue.qsize(), 2)
                with tempfile.TemporaryDirectory() as tmp, WorkingDirectory(tmp):
                    Path("public").mkdir()
                    app = spider.SpiderApp()
                    app.notifier = notifier
                    app.sina_news = [{"id": "n", "source": "sina", "content": "news", "raw_time": 1}]
                    self.assertTrue(app._publish_finance_news())
                    self.assertFalse(release.is_set())
            finally:
                release.set()
                notifier._queue.join()
                notifier.close()
        self.assertFalse(notifier.send("closed", "text"))

    def test_startup_recovers_and_merges_archive_snapshot(self):
        hot = {
            "last_updated": 200,
            "news_list": [
                {"id": "f-new", "content": "new post", "source": "linuxdo", "category": "community", "raw_time": 200},
            ],
        }
        arch = {
            "last_updated": 150,
            "news_list": [
                {"id": "f-old", "content": "old post", "source": "nodeseek", "category": "community", "raw_time": 100},
            ],
        }
        with tempfile.TemporaryDirectory() as tmp, WorkingDirectory(tmp):
            public = Path("public")
            public.mkdir()
            (public / "finance-news.json").write_text(json.dumps(hot), encoding="utf-8")
            (public / "news-archive.json").write_text(json.dumps(arch), encoding="utf-8")
            app = spider.SpiderApp()
            app._archive_dirty = True
            app._publish_finance_news()
            published_hot = json.loads((public / "finance-news.json").read_text(encoding="utf-8"))
            published_arch = json.loads((public / "news-archive.json").read_text(encoding="utf-8"))

        self.assertEqual(len(app.community_archive), 2)
        self.assertEqual(published_hot["archive_count"], 2)
        self.assertEqual([item["id"] for item in published_arch["news_list"]], ["f-new", "f-old"])

    def test_alert_notifier_deduplicates_breaking_news_and_failures(self):
        notifier = spider.AlertNotifier("https://hooks.example.com/notify", min_score=85, cooldown_seconds=60, failure_threshold=2)
        self.addCleanup(notifier.close)
        with mock.patch("crawler.notify.requests.post") as post:
            post.return_value.raise_for_status = mock.Mock()
            sent = notifier.notify_important_news([
                {"id": "low", "is_important": True, "importance_score": 70, "content": "minor"},
                {"id": "high", "is_important": True, "importance_score": 90, "importance_reason": "央行", "source": "sina", "content": "Fed cut"},
                {"id": "high", "is_important": True, "importance_score": 90, "source": "sina", "content": "Fed cut"},
            ])
            self.assertEqual(sent, 1)
            notifier._queue.join()
            notifier.record_job_result("rss", succeeded=False, error="err1")
            self.assertEqual(post.call_count, 1)
            notifier.record_job_result("rss", succeeded=False, error="err2")
            notifier._queue.join()
            self.assertEqual(post.call_count, 2)

    def test_bing_wallpaper_writes_metadata_json(self):
        import io
        from PIL import Image

        buf = io.BytesIO()
        Image.new("RGB", (32, 18), (12, 34, 56)).save(buf, "JPEG")
        jpeg_bytes = buf.getvalue()

        meta_resp = mock.Mock(
            json=mock.Mock(return_value={
                "images": [{"url": "/th?id=OHR.Test.jpg", "title": "测试山谷", "copyright": "© Bing", "startdate": "20261122"}]
            })
        )
        meta_resp.raise_for_status = mock.Mock()
        img_resp = mock.Mock(content=jpeg_bytes)
        img_resp.raise_for_status = mock.Mock()

        session = mock.Mock(get=mock.Mock(side_effect=[meta_resp, img_resp]))
        with tempfile.TemporaryDirectory() as tmp, WorkingDirectory(tmp), mock.patch.object(
            crawler.media, "get_session", return_value=session
        ):
            Path("public").mkdir()
            count = spider.fetch_bing_wallpaper()
            meta = json.loads((Path("public") / "wallpapers-meta.json").read_text(encoding="utf-8"))

        self.assertEqual(count, 1)
        self.assertEqual(meta["bg_0.jpg"]["title"], "测试山谷")

    def test_fetch_ticker_publishes_fast_interval_in_status(self):
        fake_results = {
            cfg["symbol"]: spider.build_ticker_entry(cfg, 100 + idx, 99, source="Sina")
            for idx, cfg in enumerate(crawler.markets.MARKET_TICKERS)
        }
        with tempfile.TemporaryDirectory() as tmp, WorkingDirectory(tmp), mock.patch.object(
            crawler.markets, "_fetch_sina_all", return_value=fake_results
        ), mock.patch.object(crawler.markets, "read_config", return_value={"intervals": {"fast": 180}}):
            Path("public").mkdir()
            payload = spider.fetch_ticker()
            written = json.loads((Path("public") / "ticker-status.json").read_text(encoding="utf-8"))

        self.assertEqual(payload["interval"], 180)
        self.assertEqual(written["interval"], 180)


if __name__ == "__main__":
    unittest.main()
