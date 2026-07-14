import re
import json
import time
import os
import html
import signal
import hashlib
import requests
import feedparser
import calendar
import random
import threading
import logging
from json import JSONDecodeError
from datetime import datetime, timedelta, timezone
from PIL import Image
import io
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from urllib.parse import urlparse
from concurrent.futures import ThreadPoolExecutor, as_completed

# ================= 日志 =================
# 用标准 logging 取代 print，便于 `docker logs ... | grep ERROR` 过滤。
# 保留消息里的 emoji 前缀作为视觉标记，由 log() 自动按前缀分级到对应 logging level。
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
_logger = logging.getLogger("spider")

def log(msg):
    """按 emoji 前缀自动分级：❌/🚨 → ERROR，⚠️ → WARNING，其它 → INFO。
    保留 print 风格的调用现场，只把输出通道换成 logging。"""
    s = str(msg).lstrip()
    if s.startswith(("❌", "🚨")):
        _logger.error(msg)
    elif s.startswith("⚠️"):
        _logger.warning(msg)
    else:
        _logger.info(msg)

# ================= 配置与工具 =================
USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Edge/121.0.0.0"
]

MARKET_TICKERS = [
    {"symbol": "shcomp", "name": "上证综指", "category": "亚太", "decimals": 2, "sina": "s_sh000001", "tencent": "sh000001"},
    {"symbol": "dji", "name": "道琼斯", "category": "美股", "decimals": 2, "sina": "gb_dji", "tencent": "usDJI"},
    {"symbol": "ixic", "name": "纳斯达克", "category": "美股", "decimals": 2, "sina": "gb_ixic", "tencent": "usIXIC"},
    {"symbol": "nvda", "name": "英伟达", "category": "美股", "decimals": 2, "sina": "gb_nvda", "tencent": "usNVDA"},
    {"symbol": "gc00y", "name": "COMEX黄金", "category": "商品", "decimals": 2, "sina": "hf_GC"},
    {"symbol": "si00y", "name": "COMEX白银", "category": "商品", "decimals": 3, "sina": "hf_SI"},
    {"symbol": "hg00y", "name": "COMEX铜", "category": "商品", "decimals": 4, "sina": "hf_HG"},
    {"symbol": "cl00y", "name": "WTI原油", "category": "商品", "decimals": 2, "sina": "hf_CL"},
    {"symbol": "usdcny", "name": "美元/人民币", "category": "外汇", "decimals": 4, "sina": "fx_susdcny"},
    {"symbol": "usdjpy", "name": "美元/日元", "category": "外汇", "decimals": 3, "sina": "fx_susdjpy"},
    {"symbol": "n225", "name": "日经225", "category": "亚太", "decimals": 2, "sina": "b_NIKKEI225"},
    {"symbol": "hsi", "name": "恒生指数", "category": "亚太", "decimals": 2, "sina": "rt_hkHSI", "tencent": "hkHSI"},
    {"symbol": "kospi200", "name": "KOSPI 200", "category": "亚太", "decimals": 2, "sina": "b_KS200F"},
    {"symbol": "spx", "name": "标普500", "category": "美股", "decimals": 2, "sina": "gb_inx", "tencent": "usINX"},
    {"symbol": "ftse", "name": "富时100", "category": "欧洲", "decimals": 2, "sina": "b_FTSE"},
    {"symbol": "gdaxi", "name": "DAX 40", "category": "欧洲", "decimals": 2, "sina": "b_DAX"},
    {"symbol": "fchi", "name": "CAC 40", "category": "欧洲", "decimals": 2, "sina": "b_CAC"},
    {"symbol": "twii", "name": "台湾加权", "category": "亚太", "decimals": 2, "sina": "b_TWSE"},
    {"symbol": "sensex", "name": "印度Sensex", "category": "亚太", "decimals": 2, "sina": "b_SENSEX"},
    {"symbol": "as51", "name": "澳洲200", "category": "亚太", "decimals": 2, "sina": "b_AS51"},
]

def get_random_ua():
    return random.choice(USER_AGENTS)

def build_http_session():
    retry = Retry(
        # 每个请求最多 3 次（首次 + 2 次重试）。调用方不再叠加手工重试，
        # 避免故障时一次抓取被放大成十几次请求并拖垮调度周期。
        total=2,
        connect=2,
        read=2,
        backoff_factor=0.5,
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=["GET"],
        raise_on_status=False
    )
    session = requests.Session()
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    return session

GITHUB_CACHE_PATH = "./public/github-tech-cache-v2.json"

# 线程本地 Session：requests.Session 并非完全线程安全（底层连接池在并发下可能串数据）。
# 快/慢两个工作线程各自持有独立 Session，互不干扰。
_thread_local = threading.local()

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
        raise ValueError(f"{context} 返回非 JSON 内容，status={response.status_code}, body={snippet}") from e

def build_ticker_entry(config, price, previous_close, source=None):
    if price is None:
        raise ValueError(f"{config['symbol']} 缺少当前价格")
    if previous_close in (None, 0):
        raise ValueError(f"{config['symbol']} 缺少昨收价格")

    change_pct = ((float(price) - float(previous_close)) / float(previous_close)) * 100
    return {
        "name": config["name"],
        "price": format_market_price(float(price), config["decimals"]),
        "symbol": config["symbol"],
        "change": f"{change_pct:+.2f}%",
        "category": config["category"],
        "source": source or "Sina"
    }

def _atomic_write(path, write_callback):
    """先写同目录临时文件再替换目标；失败时保留旧文件并向上抛出。"""
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

