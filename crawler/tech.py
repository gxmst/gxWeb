"""Tech trend aggregators (GitHub Trends, Hacker News, V2EX) in structured JSON + legacy HTML."""
import hashlib
import os

import feedparser

from .config import GITHUB_CACHE_PATH, LEGACY_GITHUB_CACHE_PATH
from .io_utils import (
    atomic_save_json,
    cleanup_legacy_cache,
    escape_text,
    get_beijing_time,
    get_random_ua,
    get_session,
    load_cache_with_legacy,
    sanitize_url,
)
from .log_utils import log
from .translator import _persist_translate_cache, translate_batch


def fetch_github_trends(days=7, limit=10):
    from datetime import datetime, timedelta, timezone

    since_date = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d")
    url = f"https://api.github.com/search/repositories?q=created:>{since_date}&sort=stars&order=desc"
    headers = {
        "User-Agent": get_random_ua(),
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    github_token = os.getenv("GITHUB_TOKEN", "").strip()
    if github_token:
        headers["Authorization"] = f"Bearer {github_token}"

    timeout = float(os.getenv("GITHUB_API_TIMEOUT", "20"))
    resp = get_session().get(url, headers=headers, timeout=(5, timeout))
    resp.raise_for_status()
    data = resp.json()
    if not isinstance(data, dict):
        raise ValueError("GitHub API response format is invalid")
    return data.get("items", [])[:limit]


def _format_stars(stars):
    stars = int(stars or 0)
    if stars >= 1000:
        return f"{stars / 1000:.1f}k"
    return str(stars)


def build_github_data(sections):
    """构造 GitHub Trends 结构化展示数据与纯文本检索摘要。"""
    descs = [
        (repo.get("description") or "No description")[:200]
        for section in sections
        for repo in section["items"]
    ]
    translations = translate_batch(descs) if descs else {}

    search_terms = ["GitHub Trends"]
    structured_sections = []
    for section in sections:
        items = []
        for i, repo in enumerate(section["items"]):
            name = str(repo.get("full_name") or "").strip()
            raw_stars = int(repo.get("stargazers_count") or 0)
            desc_en = (repo.get("description") or "No description")[:200]
            desc_zh = translations.get(desc_en, desc_en)
            items.append({
                "rank": f"{i + 1:02d}",
                "title": name,
                "url": sanitize_url(repo.get("html_url")),
                "stars": _format_stars(raw_stars),
                "raw_stars": raw_stars,
                "desc_en": desc_en,
                "desc_zh": desc_zh if desc_zh and desc_zh != desc_en else "",
            })
            if name:
                search_terms.append(name)
            if desc_zh and desc_zh != desc_en:
                search_terms.append(desc_zh)
            elif desc_en and desc_en != "No description":
                search_terms.append(desc_en)
        structured_sections.append({
            "label": section["label"],
            "compact": False,
            "items": items,
        })

    tech_data = {
        "brand": "GitHub Trends",
        "dot_color": "bg-purple-400",
        "sections": structured_sections,
    }
    return " · ".join(search_terms), tech_data


def build_hn_data(hn_entries, hn_titles, hn_zh_map):
    """构造 Hacker News 结构化展示数据与纯文本检索摘要。"""
    search_terms = ["Hacker News"]
    items = []
    for i, entry in enumerate(hn_entries):
        title_en = hn_titles[i]
        title_zh = hn_zh_map.get(title_en, title_en)
        items.append({
            "rank": f"{i + 1:02d}",
            "title": title_en,
            "url": sanitize_url(entry.get("link")),
            "desc_zh": title_zh if title_zh and title_zh != title_en else "",
        })
        if title_en:
            search_terms.append(title_en)
        if title_zh and title_zh != title_en:
            search_terms.append(title_zh)

    tech_data = {
        "brand": "Hacker News",
        "dot_color": "bg-amber-400",
        "sections": [{"label": "", "compact": False, "items": items}],
    }
    return " · ".join(search_terms), tech_data


def build_v2ex_data(hot_topics, new_topics):
    """构造 V2EX 结构化展示数据与纯文本检索摘要。"""
    search_terms = ["V2EX"]
    structured_sections = []
    for label, topics in (("Hot Topics", hot_topics), ("Latest", new_topics)):
        items = []
        for i, entry in enumerate(topics):
            title = str(entry.get("title") or "").strip()
            topic_id = entry.get("id")
            items.append({
                "rank": f"{i + 1:02d}",
                "title": title,
                "url": sanitize_url(f"https://www.v2ex.com/t/{topic_id}"),
            })
            if title:
                search_terms.append(title)
        structured_sections.append({
            "label": label,
            "compact": True,
            "items": items,
        })

    tech_data = {
        "brand": "V2EX",
        "dot_color": "bg-sky-400",
        "sections": structured_sections,
    }
    return " · ".join(search_terms), tech_data


def build_github_html(sections):
    """保留兼容 HTML 生成器，供旧调用或单元测试回归验证。"""
    descs = [
        (repo.get("description") or "No description")[:200]
        for section in sections
        for repo in section["items"]
    ]
    translations = translate_batch(descs) if descs else {}

    github_html = '<div class="tech-block-header"><span class="tech-brand-dot bg-purple-400"></span><span>GitHub Trends</span></div>'
    for section in sections:
        github_html += f'<div class="tech-section-label">{escape_text(section["label"])}</div>'
        github_html += '<div class="tech-card-list">'
        for i, repo in enumerate(section["items"]):
            name = escape_text(repo.get("full_name"))
            stars_str = _format_stars(repo.get("stargazers_count"))
            desc_en_raw = (repo.get("description") or "No description")[:200]
            desc_en = escape_text(desc_en_raw)
            desc_zh_raw = translations.get(desc_en_raw, desc_en_raw)
            desc_zh = escape_text(desc_zh_raw)
            repo_url = escape_text(sanitize_url(repo.get("html_url")))
            github_html += '<div class="tech-card-item">'
            github_html += '<div class="tech-card-top">'
            github_html += f'<span class="tech-rank">{i+1:02d}</span>'
            github_html += f'<a href="{repo_url}" target="_blank" rel="noopener noreferrer" class="tech-title-link">{name}</a>'
            github_html += f'<span class="tech-star-pill" title="{int(repo.get("stargazers_count") or 0)} Stars">★ {stars_str}</span>'
            github_html += "</div>"
            github_html += f'<div class="tech-desc-en">{desc_en}</div>'
            if desc_zh and desc_zh != desc_en:
                github_html += f'<div class="tech-desc-zh">{desc_zh}</div>'
            github_html += "</div>"
        github_html += "</div>"
    return github_html


def build_hn_html(hn_entries, hn_titles, hn_zh_map):
    hn_html = '<div class="tech-block-header"><span class="tech-brand-dot bg-amber-400"></span><span>Hacker News</span></div>'
    hn_html += '<div class="tech-card-list">'
    for i, entry in enumerate(hn_entries):
        title_en_raw = hn_titles[i]
        title_en = escape_text(title_en_raw)
        title_zh_raw = hn_zh_map.get(title_en_raw, title_en_raw)
        title_zh = escape_text(title_zh_raw)
        entry_url = escape_text(sanitize_url(entry.get("link")))
        hn_html += '<div class="tech-card-item">'
        hn_html += '<div class="tech-card-top">'
        hn_html += f'<span class="tech-rank">{i+1:02d}</span>'
        hn_html += f'<a href="{entry_url}" target="_blank" rel="noopener noreferrer" class="tech-title-link">{title_en}</a>'
        hn_html += "</div>"
        if title_zh and title_zh != title_en:
            hn_html += f'<div class="tech-desc-zh">{title_zh}</div>'
        hn_html += "</div>"
    hn_html += "</div>"
    return hn_html


def build_v2ex_html(hot_topics, new_topics):
    v2ex_html = '<div class="tech-block-header"><span class="tech-brand-dot bg-sky-400"></span><span>V2EX</span></div>'
    for label, topics in (("Hot Topics", hot_topics), ("Latest", new_topics)):
        v2ex_html += f'<div class="tech-section-label">{escape_text(label)}</div>'
        v2ex_html += '<div class="tech-card-list">'
        for i, entry in enumerate(topics):
            entry_title = escape_text(entry.get("title", "").strip())
            entry_url = escape_text(sanitize_url(f'https://www.v2ex.com/t/{entry.get("id")}'))
            v2ex_html += '<div class="tech-card-item tech-card-compact">'
            v2ex_html += '<div class="tech-card-top">'
            v2ex_html += f'<span class="tech-rank">{i+1:02d}</span>'
            v2ex_html += f'<a href="{entry_url}" target="_blank" rel="noopener noreferrer" class="tech-title-link font-normal">{entry_title}</a>'
            v2ex_html += "</div></div>"
        v2ex_html += "</div>"
    return v2ex_html


def _make_tech_block(source, time_str, ts, content, tech_data):
    # HTTP 200 也可能是维护页或空列表；不能用只有品牌名称的空块替换成功快照。
    if not any(
        isinstance(item, dict) and str(item.get("title") or "").strip() and sanitize_url(item.get("url"))
        for section in tech_data.get("sections", [])
        for item in section.get("items", [])
    ):
        raise ValueError(f"{source} returned no valid trend items")
    content_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()[:16]
    return {
        "id": f"tech-{source}-{content_hash}",
        "time": time_str,
        "raw_time": ts,
        "content": content,
        "tech_data": tech_data,
        "url": "",
        "is_important": False,
        "category": "tech",
        "source": source,
        "format": "tech",
    }


def fetch_tech_news():
    log(f"[{get_beijing_time().strftime('%H:%M:%S')}][tech] fetching trend blocks...")
    tech_blocks = []
    now_bj = get_beijing_time()
    ts = int(now_bj.timestamp())
    time_str = now_bj.strftime("%H:%M")

    try:
        github_sections = [
            {"label": "Last 7 Days", "items": fetch_github_trends(days=7, limit=10)},
            {"label": "Last 30 Days", "items": fetch_github_trends(days=30, limit=10)},
        ]
        summary, tech_data = build_github_data(github_sections)
        tech_block = _make_tech_block("github", time_str, ts, summary, tech_data)
        atomic_save_json(GITHUB_CACHE_PATH, tech_block, compact=True)
        cleanup_legacy_cache(LEGACY_GITHUB_CACHE_PATH)
        tech_blocks.append(tech_block)
        log("[tech] GitHub block updated")
    except Exception as e:
        cached_github = load_cache_with_legacy(
            GITHUB_CACHE_PATH, LEGACY_GITHUB_CACHE_PATH, default={}
        )
        if cached_github:
            tech_blocks.append(cached_github)
            log(f"⚠️ [tech] GitHub request failed, using cached block: {e}")
        else:
            log(f"❌ [tech] GitHub request failed: {e}")

    try:
        resp = get_session().get(
            "https://hnrss.org/frontpage?points=50",
            headers={"User-Agent": get_random_ua()},
            timeout=15,
        )
        if resp.status_code == 200:
            feed = feedparser.parse(resp.text)
            hn_entries = feed.entries[:10]
            hn_titles = [entry.get("title", "").strip() for entry in hn_entries]
            hn_zh_map = translate_batch(hn_titles)
            summary, tech_data = build_hn_data(hn_entries, hn_titles, hn_zh_map)
            tech_blocks.append(_make_tech_block("hn", time_str, ts, summary, tech_data))
            log("[tech] HN block updated")
    except Exception as e:
        log(f"❌ [tech] HN request failed: {e}")

    try:
        hot_resp = get_session().get(
            "https://www.v2ex.com/api/topics/hot.json",
            headers={"User-Agent": get_random_ua()},
            timeout=15,
        )
        new_resp = get_session().get(
            "https://www.v2ex.com/api/topics/latest.json",
            headers={"User-Agent": get_random_ua()},
            timeout=15,
        )
        if hot_resp.status_code == 200 and new_resp.status_code == 200:
            hot_topics = hot_resp.json()
            new_topics = new_resp.json()
            summary, tech_data = build_v2ex_data(hot_topics[:30], new_topics[:20])
            tech_blocks.append(_make_tech_block("v2ex", time_str, ts, summary, tech_data))
            log("[tech] V2EX block updated")
    except Exception as e:
        log(f"❌ [tech] V2EX request failed: {e}")

    try:
        _persist_translate_cache()
    except Exception as e:
        log(f"⚠️ [翻译引擎] 缓存落盘失败，将在下轮重试: {e}")
    return tech_blocks
