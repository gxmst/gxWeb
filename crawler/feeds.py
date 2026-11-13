"""Sina live feed and concurrent global RSS feed ingestion with per-source backoff."""
import calendar
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import threading
import time

import feedparser

from .config import IMPORTANCE_THRESHOLD, RSS_SOURCES, SINA_PAGES
from .importance import classify_news_importance
from .io_utils import (
    BJ_TZ,
    clean_html,
    get_beijing_time,
    get_random_ua,
    get_session,
    parse_json_response,
    sanitize_url,
)
from .log_utils import log
from .translator import _persist_translate_cache, translate_batch

_rss_retry_state = {}
_rss_lock = threading.Lock()


def _parse_entry_timestamp(parsed_struct):
    """把 feedparser 时间元组转为 (unix_ts, HH:MM)；缺失或异常时返回 (0, "")。"""
    if not parsed_struct:
        return 0, ""
    try:
        ts = max(0, calendar.timegm(parsed_struct))
    except (TypeError, ValueError, OverflowError):
        return 0, ""
    if not ts:
        return 0, ""
    time_str = datetime.fromtimestamp(ts, timezone.utc).astimezone(BJ_TZ).strftime("%H:%M")
    return ts, time_str


def _fetch_sina_page(page):
    """抓单页新浪快讯；连接与状态码重试统一交给 Session 的 Retry。"""
    url = f"https://zhibo.sina.com.cn/api/zhibo/feed?page={page}&page_size=100&zhibo_id=152"
    resp = get_session().get(url, headers={"User-Agent": get_random_ua()}, timeout=15)
    resp.raise_for_status()
    data = parse_json_response(resp, f"新浪快讯第 {page} 页")
    items = data.get("result", {}).get("data", {}).get("feed", {}).get("list", [])

    page_news = []
    for item in items:
        clean_txt = clean_html(item.get("rich_text", "").replace("<br>", ""))
        if not clean_txt:
            continue
        importance_score, importance_reason = classify_news_importance(clean_txt, item)
        ts_val = item.get("create_time")
        try:
            if isinstance(ts_val, str):
                dt = datetime.strptime(ts_val, "%Y-%m-%d %H:%M:%S").replace(tzinfo=BJ_TZ)
                ts = int(dt.timestamp())
                time_str = dt.strftime("%H:%M")
            else:
                ts = int(ts_val)
                time_str = datetime.fromtimestamp(ts, timezone.utc).astimezone(BJ_TZ).strftime("%H:%M")
        except Exception:
            now = get_beijing_time()
            ts = int(now.timestamp())
            time_str = now.strftime("%H:%M")

        upstream_id = item.get("id")
        item_id = (
            f"sina-{upstream_id}"
            if upstream_id not in (None, "")
            else f"sina-{hashlib.sha256(f'{ts}|{clean_txt}'.encode()).hexdigest()[:16]}"
        )
        page_news.append({
            "id": item_id,
            "time": time_str,
            "raw_time": ts,
            "content": f"【新浪】{clean_txt}",
            "url": "",
            "is_important": importance_score >= IMPORTANCE_THRESHOLD,
            "importance_score": importance_score,
            "importance_reason": importance_reason,
            "category": "news",
            "source": "sina",
        })
    return page_news


def fetch_sina():
    log(f"[{get_beijing_time().strftime('%H:%M:%S')}][新浪引擎] 开始抓取（{SINA_PAGES} 页）...")
    news_list = []
    for page in range(1, SINA_PAGES + 1):
        try:
            news_list.extend(_fetch_sina_page(page))
        except Exception as e:
            log(f"⚠️ [新浪引擎] 第 {page} 页失败，继续其它页: {e}")
    if news_list:
        log(f"✅ [新浪引擎] 成功抓取 {len(news_list)} 条。")
    else:
        log("⚠️ [新浪引擎] 本轮未抓到数据，将保留上次成功结果。")
    return news_list


def _record_rss_failure(source_name):
    with _rss_lock:
        failures = _rss_retry_state.get(source_name, {}).get("failures", 0) + 1
        delay = min(14400, 600 * (2 ** min(failures - 1, 5)))
        _rss_retry_state[source_name] = {
            "failures": failures,
            "until": time.monotonic() + delay,
        }
        return delay


def _fetch_single_rss(source):
    name = source["name"]
    now_mono = time.monotonic()
    with _rss_lock:
        until = _rss_retry_state.get(name, {}).get("until", 0)
    if now_mono < until:
        return []

    source_news = []
    try:
        resp = get_session().get(source["url"], headers={"User-Agent": get_random_ua()}, timeout=15)
        resp.raise_for_status()
        feed = feedparser.parse(resp.text)
        for entry in feed.entries[:40]:
            try:
                title = (entry.get("title") or "").strip()
                if not title:
                    continue
                link = sanitize_url(entry.get("link", ""))
                ts, time_str = _parse_entry_timestamp(
                    entry.get("published_parsed") or entry.get("updated_parsed")
                )
                identity = link or title
                source_news.append({
                    "id": f"rss-{hashlib.sha256(f'{name}|{identity}'.encode()).hexdigest()[:16]}",
                    "time": time_str,
                    "raw_time": ts,
                    "content": f"【{name}】{title}",
                    "url": link,
                    "is_important": False,
                    "importance_score": 0,
                    "importance_reason": "",
                    "category": "foreign",
                    "source": name,
                    "_lang": source.get("lang", "zh"),
                    "_title": title,
                })
            except Exception:
                continue
        with _rss_lock:
            _rss_retry_state.pop(name, None)
        log(f"✅ [RSS引擎] {name} 成功解析 {len(source_news)} 条")
        return source_news
    except Exception as e:
        delay = _record_rss_failure(name)
        log(f"❌ [RSS引擎] {name} 失败（{int(delay)}s 后重试）: {e}")
        return []


def fetch_rss_news(sources=None):
    log(f"[{get_beijing_time().strftime('%H:%M:%S')}][RSS引擎] 开始并发抓取全球媒体...")
    target_sources = list(sources if sources is not None else RSS_SOURCES)
    if not target_sources:
        return []

    all_rss_news = []
    workers = min(4, len(target_sources))
    with ThreadPoolExecutor(max_workers=workers) as executor:
        for batch in executor.map(_fetch_single_rss, target_sources):
            all_rss_news.extend(batch)

    en_titles = [n["_title"] for n in all_rss_news if n.get("_lang") == "en" and n.get("_title")]
    if en_titles:
        translations = translate_batch(en_titles)
        for n in all_rss_news:
            if n.get("_lang") == "en":
                zh = translations.get(n["_title"], "").strip()
                if zh and zh != n["_title"]:
                    n["display_content"] = f"【{n['source']}】{zh}"
        log(f"✅ [RSS引擎] 英文源标题翻译 {len(en_titles)} 条完成")

    for n in all_rss_news:
        importance_text = " ".join(filter(None, [n.get("content"), n.get("display_content")]))
        importance_score, importance_reason = classify_news_importance(importance_text)
        n["importance_score"] = importance_score
        n["importance_reason"] = importance_reason
        n["is_important"] = importance_score >= IMPORTANCE_THRESHOLD
        n.pop("_lang", None)
        n.pop("_title", None)

    try:
        _persist_translate_cache()
    except Exception as e:
        log(f"⚠️ [翻译引擎] 缓存落盘失败，将在下轮重试: {e}")
    return all_rss_news