def atomic_save_json(path, data):
    """原子写 JSON。成功返回 True，失败记录日志并抛出原始异常。"""
    return _atomic_write(
        path,
        lambda f: json.dump(data, f, ensure_ascii=False, indent=2)
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

def get_beijing_time():
    return datetime.now(timezone(timedelta(hours=8)))

def clean_html(text):
    if not text: return ""
    clean = re.sub(r'<[^>]+>', '', text)
    return clean.replace('&nbsp;', ' ').replace('&mdash;', '—').strip()

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

TRANSLATE_CACHE_PATH = "./public/translate-cache.json"
TRANSLATE_CACHE_MAX = 2000
try:
    TRANSLATE_API_TIMEOUT = max(
        1.0, float(os.getenv("TRANSLATE_API_TIMEOUT", "15"))
    )
except ValueError:
    TRANSLATE_API_TIMEOUT = 15.0
_translate_cache = {}
_translate_lock = threading.Lock()
_translate_dirty = False

def _translate_text(text):
    """通过 Google Translate 公共 HTTP 端点翻译，避免引入无修复版本的第三方安装包。"""
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
    """启动时从磁盘加载翻译缓存——避免容器重启后重新翻译已知文本。"""
    global _translate_cache
    data = atomic_load_json(TRANSLATE_CACHE_PATH, default={})
    if isinstance(data, dict):
        _translate_cache = data
        log(f"✅ [翻译引擎] 从磁盘加载 {len(_translate_cache)} 条翻译缓存。")

def _persist_translate_cache():
    """把内存缓存落盘。由调用方在批量翻译结束后触发，避免每条都写盘。"""
    global _translate_dirty
    with _translate_lock:
        if not _translate_dirty:
            return False
        snapshot = dict(_translate_cache)
    # 写盘失败会抛出；dirty 保持 True，下一批仍会重试。
    atomic_save_json(TRANSLATE_CACHE_PATH, snapshot)
    with _translate_lock:
        # 保存期间若有新翻译写入，不可把新变化误标为已落盘。
        if _translate_cache == snapshot:
            _translate_dirty = False
    return True

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
        if len(_translate_cache) > TRANSLATE_CACHE_MAX:
            for k in list(_translate_cache.keys())[:200]:
                del _translate_cache[k]
    return translated

def translate_batch(texts, max_workers=4):
    """并发翻译一批文本，返回 {原文: 译文}。

    旧实现每条 sleep 0.5s 串行，HN 10 条 + GitHub 20 条要 ~15s。
    现改为 ThreadPoolExecutor 并发，命中缓存的不发请求；未命中的整体节流靠 max_workers 控制（默认 4 并发约等于 2 QPS）。
    """
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
            # 原文只是本轮展示降级，不代表一次成功翻译；失败结果不能污染持久缓存。
            if succeeded:
                with _translate_lock:
                    _translate_cache[key] = translated
                    _translate_dirty = True

    with _translate_lock:
        if len(_translate_cache) > TRANSLATE_CACHE_MAX:
            for k in list(_translate_cache.keys())[:200]:
                del _translate_cache[k]

    return result

# ================= 引擎 1：必应壁纸 =================
def fetch_bing_wallpaper():
    log(f"[{get_beijing_time().strftime('%H:%M:%S')}][壁纸引擎] 正在检查今日必应壁纸...")
    try:
        url = "https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=5&mkt=zh-CN"
        headers = {"User-Agent": get_random_ua()}
        metadata_resp = get_session().get(url, headers=headers, timeout=10)
        metadata_resp.raise_for_status()
        data = metadata_resp.json()
        images = data.get("images") or []
        if not images:
            raise ValueError("必应未返回图片列表")

        # 先把新图下到内存里全部就绪，再原子化替换旧文件——
        # 防止下到一半失败时，磁盘上同时存在新旧两批 bg_*.jpg，wallpapers.json 误列。
        new_images = []
        for i, item in enumerate(images):
            img_url = "https://www.bing.com" + item["url"]
            img_resp = get_session().get(img_url, headers={"User-Agent": get_random_ua()}, timeout=15)
            img_resp.raise_for_status()
            img_data = img_resp.content
            new_images.append((i, Image.open(io.BytesIO(img_data)).convert('RGB')))

        # 原子化替换：先写 bg_N.jpg.tmp，全部 save 成功后再逐个 os.replace 就位。
        # 这样即使 save 中途因磁盘满/权限失败，旧 bg_*.jpg 仍完好——避免"删了旧图又没写成新图"
        # 导致 wallpapers.json 下一轮只剩收藏图。
        tmp_paths = []
        try:
            for i, img in new_images:
                tmp_path = f"./public/bg_{i}.jpg.tmp"
                img.save(tmp_path, "JPEG", quality=82)
                tmp_paths.append((i, tmp_path))
        except Exception:
            # 任一 save 失败：清掉已写的 .tmp，旧壁纸原样保留，本轮放弃更新。
            for _, tmp_path in tmp_paths:
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass
            raise

        new_indices = {i for i, _ in tmp_paths}
        for i, tmp_path in tmp_paths:
            os.replace(tmp_path, f"./public/bg_{i}.jpg")
            log(f"✅ [壁纸引擎] bg_{i}.jpg 下载并压缩成功。")

        # 清理多余旧图（昨天 5 张今天 3 张时，bg_3/bg_4 需删除，否则被 wallpapers.json 误列）
        for old in os.listdir("./public"):
            if old.startswith("bg_") and old.endswith(".jpg"):
                try:
                    idx = int(old[len("bg_"):-len(".jpg")])
                except ValueError:
                    continue
                if idx not in new_indices:
                    try:
                        os.remove(os.path.join("./public", old))
                    except OSError as e:
                        log(f"⚠️ [壁纸引擎] 清理旧壁纸 {old} 失败: {e}")
        return len(new_images)
    except Exception as e:
        log(f"❌ [壁纸引擎] 获取失败: {e}")
        raise

def update_wallpaper_list():
    favorite_dir = "./public/favorite"
    os.makedirs(favorite_dir, exist_ok=True)

    favorite_files = []
    try:
        files = os.listdir(favorite_dir)
        for f in files:
            if f.lower().endswith(('.jpg', '.jpeg', '.png', '.webp')):
                favorite_files.append(f"favorite/{f}")
    except Exception as e:
        log(f"❌ [壁纸引擎] 扫描收藏夹失败: {e}")
        # 扫描失败时不能把现有收藏列表覆盖成空。
        raise

    bing_files = [f"bg_{i}.jpg" for i in range(5) if os.path.exists(f"./public/bg_{i}.jpg")]
    wallpapers = favorite_files + bing_files

    if atomic_save_json("./public/wallpapers.json", wallpapers):
        log(f"✅ [壁纸引擎] 已更新 wallpapers.json，共包含 {len(wallpapers)} 张壁纸。")
    return len(wallpapers)

# ================= 引擎 2：新浪快讯 =================
SINA_PAGES = 3  # 该接口 page_size 上限 100/页，翻 3 页 ≈ 300 条

def _fetch_sina_page(page):
    """抓单页新浪快讯；连接与状态码重试统一交给 Session 的 Retry。"""
    url = f"https://zhibo.sina.com.cn/api/zhibo/feed?page={page}&page_size=100&zhibo_id=152"
    headers = {"User-Agent": get_random_ua()}
    resp = get_session().get(url, headers=headers, timeout=15)
    resp.raise_for_status()
    data = parse_json_response(resp, f"新浪快讯第 {page} 页")
    items = data.get("result", {}).get("data", {}).get("feed", {}).get("list", [])

    page_news = []
    for item in items:
        clean_txt = clean_html(item.get("rich_text", "").replace("<br>", ""))
        if not clean_txt:
            continue
        is_important = str(item.get("focus", "0")) == "1" or str(item.get("is_top", "0")) == "1"
        ts_val = item.get("create_time")
        try:
            if isinstance(ts_val, str):
                # 新浪返回北京时间但不带时区；显式附加 UTC+8，避免容器使用 UTC 时 raw_time 偏 8 小时。
                dt = datetime.strptime(ts_val, '%Y-%m-%d %H:%M:%S').replace(
                    tzinfo=timezone(timedelta(hours=8))
                )
                ts = int(dt.timestamp())
                time_str = dt.strftime('%H:%M')
            else:
                ts = int(ts_val)
                time_str = (datetime.fromtimestamp(ts, tz=timezone.utc).astimezone(timezone(timedelta(hours=8)))).strftime('%H:%M')
        except Exception:
            now = get_beijing_time(); ts = int(now.timestamp()); time_str = now.strftime('%H:%M')
        page_news.append({
            "time": time_str,
            "raw_time": ts,
            "content": f"【新浪】{clean_txt}",
            "url": "",
            "is_important": is_important,
            "category": "news",
            "source": "sina"
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

# ================= 引擎 3：强化版 RSS 引擎 =================
def fetch_rss_news():
    log(f"[{get_beijing_time().strftime('%H:%M:%S')}][RSS引擎] 开始抓取全球顶级媒体...")
    # lang="en" 的源：标题会被批量翻成中文写入 display_content（前端优先展示 display_content）。
    # 中文源不带 lang，原样展示。新增 5 个英文源均为长期稳定的标准 RSS 端点；
    # 某个源不可达时由下方 try/except 跳过，不影响其它源。
    rss_sources = [
        {"name": "华尔街日报", "url": "https://cn.wsj.com/zh-hans/rss"},
        {"name": "FT中文网", "url": "https://www.ftchinese.com/rss/feed"},
        {"name": "纽约时报", "url": "https://cn.nytimes.com/rss/"},
        {"name": "BBC", "url": "https://feeds.bbci.co.uk/zhongwen/simp/rss.xml"},
        {"name": "联合早报", "url": "https://www.zaobao.com.sg/realtime/world/rss"},
        {"name": "Yahoo", "url": "https://finance.yahoo.com/news/rssindex", "lang": "en"},
        {"name": "CNBC", "url": "https://search.cnbc.com/rs/search/combinedcms/view.xml?id=10000664", "lang": "en"},
        {"name": "FT", "url": "https://www.ft.com/?format=rss", "lang": "en"},
        {"name": "卫报", "url": "https://www.theguardian.com/world/rss", "lang": "en"},
        {"name": "半岛电视台", "url": "https://www.aljazeera.com/xml/rss/all.xml", "lang": "en"},
        {"name": "NPR", "url": "https://feeds.npr.org/1004/rss.xml", "lang": "en"},
        {"name": "德国之声", "url": "https://rss.dw.com/rdf/rss-en-all", "lang": "en"},
        {"name": "法广", "url": "https://www.france24.com/en/rss", "lang": "en"}
    ]
    all_rss_news = []
    for source in rss_sources:
        source_news = []
        try:
            headers = {"User-Agent": get_random_ua()}
            resp = get_session().get(source["url"], headers=headers, timeout=15)
            if resp.status_code != 200: continue
            feed = feedparser.parse(resp.text)
            for entry in feed.entries[:40]:
                try:
                    title = entry.get("title", "").strip()
                    link = entry.get("link", "")
                    if not title: continue
                    ts = int(get_beijing_time().timestamp())
                    pub_parsed = entry.get("published_parsed")
                    if pub_parsed: ts = calendar.timegm(pub_parsed)
                    time_str = (datetime.fromtimestamp(ts, tz=timezone.utc).astimezone(timezone(timedelta(hours=8)))).strftime('%H:%M')
                    source_news.append({
                        "time": time_str,
                        "raw_time": ts,
                        "content": f"【{source['name']}】{title}",
                        "url": sanitize_url(link),
                        "is_important": False,
                        "category": "foreign",
                        "source": source["name"],
                        "_lang": source.get("lang", "zh"),
                        "_title": title
                    })
                except Exception as e: continue
            log(f"✅ [RSS引擎] {source['name']} 成功解析 {len(source_news)} 条")
            all_rss_news.extend(source_news)
        except Exception as e: log(f"❌ [RSS引擎] {source['name']} 失败: {e}")

    # 英文源标题批量翻译 → display_content（命中缓存零开销；失败回退原标题）。
    en_titles = [n["_title"] for n in all_rss_news if n.get("_lang") == "en" and n.get("_title")]
    if en_titles:
        translations = translate_batch(en_titles)
        for n in all_rss_news:
            if n.get("_lang") == "en":
                zh = translations.get(n["_title"], "").strip()
                if zh and zh != n["_title"]:
                    n["display_content"] = f"【{n['source']}】{zh}"
        log(f"✅ [RSS引擎] 英文源标题翻译 {len(en_titles)} 条完成")

    # 清理内部临时字段，保持 finance-news.json 干净
    for n in all_rss_news:
        n.pop("_lang", None)
        n.pop("_title", None)
    return all_rss_news

# ================= 引擎 4：科技趋势聚合 (V2EX, HN, GitHub) =================
def fetch_github_trends(days=7, limit=10):
    since_date = (datetime.now(timezone.utc) - timedelta(days=days)).strftime('%Y-%m-%d')
    url = f"https://api.github.com/search/repositories?q=created:>{since_date}&sort=stars&order=desc"
    headers = {
        "User-Agent": get_random_ua(),
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
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

def build_github_html(sections):
    # 先把所有需要翻译的 description 一次性 batch 翻译，避免逐条串行。
    descs = []
    for section in sections:
        for repo in section["items"]:
            descs.append((repo.get("description") or "No description")[:200])
    translations = translate_batch(descs) if descs else {}

    github_html = '<div class="font-semibold text-white mb-3">GitHub Trends</div>'
    for section in sections:
        github_html += f'<div class="text-white/60 text-xs uppercase tracking-[0.2em] mt-4 mb-2">{escape_text(section["label"])}</div>'
        for i, repo in enumerate(section["items"]):
            name = escape_text(repo.get("full_name"))
            stars = int(repo.get("stargazers_count") or 0)
            desc_en_raw = (repo.get("description") or "No description")[:200]
            desc_en = escape_text(desc_en_raw)
            desc_zh = escape_text(translations.get(desc_en_raw, desc_en_raw))
            repo_url = escape_text(sanitize_url(repo.get("html_url")))
            github_html += f'<div class="group mb-3 border-b border-white/5 pb-2 last:border-0">'
            github_html += f'<a href="{repo_url}" target="_blank" rel="noopener noreferrer" class="font-bold text-blue-400 hover:text-blue-300 transition-colors">{i+1}. {name} (STAR {stars})</a>'
            github_html += f'<div class="text-white/80 text-sm mt-1">{desc_en}</div>'
            github_html += f'<div class="overflow-hidden max-h-0 opacity-0 group-hover:max-h-24 group-hover:opacity-100 transition-all duration-500 ease-in-out text-white/50 text-xs mt-1">ZH: {desc_zh}</div></div>'
    return github_html

def build_v2ex_html(hot_topics, new_topics):
    v2ex_html = '<div class="font-semibold text-white mb-3">V2EX</div>'

    v2ex_html += '<div class="text-white/60 text-xs uppercase tracking-[0.2em] mt-4 mb-2">Hot</div>'
    for i, entry in enumerate(hot_topics):
        entry_title = escape_text(entry.get("title", "").strip())
        entry_url = escape_text(sanitize_url(f'https://www.v2ex.com/t/{entry.get("id")}'))
        v2ex_html += f'<div class="mb-3 border-b border-white/5 pb-2 last:border-0">'
        v2ex_html += f'<a href="{entry_url}" target="_blank" rel="noopener noreferrer" class="text-blue-400 hover:text-blue-300 transition-colors">{i+1}. {entry_title}</a></div>'

    v2ex_html += '<div class="text-white/60 text-xs uppercase tracking-[0.2em] mt-4 mb-2">New</div>'
    for i, entry in enumerate(new_topics):
        entry_title = escape_text(entry.get("title", "").strip())
        entry_url = escape_text(sanitize_url(f'https://www.v2ex.com/t/{entry.get("id")}'))
        v2ex_html += f'<div class="mb-3 border-b border-white/5 pb-2 last:border-0">'
        v2ex_html += f'<a href="{entry_url}" target="_blank" rel="noopener noreferrer" class="text-blue-400 hover:text-blue-300 transition-colors">{i+1}. {entry_title}</a></div>'

    return v2ex_html

# ================= 引擎 5：稳定天气 (Open-Meteo) =================
def fetch_weather():
    try:
        url = "https://api.open-meteo.com/v1/forecast?latitude=41.80&longitude=123.43&current_weather=true"
        headers = {"User-Agent": get_random_ua()}
        response = get_session().get(url, headers=headers, timeout=10)
        response.raise_for_status()
        payload = response.json()
        curr = payload.get("current_weather", {})
        temp, code = curr.get("temperature"), curr.get("weathercode")
        if temp is None or code is None:
            raise ValueError("天气接口缺少 temperature/weathercode")
        emoji_map = {0: "☀️", 1: "☁️", 2: "☁️", 3: "☁️", 45: "🌫️", 48: "🌫️", 51: "🌧️", 53: "🌧️", 55: "🌧️", 61: "🌧️", 63: "🌧️", 65: "🌧️", 71: "❄️", 73: "❄️", 75: "❄️", 95: "⛈️"}
        emoji = emoji_map.get(code, "☁️")
        if 71 <= code <= 77: emoji = "❄️"
        elif 51 <= code <= 67: emoji = "🌧️"
        atomic_save_text("./public/weather.txt", f"{emoji} {temp}°C")
        log("✅ [天气引擎] 天气数据已更新。")
        return 1
    except Exception as e:
        log(f"❌ [天气引擎] 失败: {e}")
        raise

# ================= 引擎 6：行情条 (Sina) =================
TICKER_FILE = "./public/ticker.json"
TICKER_STATUS_FILE = "./public/ticker-status.json"
TICKER_RETRY_MAX = 3
TICKER_RETRY_BACKOFF = [1, 2, 4]


def _fetch_sina_all(configs):
    result_map = {}
    if not configs:
        return result_map

    sina_entries = []
    for cfg in configs:
        sina_sym = cfg.get("sina")
        if sina_sym:
            sina_entries.append({"symbol": sina_sym, "canonical": cfg["symbol"], "name": cfg["name"],
                                "category": cfg["category"], "decimals": cfg["decimals"]})

    if not sina_entries:
        return result_map

    try:
        symbols = ",".join([c["symbol"] for c in sina_entries])
        url = f"https://hq.sinajs.cn/list={symbols}"
        # hq.sinajs.cn 按"请求是否像浏览器"做拦截，而非按频率：
        # Referer/Origin 必须是新浪域，否则返回 403 或空内容。
        headers = {
            "Referer": "https://finance.sina.com.cn/",
            "Origin": "https://finance.sina.com.cn",
            "Accept": "*/*",
            "User-Agent": get_random_ua(),
        }
        resp = get_session().get(url, headers=headers, timeout=15)
        resp.raise_for_status()
        # 该接口返回 GBK 编码且常不带正确 charset，显式指定避免中文乱码。
        resp.encoding = "gbk"

        sina_raw = {}
        for line in resp.text.splitlines():
            if not line or "=" not in line:
                continue
            key = line.split("=")[0].split("_str_")[-1]
            data_str = line.split("=")[1].strip('";')
            if not data_str:
                continue
            data = data_str.split(",")
            if len(data) < 2:
                continue
            sina_raw[key] = data

        for entry in sina_entries:
            raw = sina_raw.get(entry["symbol"])
            if not raw:
                continue
            try:
                p = None
                pc = None
                sym = entry["symbol"]

                # gb_: 美股 — raw[1]=当前价, raw[26]=昨收
                if sym.startswith("gb_") and len(raw) > 26:
                    p = float(raw[1])
                    pc = float(raw[26])
                # fx_: 外汇 — raw[1]=当前价, raw[3]=昨收
                elif sym.startswith("fx_") and len(raw) > 3:
                    p = float(raw[1])
                    pc = float(raw[3])
                # hf_: 期货 — raw[0]=当前价, raw[7]=昨收
                elif sym.startswith("hf_") and len(raw) > 8:
                    p = float(raw[0])
                    pc = float(raw[7])
                # rt_hk: 港股实时 — raw[6]=当前价, raw[3]=昨收
                elif sym.startswith("rt_hk") and len(raw) > 6:
                    p = float(raw[6])
                    pc = float(raw[3])
                # s_: A股简版 — raw[1]=当前价, raw[2]=涨跌额, 昨收=当前价-涨跌额
                elif sym.startswith("s_") and len(raw) > 2:
                    p = float(raw[1])
                    change_val = float(raw[2])
                    pc = p - change_val
                # b_: 全球指数 — 新浪该接口不提供实时价格字段，跳过
                elif sym.startswith("b_"):
                    continue

                if p and pc and p > 0 and pc > 0:
                    cfg_full = {"symbol": entry["canonical"], "name": entry["name"], "category": entry["category"], "decimals": entry["decimals"]}
                    result_map[entry["canonical"]] = build_ticker_entry(cfg_full, p, pc, source="Sina")
            except (ValueError, TypeError, IndexError):
                pass

    except Exception as e:
        log(f"  ⚠️ [行情引擎] Sina 抓取异常: {type(e).__name__}: {e}")

    return result_map


def _fetch_tencent_all(configs):
    """腾讯 qt.gtimg.cn 备用源。

    仅用于补齐 Sina 拉取失败的标的，反爬比新浪宽松。
    返回结构与 _fetch_sina_all 一致：{canonical_symbol: ticker_entry}。
    腾讯接口对 A股/港股/美股字段结构统一，以 '~' 分隔：
      索引 1=名称，3=当前价，4=昨收。
    """
    result_map = {}
    entries = [c for c in configs if c.get("tencent")]
    if not entries:
        return result_map

    try:
        symbols = ",".join([c["tencent"] for c in entries])
        url = f"https://qt.gtimg.cn/q={symbols}"
        headers = {"Referer": "https://gu.qq.com/", "User-Agent": get_random_ua()}
        resp = get_session().get(url, headers=headers, timeout=15)
        resp.raise_for_status()
        # 腾讯接口同样返回 GBK 编码。
        resp.encoding = "gbk"

        tencent_raw = {}
        for line in resp.text.splitlines():
            if not line or "=" not in line:
                continue
            # 形如 v_usNVDA="...~...~...";
            key = line.split("=")[0].split("_", 1)[-1]
            data_str = line.split("=", 1)[1].strip().strip('";')
            if not data_str:
                continue
            tencent_raw[key] = data_str.split("~")

        for entry in entries:
            raw = tencent_raw.get(entry["tencent"])
            if not raw or len(raw) < 5:
                continue
            try:
                p = float(raw[3])
                pc = float(raw[4])
                if p > 0 and pc > 0:
                    result_map[entry["symbol"]] = build_ticker_entry(entry, p, pc, source="Tencent")
            except (ValueError, TypeError, IndexError):
                pass

    except Exception as e:
        log(f"  ⚠️ [行情引擎] Tencent 抓取异常: {type(e).__name__}: {e}")

    return result_map


def fetch_ticker():
    ts_str = get_beijing_time().strftime('%H:%M:%S')
    log(f"[{ts_str}][行情引擎] 开始同步行情...")

    total_count = len(MARKET_TICKERS)
    result_map = {}
    stale_used = []

    old_ticker_map = {}
    if os.path.exists(TICKER_FILE):
        try:
            with open(TICKER_FILE, "r", encoding="utf-8") as f:
                for item in json.load(f):
                    sym = item.get("symbol")
                    if sym:
                        old_ticker_map[sym] = item
        except Exception:
            pass

    # 1. Sina 抓取（主源）
    sina_results = _fetch_sina_all(MARKET_TICKERS)
    for sym, entry in sina_results.items():
        result_map[sym] = entry
    sina_count = len(sina_results)

    # 2. 腾讯抓取（备用源）——仅补齐 Sina 没拿到的标的
    missing_configs = [c for c in MARKET_TICKERS if c["symbol"] not in result_map]
    tencent_count = 0
    if missing_configs:
        tencent_results = _fetch_tencent_all(missing_configs)
        for sym, entry in tencent_results.items():
            result_map[sym] = entry
        tencent_count = len(tencent_results)

    # 3. 逐标的沿用旧值——主备源都没拿到时的最后兜底
    for config in MARKET_TICKERS:
        sym = config["symbol"]
        if sym not in result_map and sym in old_ticker_map:
            result_map[sym] = old_ticker_map[sym]
            stale_used.append(config["name"])

    unique_count = len(result_map)
    threshold = max(10, int(total_count * 0.5))

    # 2.5 价格历史追踪 (sparkline 用)
    price_history_map = {}
    for sym, item in old_ticker_map.items():
        ph = item.get("price_history")
        if ph and isinstance(ph, list):
            price_history_map[sym] = ph

    for sym, entry in result_map.items():
        try:
            current_price = float(entry["price"])
            old_history = price_history_map.get(sym, [])
            new_history = old_history + [current_price]
            if len(new_history) > 20:
                new_history = new_history[-20:]
            entry["price_history"] = new_history
        except (ValueError, KeyError):
            pass

    # 3. 状态判定与写入
    fresh_count = sina_count + tencent_count
    if unique_count >= threshold and fresh_count > 0:
        atomic_save_json(TICKER_FILE, list(result_map.values()))
        if len(stale_used) > 0:
            status = "degraded"
        else:
            status = "ok"
        log(f"  ✅ [行情引擎] 本轮写入 {unique_count} 条 (阈值 {threshold}) 状态={status}")
    else:
        if os.path.exists(TICKER_FILE):
            status = "failed"
            log(
                f"  ⚠️ [行情引擎] 本轮新鲜数据 {fresh_count} 条、最终 {unique_count} 条 "
                f"(阈值 {threshold})，保留上次成功数据"
            )
        else:
            status = "failed"
            log(f"  ⚠️ [行情引擎] 本轮仅 {unique_count} 条且无历史文件，跳过写入")

    # 4. 写入状态文件
    status_payload = {
        "updated_at": int(get_beijing_time().timestamp()),
        "status": status,
        "primary_provider": "sina",
        "primary_success_count": sina_count,
        "fallback_provider": "tencent",
        "fallback_success_count": tencent_count,
        "stale_used_count": len(stale_used),
        "final_count": unique_count,
        "total_count": total_count
    }
    atomic_save_json(TICKER_STATUS_FILE, status_payload)

    # 5. 日志汇总
    log(f"  📊 [行情引擎] 总标的: {total_count} | Sina: {sina_count} | Tencent: {tencent_count} | 沿用旧值: {len(stale_used)} | 最终: {unique_count} | 状态: {status}")
    if stale_used:
        log(f"  ℹ️ [行情引擎] 沿用旧值: {', '.join(stale_used)}")
    return status_payload

# ================= 科技趋势抓取 =================
def fetch_tech_news():
    log(f"[{get_beijing_time().strftime('%H:%M:%S')}][tech] fetching trend blocks...")
    tech_blocks = []
    now_bj = get_beijing_time()
    ts = int(now_bj.timestamp())
    time_str = now_bj.strftime('%H:%M')

    try:
        github_sections = [
            {"label": "Last 7 Days", "items": fetch_github_trends(days=7, limit=10)},
            {"label": "Last 30 Days", "items": fetch_github_trends(days=30, limit=10)}
        ]
        tech_block = {
            "time": time_str,
            "raw_time": ts,
            "content": build_github_html(github_sections),
            "url": "",
            "is_important": False,
            "category": "tech",
            "source": "github",
            "format": "html"
        }
        atomic_save_json(GITHUB_CACHE_PATH, tech_block)
        tech_blocks.append(tech_block)
        log("[tech] GitHub block updated")
    except Exception as e:
        cached_github = atomic_load_json(GITHUB_CACHE_PATH, default={})
        if cached_github:
            tech_blocks.append(cached_github)
            log(f"⚠️ [tech] GitHub request failed, using cached block: {e}")
        else:
            log(f"❌ [tech] GitHub request failed: {e}")

    try:
        resp = get_session().get("https://hnrss.org/frontpage?points=50", headers={"User-Agent": get_random_ua()}, timeout=15)
        if resp.status_code == 200:
            feed = feedparser.parse(resp.text)
            hn_entries = feed.entries[:10]
            hn_titles = [entry.get("title", "").strip() for entry in hn_entries]
            hn_zh_map = translate_batch(hn_titles)
            hn_html = "HN Trends"
            for i, entry in enumerate(hn_entries):
                title_en_raw = hn_titles[i]
                title_en = escape_text(title_en_raw)
                title_zh = escape_text(hn_zh_map.get(title_en_raw, title_en_raw))
                entry_url = escape_text(sanitize_url(entry.get("link")))
                hn_html += f'<div class="group mb-3 border-b border-white/5 pb-2 last:border-0">'
                hn_html += f'<a href="{entry_url}" target="_blank" rel="noopener noreferrer" class="font-bold text-blue-400 hover:text-blue-300 transition-colors">{i+1}. {title_en}</a>'
                hn_html += f'<div class="overflow-hidden max-h-0 opacity-0 group-hover:max-h-20 group-hover:opacity-100 transition-all duration-500 ease-in-out text-white/50 text-xs mt-1">ZH: {title_zh}</div></div>'

            tech_blocks.append({
                "time": time_str,
                "raw_time": ts,
                "content": hn_html,
                "url": "",
                "is_important": False,
                "category": "tech",
                "source": "hn",
                "format": "html"
            })
            log("[tech] HN block updated")
    except Exception as e:
        log(f"❌ [tech] HN request failed: {e}")

    try:
        hot_resp = get_session().get("https://www.v2ex.com/api/topics/hot.json", headers={"User-Agent": get_random_ua()}, timeout=15)
        new_resp = get_session().get("https://www.v2ex.com/api/topics/latest.json", headers={"User-Agent": get_random_ua()}, timeout=15)
        if hot_resp.status_code == 200 and new_resp.status_code == 200:
            hot_topics = hot_resp.json()
            new_topics = new_resp.json()
            v2ex_html = build_v2ex_html(hot_topics[:30], new_topics[:20])

            tech_blocks.append({
                "time": time_str,
                "raw_time": ts,
                "content": v2ex_html,
                "url": "",
                "is_important": False,
                "category": "tech",
                "source": "v2ex",
                "format": "html"
            })
            log("[tech] V2EX block updated")
    except Exception as e:
        log(f"❌ [tech] V2EX request failed: {e}")

    # 批次结束后整体落盘——避免每条翻译都触发一次写盘 IO。
    try:
        _persist_translate_cache()
    except Exception as e:
        # 缓存只是优化项，失败不能丢弃本轮已经抓到的科技内容；dirty 会保留待下轮重试。
        log(f"⚠️ [翻译引擎] 缓存落盘失败，将在下轮重试: {e}")
    return tech_blocks

# ================= 主循环控制 =================
PIPELINE_STATUS_FILE = "./public/pipeline-status.json"
PIPELINE_JOBS = (
    "heartbeat", "ticker", "sina", "finance_news",
    "wallpaper", "weather", "wallpaper_list", "rss", "tech"
)
try:
    PIPELINE_JOB_TIMEOUT_SECONDS = max(
        1.0, float(os.getenv("PIPELINE_JOB_TIMEOUT_SECONDS", "1800"))
    )
except ValueError:
    PIPELINE_JOB_TIMEOUT_SECONDS = 1800.0


class SpiderWorkerFailure(RuntimeError):
    """工作线程死亡或任务超时时触发的进程级故障。"""


class SpiderApp:
    def __init__(self):
        self.sina_news = []
        self.rss_news = []
        self.tech_news = []
        self.last_wallpaper_date = None
        self.last_rss_time = 0
        self.last_weather_time = 0
        self.last_tech_time = 0
        self.last_wallpaper_list_time = 0
        self.shutdown = False
        self._shutdown_event = threading.Event()
        self.job_timeout_seconds = PIPELINE_JOB_TIMEOUT_SECONDS

        # 保护快/慢线程共享的新闻快照。
        self._data_lock = threading.Lock()
        self._status_lock = threading.Lock()
        self._status_write_lock = threading.Lock()
        self._pipeline_status = {
            "updated_at": int(time.time()),
            "jobs": {
                name: {
                    "last_attempt": None,
                    "last_success": None,
                    "last_error": None,
                    "duration": None,
                    "count": 0,
                    "running": False,
                }
                for name in PIPELINE_JOBS
            },
        }
        self._load_pipeline_status()
        self._load_last_known_news()

    @staticmethod
    def _dedupe_news(items, limit, *, newest_first=False):
        """过滤损坏项并按 content 去重，避免坏缓存让工作线程退出。"""
        seen = set()
        unique = []
        for item in items or []:
            if not isinstance(item, dict):
                continue
            content = item.get("content")
            if not isinstance(content, str) or not content:
                continue
            content_hash = hashlib.md5(content.encode()).hexdigest()
            if content_hash in seen:
                continue
            seen.add(content_hash)
            unique.append(item)
        if newest_first:
            unique.sort(key=lambda x: x.get("raw_time", 0), reverse=True)
        return unique[:limit]

    def _load_last_known_news(self):
        """从最终发布文件恢复有界快照，容器重启后不必先清空慢源数据。"""
        cached = atomic_load_json("./public/finance-news.json", default={})
        if not isinstance(cached, dict) or not isinstance(cached.get("news_list"), list):
            return
        items = cached["news_list"]
        self.sina_news = self._dedupe_news(
            [item for item in items if isinstance(item, dict) and item.get("source") == "sina"],
            800,
        )
        self.rss_news = self._dedupe_news(
            [item for item in items if isinstance(item, dict) and item.get("category") == "foreign"],
            500,
            newest_first=True,
        )
        self.tech_news = self._dedupe_news(
            [item for item in items if isinstance(item, dict) and item.get("category") == "tech"],
            100,
        )
        recovered = len(self.sina_news) + len(self.rss_news) + len(self.tech_news)
        if recovered:
            log(f"✅ [系统] 从 finance-news.json 恢复 {recovered} 条 last-known-good 数据。")

    def _load_pipeline_status(self):
        cached = atomic_load_json(PIPELINE_STATUS_FILE, default={})
        if not isinstance(cached, dict) or not isinstance(cached.get("jobs"), dict):
            return
        for name in PIPELINE_JOBS:
            old = cached["jobs"].get(name)
            if not isinstance(old, dict):
                continue
            state = self._pipeline_status["jobs"][name]
            for field in ("last_attempt", "last_success", "last_error", "duration", "count"):
                if field in old:
                    state[field] = old[field]
            # 重启时不存在仍在运行的旧任务。
            state["running"] = False

    def _persist_pipeline_status(self):
        """串行化两个工作线程的状态写入；状态盘失败不影响业务任务本身。"""
        try:
            with self._status_write_lock:
                with self._status_lock:
                    self._pipeline_status["updated_at"] = int(time.time())
                    snapshot = {
                        "updated_at": self._pipeline_status["updated_at"],
                        "jobs": {
                            name: dict(state)
                            for name, state in self._pipeline_status["jobs"].items()
                        },
                    }
                atomic_save_json(PIPELINE_STATUS_FILE, snapshot)
            return True
        except Exception as e:
            log(f"⚠️ [系统] pipeline-status.json 写入失败: {e}")
            return False

    def _start_job(self, name, started_at):
        with self._status_lock:
            state = self._pipeline_status["jobs"][name]
            state.update({
                "last_attempt": int(started_at),
                "last_error": None,
                "duration": None,
                "running": True,
            })
        self._persist_pipeline_status()

    def _finish_job(self, name, started_at, *, succeeded, count=0, error=None):
        finished_at = time.time()
        with self._status_lock:
            state = self._pipeline_status["jobs"][name]
            state["duration"] = round(max(0.0, time.monotonic() - started_at[1]), 3)
            state["count"] = int(count or 0)
            state["running"] = False
            state["last_error"] = None if succeeded else str(error or "unknown error")[:500]
            if succeeded:
                state["last_success"] = int(finished_at)
        self._persist_pipeline_status()

    def _run_job(self, name, callback, *, count_fn=None, success_if=None, failure_message=None):
        """执行一个隔离任务并更新统一状态；Exception 不会阻断同线程其它任务。"""
        started_wall = time.time()
        started = (started_wall, time.monotonic())
        self._start_job(name, started_wall)
        result = None
        count = 0
        try:
            result = callback()
            if count_fn is not None:
                count = count_fn(result)
            elif isinstance(result, (list, tuple, set, dict)):
                count = len(result)
            elif isinstance(result, (int, float)):
                count = int(result)
            elif result is not None:
                count = 1

            if success_if is not None and not success_if(result):
                error = failure_message or "任务返回无效结果"
                self._finish_job(name, started, succeeded=False, count=count, error=error)
                log(f"⚠️ [{name}] {error}")
                return False, result
        except Exception as e:
            error = f"{type(e).__name__}: {e}"
            self._finish_job(name, started, succeeded=False, count=count, error=error)
            log(f"❌ [{name}] 任务失败: {error}")
            return False, None

        self._finish_job(name, started, succeeded=True, count=count)
        return True, result

    def _mark_stalled_job(self, now=None):
        """返回首个超时任务；同时把超时原因写入 pipeline 状态。"""
        now = time.time() if now is None else now
        stalled = None
        with self._status_lock:
            for name, state in self._pipeline_status["jobs"].items():
                attempted = state.get("last_attempt")
                if not state.get("running") or not isinstance(attempted, (int, float)):
                    continue
                elapsed = max(0.0, now - attempted)
                if elapsed <= self.job_timeout_seconds:
                    continue
                state["running"] = False
                state["duration"] = round(elapsed, 3)
                state["last_error"] = (
                    f"任务运行超过 {self.job_timeout_seconds:g} 秒，触发进程重启"
                )
                stalled = (name, elapsed)
                break
        if stalled is not None:
            self._persist_pipeline_status()
        return stalled

    def _interruptible_sleep(self, seconds):
        if self.shutdown:
            return
        self._shutdown_event.wait(max(0.0, seconds))

    def run(self):
        if threading.current_thread() is threading.main_thread():
            signal.signal(signal.SIGTERM, self._handle_signal)
            signal.signal(signal.SIGINT, self._handle_signal)

        # 快线程：行情 + 新浪快讯 + 合并写盘；慢线程：壁纸 / 天气 / RSS / 科技。
        workers = {
            "fast": threading.Thread(target=self._fast_loop, name="fast", daemon=True),
            "slow": threading.Thread(target=self._slow_loop, name="slow", daemon=True),
        }
        for worker in workers.values():
            worker.start()

        failed_worker = None
        while not self.shutdown:
            for name, worker in workers.items():
                if not worker.is_alive():
                    failed_worker = name
                    log(f"🚨 [系统] {name} 工作线程意外退出，主进程将退出以触发容器重启。")
                    self.shutdown = True
                    self._shutdown_event.set()
                    break
            if failed_worker is None:
                stalled = self._mark_stalled_job()
                if stalled is not None:
                    job_name, elapsed = stalled
                    failed_worker = f"{job_name} job"
                    log(
                        f"🚨 [系统] {job_name} 任务已运行 {elapsed:.1f}s，超过 "
                        f"{self.job_timeout_seconds:g}s，看门狗将退出主进程。"
                    )
                    self.shutdown = True
                    self._shutdown_event.set()
            self._shutdown_event.wait(0.5)

        for worker in workers.values():
            worker.join(timeout=5)
        log("🛑 已停止所有工作线程。")

        if failed_worker is not None:
            raise SpiderWorkerFailure(f"{failed_worker} worker exited unexpectedly")

    def _touch_heartbeat(self):
        """原子更新 heartbeat；写盘失败由任务状态记录。"""
        atomic_save_text("./public/heartbeat.txt", str(int(time.time())))
        return 1

    def _merge_by_source(self, old_items, new_items, limit, *, newest_first=False):
        """新结果缺少某个来源时沿用该来源旧块，避免部分故障造成内容抖动。"""
        fresh_sources = {
            item.get("source") for item in new_items
            if isinstance(item, dict) and item.get("source")
        }
        retained = [
            item for item in old_items
            if isinstance(item, dict) and item.get("source") not in fresh_sources
        ]
        return self._dedupe_news(
            list(new_items) + retained,
            limit,
            newest_first=newest_first,
        )

    def _publish_finance_news(self):
        with self._data_lock:
            sina_snapshot = list(self.sina_news)
            rss_snapshot = list(self.rss_news)
            tech_snapshot = list(self.tech_news)

        final_news = sina_snapshot + rss_snapshot + tech_snapshot
        final_news.sort(
            key=lambda x: (x.get("is_important", False), x.get("raw_time", 0)),
            reverse=True,
        )
        if not final_news:
            return []

        output_data = {
            "last_updated": int(get_beijing_time().timestamp()),
            "news_list": final_news,
        }
        atomic_save_json("./public/finance-news.json", output_data)
        log(
            f"✅ [fast] 更新完成：总库 {len(final_news)} 条 "
            f"(新浪 {len(sina_snapshot)} / RSS {len(rss_snapshot)} / 科技 {len(tech_snapshot)})。"
        )
        return final_news

    def _fast_loop(self):
        """行情 + 新浪快讯；按单调时钟对齐 60 秒周期，不叠加抓取耗时。"""
        interval = 60.0
        next_run = time.monotonic()
        while not self.shutdown:
            now_bj = get_beijing_time()
            log(f"\n--- [fast] {now_bj.strftime('%H:%M:%S')} 行情+快讯 ---")

            self._run_job("heartbeat", self._touch_heartbeat)
            self._run_job(
                "ticker",
                fetch_ticker,
                count_fn=lambda result: result.get("final_count", 0),
                success_if=lambda result: result.get("status") != "failed",
                failure_message="行情有效数据不足，已保留上次成功文件",
            )

            sina_ok, sina_news_raw = self._run_job(
                "sina",
                fetch_sina,
                success_if=bool,
                failure_message="本轮为空，已保留上次新浪快讯",
            )
            if sina_ok:
                with self._data_lock:
                    self.sina_news = self._dedupe_news(sina_news_raw, 800)

            self._run_job(
                "finance_news",
                self._publish_finance_news,
                success_if=bool,
                failure_message="没有可发布新闻，未覆盖现有文件",
            )

            next_run += interval
            now_mono = time.monotonic()
            while next_run <= now_mono:
                next_run += interval
            self._interruptible_sleep(next_run - now_mono)

    def _slow_loop(self):
        """慢任务独立记时与报错；抓取为空时保留内存中的 last-known-good。"""
        intervals = {"weather": 1800.0, "wallpaper_list": 300.0, "rss": 1800.0, "tech": 1800.0}
        next_due = {name: 0.0 for name in intervals}
        wallpaper_retry_due = 0.0

        while not self.shutdown:
            now_mono = time.monotonic()
            today = get_beijing_time().strftime('%Y-%m-%d')

            if now_mono >= wallpaper_retry_due and (
                today != self.last_wallpaper_date or not os.path.exists("./public/bg_0.jpg")
            ):
                wallpaper_ok, _ = self._run_job(
                    "wallpaper",
                    fetch_bing_wallpaper,
                    success_if=lambda count: bool(count),
                    failure_message="本轮未获取壁纸，稍后重试",
                )
                if wallpaper_ok:
                    self.last_wallpaper_date = today
                # 失败后 5 分钟再试，避免每 30 秒轰击上游；成功后条件本身会阻止当天重复抓取。
                wallpaper_retry_due = time.monotonic() + 300.0

            if now_mono >= next_due["weather"]:
                self.last_weather_time = time.time()
                self._run_job("weather", fetch_weather)
                next_due["weather"] = time.monotonic() + intervals["weather"]

            if now_mono >= next_due["wallpaper_list"]:
                self.last_wallpaper_list_time = time.time()
                self._run_job("wallpaper_list", update_wallpaper_list)
                next_due["wallpaper_list"] = time.monotonic() + intervals["wallpaper_list"]

            if now_mono >= next_due["rss"]:
                self.last_rss_time = time.time()
                rss_ok, rss_news_raw = self._run_job(
                    "rss",
                    fetch_rss_news,
                    success_if=bool,
                    failure_message="本轮为空，已保留上次 RSS 数据",
                )
                if rss_ok:
                    with self._data_lock:
                        self.rss_news = self._merge_by_source(
                            self.rss_news, rss_news_raw, 500, newest_first=True
                        )
                next_due["rss"] = time.monotonic() + intervals["rss"]

            if now_mono >= next_due["tech"]:
                self.last_tech_time = time.time()
                tech_ok, tech_news_raw = self._run_job(
                    "tech",
                    fetch_tech_news,
                    success_if=bool,
                    failure_message="本轮为空，已保留上次科技数据",
                )
                if tech_ok:
                    with self._data_lock:
                        self.tech_news = self._merge_by_source(
                            self.tech_news, tech_news_raw, 100
                        )
                next_due["tech"] = time.monotonic() + intervals["tech"]

            self._interruptible_sleep(30)

    def _handle_signal(self, signum, frame):
        log(f"\n🛑 收到信号 {signum}，正在优雅退出...")
        self.shutdown = True
        self._shutdown_event.set()

if __name__ == "__main__":
    _load_translate_cache()
    app = SpiderApp()
    try:
        app.run()
    except SpiderWorkerFailure as e:
        # ThreadPoolExecutor 会在解释器退出时 join 翻译线程；若它正是卡死来源，
        # 普通 raise/SystemExit 仍可能永远退不出去。状态已落盘且 join 已等待 5 秒，
        # 此处硬退出确保 Docker restart 策略确实能接管。
        log(f"🚨 [系统] 致命工作线程故障: {e}")
        logging.shutdown()
        os._exit(1)
