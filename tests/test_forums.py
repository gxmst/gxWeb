import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import crawler.forums
import spider
from test_spider import WorkingDirectory

RSS = '''<rss version="2.0"><channel><title>Demo</title>
<item><title>VPS &amp; Backup</title><link>https://www.nodeseek.com/post-123-1</link>
<pubDate>Sun, 08 Nov 2026 14:00:00 GMT</pubDate><category>技术</category>
<description><![CDATA[<p>Safe <b>summary</b></p><script>secret()</script>]]></description></item>
<item><title>duplicate</title><link>https://www.nodeseek.com/post-123-1</link></item>
<item><title>unsafe</title><link>javascript:alert(1)</link></item>
<item><title>external</title><link>https://example.com/</link></item>
</channel></rss>'''


class ForumFeedTests(unittest.TestCase):
    def setUp(self):
        self.cache = crawler.forums._forum_feed_cache
        crawler.forums._forum_feed_cache = {}
        self.retry = crawler.forums._forum_retry_state
        crawler.forums._forum_retry_state = {}

    def tearDown(self):
        crawler.forums._forum_feed_cache = self.cache
        crawler.forums._forum_retry_state = self.retry

    def test_public_feed_sanitizes_deduplicates_and_keeps_real_timestamp(self):
        items = spider.parse_forum_feed(RSS, "nodeseek")
        self.assertEqual(len(items), 1)
        item = items[0]
        self.assertEqual(item["content"], "VPS & Backup")
        self.assertEqual(item["summary"], "Safe summary")
        self.assertEqual(item["time"], "22:00")
        self.assertEqual(item["raw_time"], 1794146400)
        self.assertEqual(item["category"], "community")
        self.assertEqual(item["forum_category"], "技术")
        revised = spider.parse_forum_feed(RSS.replace("VPS &amp; Backup", "Edited title"), "nodeseek")
        self.assertEqual(item["id"], revised[0]["id"])

    def test_empty_and_challenge_responses_are_failures(self):
        for payload in ["<rss><channel/></rss>", "<html><title>Just a moment</title></html>"]:
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                spider.parse_forum_feed(payload, "nodeseek")

    def test_missing_timestamp_does_not_turn_an_old_post_into_new_news(self):
        payload = "<rss><channel><item><title>Old</title><link>https://linux.do/t/topic/1</link></item></channel></rss>"
        item = spider.parse_forum_feed(payload, "linuxdo")[0]
        self.assertEqual(item["raw_time"], 0)
        self.assertEqual(item["time"], "")

    def test_conditional_requests_reuse_cache_and_send_no_login_credentials(self):
        first = mock.Mock(status_code=200, content=RSS.encode(), headers={"ETag": '"feed-v1"'})
        unchanged = mock.Mock(status_code=304)
        with mock.patch.object(crawler.forums, "_fetch_forum_response", side_effect=[first, unchanged]) as fetch:
            items = spider.fetch_forum_news("nodeseek")
            again = spider.fetch_forum_news("nodeseek")
        self.assertEqual(items, again)
        self.assertEqual(fetch.call_args.args[1]["If-None-Match"], '"feed-v1"')
        self.assertNotIn("Cookie", fetch.call_args.args[1])
        again[0]["content"] = "mutated"
        self.assertNotEqual(crawler.forums._forum_feed_cache["nodeseek"]["items"][0]["content"], "mutated")

    def test_failed_response_does_not_replace_successful_cache(self):
        good = mock.Mock(status_code=200, content=RSS.encode(), headers={})
        challenge = mock.Mock(status_code=200, content=b"<html>Verify</html>", headers={})
        with mock.patch.object(crawler.forums, "_fetch_forum_response", side_effect=[good, challenge]):
            saved = spider.fetch_forum_news("nodeseek")
            with self.assertRaises(RuntimeError):
                spider.fetch_forum_news("nodeseek")
        self.assertEqual(crawler.forums._forum_feed_cache["nodeseek"]["items"], saved)

    def test_http2_transport_closes_client_and_does_not_reuse_account_cookies(self):
        with mock.patch.object(crawler.forums.httpx, "Client") as factory:
            client = factory.return_value.__enter__.return_value
            result = crawler.forums._fetch_forum_response("https://linux.do/latest.rss", {"Accept": "application/rss+xml"})
            self.assertIs(result, client.get.return_value)
            self.assertTrue(factory.call_args.kwargs["http2"])
            self.assertNotIn("cookies", factory.call_args.kwargs)
            self.assertNotIn("auth", factory.call_args.kwargs)
            factory.return_value.__exit__.assert_called_once()

    def test_configuration_bounds_and_invalid_fallback(self):
        with mock.patch.dict(os.environ, {"FORUM_POLL_INTERVAL_SECONDS": "1", "FORUM_ITEMS_PER_SOURCE": "999"}):
            self.assertEqual(spider.forum_config(), {"interval": 300, "limit": 100})
        with mock.patch.dict(os.environ, {"FORUM_POLL_INTERVAL_SECONDS": "invalid", "FORUM_ITEMS_PER_SOURCE": "invalid"}):
            self.assertEqual(spider.forum_config(), {"interval": 300, "limit": 50})

    def test_rate_limit_respects_retry_after_and_success_clears_backoff(self):
        blocked = mock.Mock(status_code=429, headers={"Retry-After": "1200"})
        blocked.raise_for_status.side_effect = RuntimeError("limited")
        good = mock.Mock(status_code=200, content=RSS.encode(), headers={})
        with mock.patch.object(crawler.forums, "_fetch_forum_response", side_effect=[blocked, good]), mock.patch(
            "crawler.forums.time.monotonic", return_value=100
        ):
            with self.assertRaises(RuntimeError):
                spider.fetch_forum_news("nodeseek")
            self.assertEqual(crawler.forums._forum_retry_state["nodeseek"]["until"], 1300)
            spider.fetch_forum_news("nodeseek")
            self.assertNotIn("nodeseek", crawler.forums._forum_retry_state)
        self.assertEqual(spider.forum_retry_after("Sun, 08 Nov 2026 14:00:00 GMT", 1794146300), 100)
        self.assertEqual(spider.forum_retry_after("invalid"), 0)

    def test_one_failed_source_retains_posts_and_restart_recovers_both(self):
        with tempfile.TemporaryDirectory() as tmp, WorkingDirectory(tmp):
            Path("public").mkdir()
            app = spider.SpiderApp()
            old = [
                {"id": "ns", "content": "Same title", "source": "nodeseek", "category": "community", "raw_time": 1},
                {"id": "ld", "content": "Same title", "source": "linuxdo", "category": "community", "raw_time": 2},
            ]
            new = [{"id": "ld-new", "content": "New", "source": "linuxdo", "category": "community", "raw_time": 3}]
            app.community_news = app._accumulate_news(
                old, new, 100, newest_first=True, per_source_limit=50
            )
            self.assertEqual({item["source"] for item in app.community_news}, {"linuxdo", "nodeseek"})
            self.assertEqual([item["id"] for item in app.community_news], ["ld-new", "ld", "ns"])
            app._publish_finance_news()
            restarted = spider.SpiderApp()
            self.assertEqual(restarted.community_news, app.community_news)

    def test_accumulate_news_retains_same_source_history_and_balances_sources(self):
        app = spider.SpiderApp.__new__(spider.SpiderApp)
        old_ns = [{"id": f"ns-{i}", "content": f"ns {i}", "source": "nodeseek", "raw_time": i} for i in range(1, 5)]
        old_ld = [{"id": f"ld-{i}", "content": f"ld {i}", "source": "linuxdo", "raw_time": 100 + i} for i in range(1, 6)]
        new_ns = [{"id": "ns-99", "content": "ns 99", "source": "nodeseek", "raw_time": 50}]

        merged = app._accumulate_news(
            old_ns + old_ld, new_ns, 6, newest_first=True, per_source_limit=3
        )
        sources = [item["source"] for item in merged]
        self.assertEqual(sources.count("nodeseek"), 3)
        self.assertEqual(sources.count("linuxdo"), 3)
        self.assertIn("ns-99", {item["id"] for item in merged})
        self.assertIn("ns-4", {item["id"] for item in merged})


if __name__ == "__main__":
    unittest.main()
