"""HTTP session pooling, atomic file persistence, time and text sanitization helpers."""
from datetime import datetime, timedelta, timezone
import html
import json
from json import JSONDecodeError
import os
import random
import re
import threading
from urllib.parse import urlparse

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from .config import USER_AGENTS
from .log_utils import log

BJ_TZ = timezone(timedelta(hours=8))

# 线程本地 Session：requests.Session 并非完全线程安全（底层连接池在并发下可能串数据）。
_thread_local = threading.local()


def get_random_ua():
    return random.choice(USER_AGENTS)


def build_http_session():
    retry = Retry(
        # 每个请求最多 3 次（首次 + 2 次重试）。调用方不再叠加手工重试。
        total=2,
        connect=2,
        read=2,
        backoff_factor=0.5,
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=["GET"],
        raise_on_status=False,
    )
    session = requests.Session()
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    return session


def get_session():
    """返回当前线程独享的 HTTP Session（懒初始化）。"""
    sess = getattr(_thread_local, "session", None)
    if sess is None:
        sess = build_http_session()
        _thread_local.session = sess
    return sess


def format_market_price(price, decimals):
    return format(price, f".{decimals}f")


def parse_json_response(response, context):
    try:
        return response.json()
    except JSONDecodeError as e:
        snippet = response.text[:160].replace("\n", " ").replace("\r", " ")
        raise ValueError(
            f"{context} 返回非 JSON 内容，status={response.status_code}, body={snippet}"
        ) from e


def _atomic_write(path, write_callback):
    """先写同目录临时文件再替换目标；失败时保留旧文件并向上抛出。"""
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    tmp_path = f"{path}.{os.getpid()}.{threading.get_ident()}.tmp"
    try:
        with open(tmp_path, "w", encoding="utf-8") as f:
            write_callback(f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, path)
    except Exception as e:
        log(f"❌ [系统] 原子化保存失败 ({path}): {e}")
        try:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        except OSError as cleanup_error:
            log(f"⚠️ [系统] 清理临时文件失败 ({tmp_path}): {cleanup_error}")
        raise
    return True


def atomic_save_json(path, data, *, compact=False):
    """原子写 JSON；大体积高频率产物传 compact=True 省去缩进空白。"""
    kwargs = {"separators": (",", ":")} if compact else {"indent": 2}
    return _atomic_write(
        path,
        lambda f: json.dump(data, f, ensure_ascii=False, **kwargs),
    )


def atomic_save_text(path, text):
    """原子写纯文本，语义与 atomic_save_json 一致。"""
    return _atomic_write(path, lambda f: f.write(text))


def atomic_load_json(path, default=None):
    if default is None:
        default = []
    try:
        if not os.path.exists(path):
            return default
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        log(f"⚠️ [系统] 读取缓存失败 ({path}): {e}")
        return default


def load_cache_with_legacy(primary_path, legacy_path, default=None):
    """读取新缓存目录；若尚无新缓存，则回退读取旧 ./public/ 文件以便平滑迁移。"""
    if os.path.exists(primary_path):
        return atomic_load_json(primary_path, default=default)
    if legacy_path and legacy_path != primary_path and os.path.exists(legacy_path):
        return atomic_load_json(legacy_path, default=default)
    return {} if default is None else default


def cleanup_legacy_cache(legacy_path):
    """新位置写入成功后清理旧 ./public/ 遗留缓存，失败仅忽略以免阻断主流程。"""
    if not legacy_path:
        return
    try:
        if os.path.exists(legacy_path):
            os.remove(legacy_path)
    except OSError:
        pass


def get_beijing_time():
    return datetime.now(BJ_TZ)


def clean_html(text):
    if not text:
        return ""
    clean = re.sub(r"<[^>]+>", "", text)
    return clean.replace("&nbsp;", " ").replace("&mdash;", "—").strip()


def escape_text(value):
    return html.escape(str(value or ""), quote=True)


def sanitize_url(url):
    candidate = (url or "").strip()
    if not candidate:
        return ""
    parsed = urlparse(candidate)
    if parsed.scheme not in ("http", "https"):
        return ""
    return candidate
