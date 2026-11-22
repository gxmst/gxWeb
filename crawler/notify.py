"""Optional webhook notifications for breaking news and consecutive pipeline failures."""
import os
import queue
import threading
import time
from urllib.parse import urlparse

import requests

from .log_utils import log


def _valid_webhook_url(raw):
    candidate = str(raw or "").strip()
    if not candidate:
        return ""
    parsed = urlparse(candidate)
    if parsed.scheme in {"http", "https"} and parsed.netloc:
        return candidate
    return ""


def _parse_int_env(name, default, minimum, maximum):
    try:
        return max(minimum, min(maximum, int(os.getenv(name, str(default)))))
    except (TypeError, ValueError):
        return default


class AlertNotifier:
    """Rate-limited notifier with a bounded queue and one independent sender."""

    def __init__(self, webhook_url=None, *, min_score=None, cooldown_seconds=None, failure_threshold=None, queue_size=64):
        raw_url = os.getenv("ALERT_WEBHOOK_URL", "") if webhook_url is None else webhook_url
        self.webhook_url = _valid_webhook_url(raw_url)
        self.min_score = (
            _parse_int_env("ALERT_MIN_SCORE", 85, 50, 100)
            if min_score is None
            else max(50, min(100, int(min_score)))
        )
        self.cooldown_seconds = (
            _parse_int_env("ALERT_COOLDOWN_SECONDS", 1800, 30, 86400)
            if cooldown_seconds is None
            else max(30, int(cooldown_seconds))
        )
        self.failure_threshold = (
            _parse_int_env("ALERT_CONSECUTIVE_FAILURES", 3, 1, 20)
            if failure_threshold is None
            else max(1, int(failure_threshold))
        )
        self._lock = threading.Lock()
        self._last_sent = {}
        self._failures = {}
        self._seen_news = set()
        self._seen_order = []
        self._queue = queue.Queue(maxsize=max(1, int(queue_size)))
        self._stop = threading.Event()
        self._worker = None

    @property
    def enabled(self):
        return bool(self.webhook_url)

    def send(self, title, text, *, level="info", source="gxweb", key=None):
        """Enqueue without waiting for network I/O; return whether it was accepted."""
        if not self.enabled:
            return False
        cooldown_key = key or f"{level}:{source}:{title}"
        payload = {
            "title": str(title)[:160],
            "text": str(text)[:1000],
            "level": level,
            "source": source,
        }
        with self._lock:
            if self._stop.is_set():
                return False
            now = time.monotonic()
            self._last_sent = {
                k: ts for k, ts in self._last_sent.items()
                if now - ts < self.cooldown_seconds
            }
            if cooldown_key in self._last_sent:
                return False
            try:
                self._queue.put_nowait(payload)
            except queue.Full:
                return False
            self._last_sent[cooldown_key] = now
            if self._worker is None:
                self._worker = threading.Thread(target=self._deliver_loop, name="alerts", daemon=True)
                self._worker.start()
        return True

    def _deliver_loop(self):
        while not self._stop.is_set():
            try:
                payload = self._queue.get(timeout=0.2)
            except queue.Empty:
                continue
            try:
                # Only the status matters; do not wait for or retain a webhook response body.
                resp = requests.post(self.webhook_url, json=payload, timeout=(3, 5), stream=True)
                try:
                    resp.raise_for_status()
                finally:
                    resp.close()
            except Exception as exc:
                # Request exception messages may contain secret webhook URL components.
                log(f"⚠️ [通知] Webhook 发送失败: {type(exc).__name__}")
            finally:
                self._queue.task_done()

    def close(self):
        """Stop best-effort delivery without delaying crawler shutdown on a slow hook."""
        with self._lock:
            self._stop.set()
            worker = self._worker
        if worker is not None:
            worker.join(timeout=1)

    def record_job_result(self, job_name, *, succeeded, error=""):
        if succeeded:
            with self._lock:
                self._failures.pop(job_name, None)
            return False
        with self._lock:
            count = self._failures.get(job_name, 0) + 1
            self._failures[job_name] = count
        if count >= self.failure_threshold:
            return self.send(
                f"gxWeb 任务连续失败 ({job_name})",
                f"任务 {job_name} 已连续失败 {count} 次：{str(error or 'unknown')[:300]}",
                level="warning",
                source=job_name,
                key=f"job-fail:{job_name}",
            )
        return False

    def seed_news_ids(self, items):
        with self._lock:
            for item in items or []:
                if not isinstance(item, dict):
                    continue
                ident = item.get("id") or item.get("content")
                if ident and ident not in self._seen_news:
                    self._seen_news.add(ident)
                    self._seen_order.append(ident)
            while len(self._seen_order) > 4000:
                oldest = self._seen_order.pop(0)
                self._seen_news.discard(oldest)

    def notify_important_news(self, items):
        if not self.enabled:
            return 0
        sent = 0
        for item in items or []:
            if not isinstance(item, dict) or not item.get("is_important"):
                continue
            score = item.get("importance_score") or 0
            try:
                score = float(score)
            except (TypeError, ValueError):
                score = 0
            if score < self.min_score:
                continue
            ident = item.get("id") or item.get("content")
            if not ident:
                continue
            with self._lock:
                if ident in self._seen_news:
                    continue
                self._seen_news.add(ident)
                self._seen_order.append(ident)
                while len(self._seen_order) > 4000:
                    oldest = self._seen_order.pop(0)
                    self._seen_news.discard(oldest)
            reason = item.get("importance_reason") or "重要快讯"
            content = str(item.get("display_content") or item.get("content") or "")
            if self.send(
                f"[{reason}] {item.get('source', 'gxWeb')}",
                content,
                level="important",
                source=str(item.get("source") or "news"),
                key=f"news:{ident}",
            ):
                sent += 1
        return sent
