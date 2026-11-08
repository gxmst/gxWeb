"""Small internal admin API, published only through the site's HTTPS reverse proxy."""
import hashlib
import hmac
import json
import math
import os
import secrets
import threading
import time
from http.cookies import SimpleCookie, CookieError
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from runtime_config import ConfigStore, INTERVAL_RULES, read_config


class AdminState:
    def __init__(self, password="", *, path=None, secure=True):
        if password and len(password) < 12:
            raise ValueError("ADMIN_PASSWORD 至少需要 12 个字符")
        self.enabled = bool(password)
        self.secure = secure
        self.salt = secrets.token_bytes(16)
        self.password_hash = self.digest(password)
        self.sessions = {}
        self.failures = {}
        self.lock = threading.Lock()
        self.store = ConfigStore(path)

    def digest(self, password):
        return hashlib.pbkdf2_hmac("sha256", password.encode(), self.salt, 200000)

    def login(self, password, address):
        now = time.monotonic()
        with self.lock:
            count, until = self.failures.get(address, (0, 0))
            if now < until:
                return None, True
            if until:
                count = 0
                self.failures.pop(address, None)
        valid = hmac.compare_digest(self.digest(password), self.password_hash)
        with self.lock:
            if not valid:
                count = self.failures.get(address, (count, 0))[0] + 1
                self.failures[address] = (count, now + 300 if count >= 5 else 0)
                return None, False
            self.failures.pop(address, None)
            self.sessions = {token: expiry for token, expiry in self.sessions.items() if expiry > now}
            token = secrets.token_urlsafe(32)
            self.sessions[token] = now + 3600
            return token, False

    def authenticated(self, cookie):
        try:
            cookies = SimpleCookie(cookie or "")
            token = cookies["gx_admin"].value
        except (KeyError, ValueError, CookieError):
            return False
        with self.lock:
            return self.sessions.get(token, 0) > time.monotonic()

    def cookie(self, token, *, clear=False):
        return f"gx_admin={token}; Path=/api/admin; Max-Age={0 if clear else 3600}; HttpOnly; SameSite=Strict" + ("; Secure" if self.secure else "")


def default_weather():
    coordinates = {}
    for key, env, default, limit in [("latitude", "WEATHER_LATITUDE", 41.80, 90), ("longitude", "WEATHER_LONGITUDE", 123.43, 180)]:
        try:
            value = float(os.getenv(env, default))
            coordinates[key] = value if math.isfinite(value) and abs(value) <= limit else default
        except ValueError:
            coordinates[key] = default
    return {**coordinates, "city": os.getenv("WEATHER_CITY", "默认城市")[:40]}


class AdminHandlerMixin:
    admin = None

    def api_json(self, status, payload, cookie=None):
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(body)

    def handle_admin_api(self):
        path = urlsplit(self.path).path
        if path == "/api/weather/default" and self.command == "GET":
            self.api_json(200, default_weather())
            return True
        if not path.startswith("/api/admin/"):
            return False
        state = self.admin
        if self.command == "GET" and path == "/api/admin/status":
            self.api_json(200, {"enabled": state.enabled, "authenticated": state.authenticated(self.headers.get("Cookie")), "settings": read_config(state.store.path), "bounds": {key: list(rule[:2]) for key, rule in INTERVAL_RULES.items()}})
            return True
        if not state.enabled:
            self.api_json(503, {"error": "管理功能未启用，请在服务器配置 ADMIN_PASSWORD"})
            return True
        if self.command != "POST":
            self.api_json(405, {"error": "不支持的请求"})
            return True
        # A custom header plus exact same-origin validation prevents cross-site forms/CSRF.
        origin = urlsplit(self.headers.get("Origin", ""))
        if origin.netloc != self.headers.get("Host", "") or origin.scheme not in (["https"] if state.secure else ["http", "https"]) or self.headers.get("X-GXWeb-Request") != "1":
            self.api_json(403, {"error": "请求来源不匹配"})
            return True
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 8192 or self.headers.get_content_type() != "application/json":
                raise ValueError("请求格式错误")
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict):
                raise ValueError("请求格式错误")
        except (ValueError, OSError):
            self.api_json(400, {"error": "请求格式错误"})
            return True
        if path == "/api/admin/login":
            password = payload.get("password", "")
            if not isinstance(password, str) or len(password) > 256:
                self.api_json(400, {"error": "密码格式错误"})
                return True
            token, limited = state.login(password, self.client_address[0])
            self.api_json(200 if token else 429 if limited else 401, {"authenticated": bool(token), **({"error": "尝试过多，请五分钟后重试" if limited else "密码不正确"} if not token else {})}, state.cookie(token) if token else None)
            return True
        if not state.authenticated(self.headers.get("Cookie")):
            self.api_json(401, {"error": "请先解锁管理设置"})
            return True
        if path == "/api/admin/logout":
            cookies = SimpleCookie(self.headers.get("Cookie", ""))
            with state.lock:
                state.sessions.pop(cookies["gx_admin"].value, None)
            self.api_json(200, {"authenticated": False}, state.cookie("", clear=True))
        elif path == "/api/admin/settings":
            try:
                if set(payload) != {"intervals", "revision"}:
                    raise ValueError("请求字段错误")
                saved = state.store.update(payload["intervals"], payload["revision"])
                self.api_json(200, {"settings": saved})
            except ValueError as error:
                self.api_json(400, {"error": str(error)})
            except RuntimeError as error:
                self.api_json(409, {"error": str(error)})
            except OSError:
                self.api_json(500, {"error": "设置无法写入，请检查服务器状态目录权限"})
        else:
            self.api_json(404, {"error": "未知接口"})
        return True


class ControlHandler(AdminHandlerMixin, BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def do_GET(self):
        if not self.handle_admin_api():
            self.api_json(404, {"error": "未知接口"})

    do_POST = do_GET

    def log_message(self, format, *args):
        # Requests contain no query-string credentials; never log request bodies.
        pass


def main():
    ControlHandler.admin = AdminState(os.getenv("ADMIN_PASSWORD", ""))
    server = ThreadingHTTPServer(("0.0.0.0", 1884), ControlHandler)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
