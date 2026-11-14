"""Public community RSS readers (NodeSeek, Linux DO) with HTTP/2 + ETag/backoff."""
import calendar
from datetime import datetime
from email.utils import parsedate_to_datetime
import hashlib
from html.parser import HTMLParser
import os
import re
import time
from urllib.parse import urlparse

import feedparser
import httpx

from .config import FORUM_SOURCES
from .io_utils import BJ_TZ, sanitize_url
from .log_utils import log

_forum_feed_cache = {}
_forum_retry_state = {}


def forum_retry_after(value, now=None):
    """Support Retry-After seconds or HTTP dates; invalid headers add no delay."""
    try:
        return max(0, int(str(value).strip()))
    except (ValueError, TypeError):
        try:
            date = parsedate_to_datetime(value)
            return max(0, date.timestamp() - (time.time() if now is None else now))
        except (ValueError, TypeError, OverflowError):
            return 0


def forum_config():
    def bounded(name, default, minimum, maximum):
        try:
            return max(minimum, min(maximum, int(os.getenv(name, str(default)))))
        except (TypeError, ValueError):
            return default

    return {
        "interval": bounded("FORUM_POLL_INTERVAL_SECONDS", 300, 300, 86400),
        "limit": bounded("FORUM_ITEMS_PER_SOURCE", 50, 1, 100),
    }


class _FeedTextParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.skipped = 0

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style"}:
            self.skipped += 1
        elif not self.skipped and tag in {"p", "div", "br", "li"}:
            self.parts.append(" ")

    def handle_endtag(self, tag):
        if tag in {"script", "style"}:
            self.skipped = max(0, self.skipped - 1)
        elif not self.skipped:
            self.parts.append(" ")

    def handle_data(self, data):
        if not self.skipped:
            self.parts.append(data)


_DISCOURSE_FOOTER_RE = re.compile(
    r"(?:\s*\d+\s*(?:个帖子|posts?)\s*[-–—]\s*\d+\s*(?:位参与者|participants?))?\s*(?:阅读完整话题|Read full topic)\.?\s*$",
    re.IGNORECASE,
)


def _extract_plain_text(value):
    parser = _FeedTextParser()
    parser.feed(str(value or "")[:20000])
    return " ".join("".join(parser.parts).split())


def _feed_plain_text(value, limit):
    text = _extract_plain_text(value)
    return text[:limit] + ("…" if len(text) > limit else "")


def _clean_forum_summary(value, limit=240):
    text = _DISCOURSE_FOOTER_RE.sub("", _extract_plain_text(value)).strip()
    return text[:limit] + ("…" if len(text) > limit else "")


def parse_forum_feed(payload, source, limit=30):
    config = FORUM_SOURCES[source]
    feed = feedparser.parse(payload)
    if not feed.entries:
        raise ValueError(f"{config['name']} RSS 没有有效帖子（可能是验证页或空响应）")
    items = []
    seen = set()
    for entry in feed.entries:
        title = _feed_plain_text(entry.get("title"), 200)
        url = sanitize_url(entry.get("link"))
        if not title or not url or urlparse(url).hostname not in config["hosts"] or url in seen:
            continue
        seen.add(url)
        parsed_time = entry.get("published_parsed") or entry.get("updated_parsed")
        try:
            ts = max(0, calendar.timegm(parsed_time)) if parsed_time else 0
        except (TypeError, ValueError, OverflowError):
            ts = 0
        tags = entry.get("tags") or []
        category = _feed_plain_text(tags[0].get("term"), 30) if tags else ""
        items.append({
            "id": f"forum-{source}-{hashlib.sha256(url.encode()).hexdigest()[:20]}",
            "time": datetime.fromtimestamp(ts, BJ_TZ).strftime("%H:%M") if ts else "",
            "raw_time": ts,
            "content": title,
            "summary": _clean_forum_summary(entry.get("summary"), 240),
            "url": url,
            "is_important": False,
            "category": "community",
            "source": source,
            "forum_category": category,
            "format": "text",
        })
        if len(items) >= max(1, min(100, limit)):
            break
    if not items:
        raise ValueError(f"{config['name']} RSS 帖子全部无效")
    return sorted(items, key=lambda item: item["raw_time"], reverse=True)


def _fetch_forum_response(url, headers):
    with httpx.Client(http2=True, follow_redirects=True, timeout=httpx.Timeout(20.0, connect=8.0)) as client:
        return client.get(url, headers=headers)


def fetch_forum_news(source):
    config = FORUM_SOURCES[source]
    cached = _forum_feed_cache.get(source, {})
    headers = {
        "User-Agent": "gxWeb/1.0 (public RSS reader)",
        "Accept": "application/rss+xml, application/xml, text/xml",
    }
    if cached.get("etag"):
        headers["If-None-Match"] = cached["etag"]
    if cached.get("modified"):
        headers["If-Modified-Since"] = cached["modified"]
    response = None
    try:
        response = _fetch_forum_response(config["url"], headers)
        if response.status_code == 304:
            if not cached.get("items"):
                raise ValueError("RSS 返回 304，但没有可用缓存")
            _forum_retry_state.pop(source, None)
            return [dict(item) for item in cached["items"]]
        response.raise_for_status()
        items = parse_forum_feed(response.content, source, forum_config()["limit"])
    except Exception as error:
        attempts = _forum_retry_state.get(source, {}).get("failures", 0) + 1
        base = 1800 if response is not None and response.status_code == 403 else 600
        delay = min(86400, base * (2 ** min(attempts - 1, 8)))
        if response is not None:
            delay = max(delay, forum_retry_after(response.headers.get("Retry-After")))
        _forum_retry_state[source] = {"failures": attempts, "until": time.monotonic() + delay}
        raise RuntimeError(f"{config['name']} 请求失败，至少 {int(delay)} 秒后重试：{error}") from error

    _forum_retry_state.pop(source, None)
    _forum_feed_cache[source] = {
        "etag": response.headers.get("ETag"),
        "modified": response.headers.get("Last-Modified"),
        "items": items,
    }
    log(f"✅ [社区] {config['name']} 解析 {len(items)} 条公开帖子")
    return items
