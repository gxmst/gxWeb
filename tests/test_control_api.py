from http.server import ThreadingHTTPServer
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

import requests

from control_api import AdminState, ControlHandler, _resolve_cookie_secure
import crawler.app
import crawler.forums
from runtime_config import ConfigStore, default_intervals, read_config
import spider


class RuntimeConfigTests(unittest.TestCase):
    def test_invalid_file_falls_back_without_changing_it(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "settings.json"
            path.write_text("broken")
            self.assertEqual(read_config(path)["intervals"], default_intervals())
            self.assertEqual(path.read_text(), "broken")

    def test_bounds_unknown_fields_and_conflicting_writes(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "settings.json"
            store = ConfigStore(path)
            for values in ({"nodeseek": 1}, {"fast": True}, {"password": "secret"}, {"rss": 86401}):
                with self.assertRaises(ValueError):
                    store.update(values, 0)
            self.assertFalse(path.exists())
            result = store.update({"nodeseek": 900, "linuxdo": 1800}, 0)
            self.assertEqual(result["revision"], 1)
            with self.assertRaises(RuntimeError):
                store.update({"rss": 600}, 0)
            self.assertEqual(read_config(path)["intervals"]["linuxdo"], 1800)

    def test_forum_env_is_default_and_saved_settings_take_precedence(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict("os.environ", {"FORUM_POLL_INTERVAL_SECONDS": "1200"}):
            path = Path(folder) / "settings.json"
            self.assertEqual(read_config(path)["intervals"]["linuxdo"], 1200)
            ConfigStore(path).update({"linuxdo": 600}, 0)
            self.assertEqual(read_config(path)["intervals"]["linuxdo"], 600)


class AdminApiTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.state = AdminState("test-admin-password", path=Path(self.folder.name) / "private" / "settings.json", secure=False)
        handler = type("TestHandler", (ControlHandler,), {"admin": self.state})
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        self.session = requests.Session()
        self.headers = {"Origin": self.url, "X-GXWeb-Request": "1"}

    def tearDown(self):
        self.session.close()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.folder.cleanup()

    def post(self, path, payload, headers=None):
        return self.session.post(
            self.url + "/api/admin/" + path,
            json=payload,
            headers=self.headers if headers is None else headers,
            timeout=5,
        )

    def test_writes_require_authentication_same_origin_and_revision(self):
        self.assertEqual(self.post("settings", {"intervals": {"fast": 120}, "revision": 0}).status_code, 401)
        self.assertEqual(self.post("login", {"password": "test-admin-password"}, {"Origin": "https://other.example", "X-GXWeb-Request": "1"}).status_code, 403)
        self.assertEqual(self.post("login", {"password": "test-admin-password"}, {}).status_code, 403)
        login = self.post("login", {"password": "test-admin-password"})
        self.assertEqual(login.status_code, 200)
        cookie = login.headers["Set-Cookie"]
        self.assertIn("HttpOnly", cookie)
        self.assertIn("SameSite=Strict", cookie)
        self.assertNotIn("test-admin-password", login.text + cookie)
        self.assertEqual(self.post("settings", {"intervals": {"nodeseek": 1}, "revision": 0}).status_code, 400)
        self.assertEqual(self.post("settings", {"intervals": {"fast": 120}, "revision": 0}).status_code, 200)
        self.assertEqual(self.post("settings", {"intervals": {"fast": 300}, "revision": 0}).status_code, 409)
        self.assertEqual(read_config(self.state.store.path)["intervals"]["fast"], 120)
        self.assertEqual(self.post("logout", {}).status_code, 200)
        self.assertEqual(self.post("settings", {"intervals": {"fast": 300}, "revision": 1}).status_code, 401)

    def test_audit_log_records_security_events_without_secrets(self):
        with self.assertLogs("gxweb.audit", level="INFO") as logs:
            self.assertEqual(self.post("login", {"password": "wrong-secret-password"}).status_code, 401)
            self.assertEqual(self.post("login", {"password": "test-admin-password"}).status_code, 200)
            self.assertEqual(self.post("settings", {"intervals": {"fast": 180}, "revision": 0}).status_code, 200)
            self.assertEqual(self.post("logout", {}).status_code, 200)
        joined = "\n".join(logs.output)
        self.assertIn("event=login_failed", joined)
        self.assertIn("event=login_ok", joined)
        self.assertIn("event=settings_updated", joined)
        self.assertIn("event=logout", joined)
        self.assertNotIn("wrong-secret-password", joined)
        self.assertNotIn("test-admin-password", joined)

    def test_disabled_admin_is_read_only(self):
        self.state.enabled = False
        public = self.session.get(self.url + "/api/admin/status", timeout=5).json()
        self.assertFalse(public["enabled"])
        self.assertIn("intervals", public["settings"])
        self.assertEqual(self.post("login", {"password": "test-admin-password"}).status_code, 503)
        self.assertFalse(self.state.store.path.exists())

    def test_rate_limit_expires_and_sessions_expire(self):
        for _ in range(5):
            self.assertEqual(self.post("login", {"password": "wrong"}).status_code, 401)
        self.assertEqual(self.post("login", {"password": "test-admin-password"}).status_code, 429)
        with patch("control_api.time.monotonic", return_value=10**12):
            self.assertEqual(self.post("login", {"password": "test-admin-password"}).status_code, 200)
        with patch("control_api.time.monotonic", return_value=10**12 + 3601):
            self.assertFalse(self.state.authenticated(self.session.cookies.get_dict() and "gx_admin=" + self.session.cookies.get("gx_admin")))

    def test_forwarded_client_ip_isolates_rate_limits_and_prevents_spoofing(self):
        client_a_spoofed = {**self.headers, "X-Forwarded-For": "1.2.3.4, 203.0.113.10, 172.18.0.2"}
        client_b = {**self.headers, "X-Forwarded-For": "203.0.113.11, 172.18.0.2"}
        for _ in range(5):
            self.assertEqual(self.post("login", {"password": "wrong"}, client_a_spoofed).status_code, 401)
        self.assertEqual(self.post("login", {"password": "test-admin-password"}, client_a_spoofed).status_code, 429)
        # Spoofing a different left-most XFF header does not bypass lockout for 203.0.113.10.
        self.assertEqual(
            self.post("login", {"password": "test-admin-password"}, {**self.headers, "X-Forwarded-For": "9.9.9.9, 203.0.113.10"}).status_code,
            429,
        )
        # Another public client through the same reverse proxy is unaffected.
        self.assertEqual(self.post("login", {"password": "test-admin-password"}, client_b).status_code, 200)

    def test_production_cookie_is_secure_and_password_too_short_rejected(self):
        self.assertIn("; Secure", AdminState("long-test-password").cookie("token"))
        self.assertEqual(_resolve_cookie_secure("false"), False)
        self.assertEqual(_resolve_cookie_secure("auto"), "auto")
        self.assertEqual(_resolve_cookie_secure("true"), True)
        with self.assertRaises(ValueError):
            AdminState("short")

    def test_failure_tracking_stays_bounded(self):
        with patch("control_api.MAX_TRACKED_FAILURES", 16):
            for idx in range(25):
                self.state.login("wrong", f"198.51.100.{idx}")
        self.assertLessEqual(len(self.state.failures), 16)


class DynamicSchedulingTests(unittest.TestCase):
    def test_fast_heartbeat_continues_when_fetch_interval_is_long(self):
        app = spider.SpiderApp()
        clock = [0.0]
        attempts = []
        intervals = default_intervals()
        intervals["fast"] = 3600

        def run_job(name, *args, **kwargs):
            attempts.append((name, clock[0]))
            return False, []

        def sleep(seconds):
            clock[0] += seconds
            if clock[0] >= 360:
                app.shutdown = True

        with patch("crawler.app.read_config", return_value={"intervals": intervals}), patch(
            "crawler.app.time.monotonic", side_effect=lambda: clock[0]
        ), patch.object(app, "_run_job", side_effect=run_job), patch.object(
            app, "_interruptible_sleep", side_effect=sleep
        ):
            app._fast_loop()
        self.assertEqual([ts for name, ts in attempts if name == "ticker"], [0])
        self.assertEqual([ts for name, ts in attempts if name == "heartbeat"], [0, 60, 120, 180, 240, 300])

    def test_forum_interval_change_is_applied_without_restart(self):
        app = spider.SpiderApp()
        clock = [0.0]
        attempts = []
        intervals = default_intervals()
        intervals.update(nodeseek=600, linuxdo=600)

        def run_job(source, *args, **kwargs):
            attempts.append((source, clock[0]))
            return True, []

        def sleep(_):
            clock[0] += 30
            if clock[0] >= 300:
                intervals["nodeseek"] = 300
            if clock[0] >= 630:
                app.shutdown = True

        with patch("crawler.app.read_config", side_effect=lambda: {"intervals": dict(intervals)}), patch(
            "crawler.app.time.monotonic", side_effect=lambda: clock[0]
        ), patch.object(app, "_run_job", side_effect=run_job), patch.object(
            app, "_interruptible_sleep", side_effect=sleep
        ):
            app._forum_loop()
        self.assertEqual([ts for source, ts in attempts if source == "nodeseek"], [0, 300, 600])
        self.assertEqual([ts for source, ts in attempts if source == "linuxdo"], [0, 600])

    def test_one_forum_in_backoff_does_not_block_the_other(self):
        app = spider.SpiderApp()
        clock = [0.0]
        attempts = []
        intervals = default_intervals()

        def run_job(source, *args, **kwargs):
            attempts.append((source, clock[0]))
            return True, []

        def sleep(seconds):
            clock[0] += seconds
            if clock[0] >= 630:
                app.shutdown = True

        with patch.dict(crawler.forums._forum_retry_state, {"nodeseek": {"until": 600}}, clear=True), patch(
            "crawler.app.read_config", return_value={"intervals": intervals}
        ), patch("crawler.app.time.monotonic", side_effect=lambda: clock[0]), patch.object(
            app, "_run_job", side_effect=run_job
        ), patch.object(app, "_interruptible_sleep", side_effect=sleep):
            app._forum_loop()
        self.assertEqual([ts for source, ts in attempts if source == "nodeseek"], [600])
        self.assertEqual([ts for source, ts in attempts if source == "linuxdo"], [0, 300, 600])


if __name__ == "__main__":
    unittest.main()
