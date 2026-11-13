"""Concurrent English-to-Chinese headline/description translation with disk cache."""
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import threading

from .config import (
    LEGACY_TRANSLATE_CACHE_PATH,
    TRANSLATE_API_TIMEOUT,
    TRANSLATE_CACHE_MAX,
    TRANSLATE_CACHE_PATH,
)
from .io_utils import (
    atomic_save_json,
    cleanup_legacy_cache,
    get_random_ua,
    get_session,
    load_cache_with_legacy,
    parse_json_response,
)
from .log_utils import log

_translate_cache = {}
_translate_lock = threading.Lock()
_translate_dirty = False


def _translate_text(text):
    """通过 Google Translate 公共 HTTP 端点翻译。"""
    response = get_session().get(
        "https://translate.googleapis.com/translate_a/single",
        params={"client": "gtx", "sl": "en", "tl": "zh-CN", "dt": "t", "q": text},
        headers={"User-Agent": get_random_ua()},
        timeout=(5, TRANSLATE_API_TIMEOUT),
    )
    response.raise_for_status()
    payload = parse_json_response(response, "翻译服务")
    segments = payload[0] if isinstance(payload, list) and payload else None
    if not isinstance(segments, list):
        raise ValueError("翻译服务返回格式无效")
    translated = "".join(
        str(segment[0])
        for segment in segments
        if isinstance(segment, list) and segment and segment[0]
    ).strip()
    if not translated:
        raise ValueError("翻译服务返回空结果")
    return translated


def _load_translate_cache():
    """启动时从磁盘加载翻译缓存，并在迁移期兼容旧 public 目录缓存。"""
    global _translate_cache
    data = load_cache_with_legacy(
        TRANSLATE_CACHE_PATH,
        LEGACY_TRANSLATE_CACHE_PATH,
        default={},
    )
    if isinstance(data, dict):
        with _translate_lock:
            _translate_cache = data
        log(f"✅ [翻译引擎] 从磁盘加载 {len(data)} 条翻译缓存。")


def _persist_translate_cache():
    """把内存缓存紧凑落盘。由调用方在批量翻译结束后触发。"""
    global _translate_dirty
    with _translate_lock:
        if not _translate_dirty:
            return False
        snapshot = dict(_translate_cache)
    atomic_save_json(TRANSLATE_CACHE_PATH, snapshot, compact=True)
    cleanup_legacy_cache(LEGACY_TRANSLATE_CACHE_PATH)
    with _translate_lock:
        if _translate_cache == snapshot:
            _translate_dirty = False
    return True


def _evict_cache_if_needed():
    if len(_translate_cache) > TRANSLATE_CACHE_MAX:
        for k in list(_translate_cache.keys())[:200]:
            del _translate_cache[k]


def translate_en_to_zh(text):
    """单条翻译——保留旧签名用于零散调用。批量翻译用 translate_batch 性能更好。"""
    if not text:
        return ""
    cache_key = hashlib.md5(text.encode()).hexdigest()
    with _translate_lock:
        if cache_key in _translate_cache:
            return _translate_cache[cache_key]
    try:
        translated = _translate_text(text)
    except Exception as e:
        log(f"⚠️ [翻译引擎] 失败: {e}")
        return text
    if not translated:
        log("⚠️ [翻译引擎] 返回空结果，使用原文且不写入缓存。")
        return text
    global _translate_dirty
    with _translate_lock:
        _translate_cache[cache_key] = translated
        _translate_dirty = True
        _evict_cache_if_needed()
    return translated


def translate_batch(texts, max_workers=4):
    """并发翻译一批文本，返回 {原文: 译文}。"""
    result = {}
    pending = []
    pending_keys = set()
    with _translate_lock:
        for t in texts:
            if not t:
                result[t] = ""
                continue
            key = hashlib.md5(t.encode()).hexdigest()
            cached = _translate_cache.get(key)
            if cached is not None:
                result[t] = cached
            elif key not in pending_keys:
                pending.append((t, key))
                pending_keys.add(key)

    if not pending:
        return result

    def _do(item):
        text, key = item
        try:
            translated = _translate_text(text)
            if not translated:
                raise ValueError("翻译服务返回空结果")
            return key, text, translated, True
        except Exception as e:
            log(f"⚠️ [翻译引擎] 失败: {e}")
            return key, text, text, False

    global _translate_dirty
    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        for fut in as_completed([ex.submit(_do, p) for p in pending]):
            key, text, translated, succeeded = fut.result()
            result[text] = translated
            # 失败回退原文仅作本轮展示，不写入持久缓存以免污染。
            if succeeded:
                with _translate_lock:
                    _translate_cache[key] = translated
                    _translate_dirty = True

    with _translate_lock:
        _evict_cache_if_needed()

    return result
