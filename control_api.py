"""Small internal admin API, published only through the site's HTTPS reverse proxy."""
import hashlib
import hmac
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import math
import os
import secrets
import threading
import time
from urllib.parse import urlsplit

from runtime_config import INTERVAL_RULES, ConfigStore, read_config

MAX_TRACKED_FAILURES = 1024
MAX_ACTIVE_SESSIONS = 128


def _parse_ip(raw):
    try:
        addr = ipaddress.ip_address(str(raw or "").strip())
    except ValueError:
        return None
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped:
        return addr.ipv4_mapped
    return addr


_TRUSTED_PROXY_NETS = (
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("169.254.0.0/16"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"),
    ipaddress.ip_network("fe80::/10"),
)


def _is_trusted_proxy_ip(addr):
    return addr is not None and any(addr in net for net in _TRUSTED_PROXY_NETS)


def _resolve_cookie_secure(raw=None):
    value = (os.getenv("ADMIN_COOKIE_SECURE", "true") if raw is None else str(raw)).strip().lower()
    if value in {"false", "0", "no"}:
        return False
    if value == "auto":
        return "auto"
    return True


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

    def _prune_failures(self, now):
        expired = [ip for ip, (_, until) in self.failures.items() if until and until <= now]
        for ip in expired:
            del self.failures[ip]
        while len(self.failures) >= MAX_TRACKED_FAILURES:
            oldest = next(iter(self.failures))
            del self.failures[oldest]

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
                prev_count = self.failures.pop(address, (count, 0))[0]
                self._prune_failures(now)
                next_count = prev_count + 1
                self.failures[address] = (next_count, now + 300 if next_count >= 5 else 0)
                return None, False
            self.failures.pop(address, None)
            self.sessions = {token: expiry for token, expiry in self.sessions.items() if expiry > now}
            while len(self.sessions) >= MAX_ACTIVE_SESSIONS:
                oldest = next(iter(self.sessions))
                del self.sessions[oldest]
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

    def cookie(self, token, *, clear=False, secure=None):
        use_secure = (self.secure is True) if secure is None else bool(secure)
        suffix = "; Secure" if use_secure else ""
        max_age = 0 if clear else 3600
        return f"gx_admin={token}; Path=/api/admin; Max-Age={max_age}; HttpOnly; SameSite=Strict{suffix}"


def default_weather():
    coordinates = {}
    for key, env, default, limit in [
        ("latitude", "WEATHER_LATITUDE", 41.80, 90),
        ("longitude", "WEATHER_LONGITUDE", 123.43, 180),
    ]:
        try:
            value = float(os.getenv(env, default))
            coordinates[key] = value if math.isfinite(value) and abs(value) <= limit else default
        except ValueError:
            coordinates[key] = default
    return {**coordinates, "city": os.getenv("WEATHER_CITY", "默认城市")[:40]}


class AdminHandlerMixin:
    admin = None

    def _peer_ip(self):
        return _parse_ip(self.client_address[0] if self.client_address else "")

    def _client_ip(self):
        peer = self._peer_ip()
        peer_str = str(peer) if peer else str((self.client_address or ["unknown"])[0])
        trust_proxy = os.getenv("TRUST_PROXY_HEADERS", "true").strip().lower() not in {"false", "0", "no"}
        if not trust_proxy or not _is_trusted_proxy_ip(peer):
            return peer_str

        xff = self.headers.get("X-Forwarded-For", "")
        parsed_chain = [ip for part in xff.split(",") if (ip := _parse_ip(part)) is not None]
        for candidate in reversed(parsed_chain):
            # Walk right-to-left skipping internal proxy hops so clients cannot spoof left-most entries.
            if not _is_trusted_proxy_ip(candidate) and not candidate.is_link_local:
                return str(candidate)

        x_real = _parse_ip(self.headers.get("X-Real-IP", ""))
        if x_real is not None:
            return str(x_real)
        if parsed_chain:
            return str(parsed_chain[0])
        return peer_str

    def _request_is_https(self, state):
        if state.secure is True:
            return True
        if state.secure is False:
            return False
        if os.getenv("TRUST_PROXY_HEADERS", "true").strip().lower() not in {"false", "0", "no"} and _is_trusted_proxy_ip(self._peer_ip()):
            proto = self.headers.get("X-Forwarded-Proto", "").split(",")[0].strip().lower()
            if proto in {"http", "https"}:
                return proto == "https"
        return urlsplit(self.headers.get("Origin", "")).scheme == "https"

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
            self.api_json(200, {
                "enabled": state.enabled,
                "authenticated": state.authenticated(self.headers.get("Cookie")),
                "settings": read_config(state.store.path),
                "bounds": {key: list(rule[:2]) for key, rule in INTERVAL_RULES.items()},
            })
            return True
        if not state.enabled:
            self.api_json(503, {"error": "管理功能未启用，请在服务器配置 ADMIN_PASSWORD"})
            return True
        if self.command != "POST":
            self.api_json(405, {"error": "不支持的请求"})
            return True

        https_only = self._request_is_https(state)
        origin = urlsplit(self.headers.get("Origin", ""))
        allowed_schemes = ["https"] if https_only else ["http", "https"]
        if (
            origin.netloc != self.headers.get("Host", "")
            or origin.scheme not in allowed_schemes
            or self.headers.get("X-GXWeb-Request") != "1"
        ):
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
            token, limited = state.login(password, self._client_ip())
            self.api_json(
                200 if token else 429 if limited else 401,
                {
                    "authenticated": bool(token),
                    **({"error": "尝试过多，请五分钟后重试" if limited else "密码不正确"} if not token else {}),
                },
                state.cookie(token, secure=https_only) if token else None,
            )
            return True

        if not state.authenticated(self.headers.get("Cookie")):
            self.api_json(401, {"error": "请先解锁管理设置"})
            return True

        if path == "/api/admin/logout":
            cookies = SimpleCookie(self.headers.get("Cookie", ""))
            with state.lock:
                if "gx_admin" in cookies:
                    state.sessions.pop(cookies["gx_admin"].value, None)
            self.api_json(200, {"authenticated": False}, state.cookie("", clear=True, secure=https_only))
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
    ControlHandler.admin = AdminState(
        os.getenv("ADMIN_PASSWORD", ""),
        secure=_resolve_cookie_secure(),
    )
    server = ThreadingHTTPServer(("0.0.0.0", 1884), ControlHandler)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
