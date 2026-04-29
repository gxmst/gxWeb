import re
import json
import time
import os
import html
import requests
import feedparser
import calendar
import random
from json import JSONDecodeError
from datetime import datetime, timedelta, timezone
from PIL import Image
import io
from deep_translator import GoogleTranslator
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from urllib.parse import urlparse

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
    {"symbol": "shcomp", "name": "上证综指", "category": "亚太", "decimals": 2, "providers": ["twelvedata", "sina"], "symbols": {"twelvedata": "SHCOMP", "sina": "s_sh000001"}},
    {"symbol": "dji", "name": "道琼斯", "category": "美股", "decimals": 2, "providers": ["twelvedata", "sina"], "symbols": {"twelvedata": "DJI", "sina": "gb_dji"}},
    {"symbol": "ixic", "name": "纳斯达克", "category": "美股", "decimals": 2, "providers": ["twelvedata", "sina"], "symbols": {"twelvedata": "IXIC", "sina": "gb_ixic"}},
    {"symbol": "nvda", "name": "英伟达", "category": "美股", "decimals": 2, "providers": ["twelvedata", "sina"], "symbols": {"twelvedata": "NVDA", "sina": "gb_nvda"}},
    {"symbol": "gc00y", "name": "COMEX黄金", "category": "商品", "decimals": 2, "providers": ["twelvedata", "sina"], "symbols": {"twelvedata": "GC00Y", "sina": "hf_GC"}},
    {"symbol": "si00y", "name": "COMEX白银", "category": "商品", "decimals": 3, "providers": ["twelvedata"], "symbols": {"twelvedata": "SI00Y"}},
    {"symbol": "hg00y", "name": "COMEX铜", "category": "商品", "decimals": 4, "providers": ["twelvedata"], "symbols": {"twelvedata": "HG00Y"}},
    {"symbol": "cl00y", "name": "WTI原油", "category": "商品", "decimals": 2, "providers": ["twelvedata"], "symbols": {"twelvedata": "CL00Y"}},
    {"symbol": "usdcny", "name": "美元/人民币", "category": "外汇", "decimals": 4, "providers": ["twelvedata", "sina"], "symbols": {"twelvedata": "USD/CNY", "sina": "fx_susdcny"}},
    {"symbol": "usdjpy", "name": "美元/日元", "category": "外汇", "decimals": 3, "providers": ["twelvedata", "sina"], "symbols": {"twelvedata": "USD/JPY", "sina": "fx_susdjpy"}},
    {"symbol": "n225", "name": "日经225", "category": "亚太", "decimals": 2, "providers": ["twelvedata"], "symbols": {"twelvedata": "N225"}},
    {"symbol": "hsi", "name": "恒生指数", "category": "亚太", "decimals": 2, "providers": ["twelvedata", "sina"], "symbols": {"twelvedata": "HSI", "sina": "rt_hkHSI"}},
    {"symbol": "kospi200", "name": "KOSPI 200", "category": "亚太", "decimals": 2, "providers": ["twelvedata"], "symbols": {"twelvedata": "KOSPI200"}},
    {"symbol": "spx", "name": "标普500", "category": "美股", "decimals": 2, "providers": ["twelvedata", "sina"], "symbols": {"twelvedata": "SPX", "sina": "gb_inx"}},
    {"symbol": "ftse", "name": "富时100", "category": "欧洲", "decimals": 2, "providers": ["twelvedata"], "symbols": {"twelvedata": "FTSE"}},
    {"symbol": "gdaxi", "name": "DAX 40", "category": "欧洲", "decimals": 2, "providers": ["twelvedata"], "symbols": {"twelvedata": "GDAXI"}},
    {"symbol": "fchi", "name": "CAC 40", "category": "欧洲", "decimals": 2, "providers": ["twelvedata"], "symbols": {"twelvedata": "FCHI"}},
    {"symbol": "twii", "name": "台湾加权", "category": "亚太", "decimals": 2, "providers": ["twelvedata"], "symbols": {"twelvedata": "TWII"}},
    {"symbol": "sensex", "name": "印度Sensex", "category": "亚太", "decimals": 2, "providers": ["twelvedata"], "symbols": {"twelvedata": "SENSEX"}},
    {"symbol": "as51", "name": "澳洲200", "category": "亚太", "decimals": 2, "providers": ["twelvedata"], "symbols": {"twelvedata": "AS51"}},
]

def get_random_ua():
    return random.choice(USER_AGENTS)

def build_http_session():
    retry = Retry(
        total=3,
        connect=3,
        read=3,
        backoff_factor=1,
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=["GET"],
        raise_on_status=False
    )
    session = requests.Session()
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    return session

HTTP_SESSION = build_http_session()
GITHUB_CACHE_PATH = "./public/github-tech-cache-v2.json"

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
        "source": source or config.get("providers", ["Unknown"])[0]
    }

def atomic_save_json(path, data):
    tmp_path = f"{path}.tmp"
    try:
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp_path, path)
    except Exception as e:
        print(f"❌ [系统] 原子化保存失败 ({path}): {e}")
        if os.path.exists(tmp_path): os.remove(tmp_path)

def atomic_load_json(path, default=None):
    if default is None:
        default = []
    try:
        if not os.path.exists(path):
            return default
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print(f"鈿狅笍 [绯荤粺] 璇诲彇缂撳瓨澶辫触 ({path}): {e}")
        return default

def get_beijing_time():
    # 强制获取北京时间 (UTC+8)
    return datetime.now(timezone(timedelta(hours=8)))

def clean_html(text):
    if not text: return ""
    clean = re.sub(r'<[^>]+>', '', text)
    return clean.replace('&nbsp;', ' ').replace('&mdash;', '—').strip()

# ================= 引擎 1：必应壁纸 =================
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

def fetch_bing_wallpaper():
    print(f"[{get_beijing_time().strftime('%H:%M:%S')}][壁纸引擎] 正在检查今日必应壁纸...")
    try:
        url = "https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=5&mkt=zh-CN"
        headers = {"User-Agent": get_random_ua()}
        data = requests.get(url, headers=headers, timeout=10).json()
        for i in range(len(data["images"])):
            img_url = "https://www.bing.com" + data["images"][i]["url"]
            img_data = requests.get(img_url, headers={"User-Agent": get_random_ua()}, timeout=15).content
            
            # 使用 Pillow 压缩图片，降低体积
            img = Image.open(io.BytesIO(img_data)).convert('RGB')
            img.save(f"./public/bg_{i}.jpg", "JPEG", quality=82)
            print(f"✅ [壁纸引擎] bg_{i}.jpg 下载并压缩成功。")
    except Exception as e: print(f"❌ [壁纸引擎] 获取失败: {e}")

def update_wallpaper_list():
    favorite_dir = "./public/favorite"
    if not os.path.exists(favorite_dir):
        os.makedirs(favorite_dir)
    
    # 扫描收藏夹图片
    favorite_files = []
    try:
        files = os.listdir(favorite_dir)
        for f in files:
            if f.lower().endswith(('.jpg', '.jpeg', '.png', '.webp')):
                favorite_files.append(f"favorite/{f}")
    except Exception as e:
        print(f"❌ [壁纸引擎] 扫描收藏夹失败: {e}")
    
    # 构建完整列表：收藏夹在前，必应 5 图在后
    bing_files = [f"bg_{i}.jpg" for i in range(5) if os.path.exists(f"./public/bg_{i}.jpg")]
    wallpapers = favorite_files + bing_files
    
    atomic_save_json("./public/wallpapers.json", wallpapers)
    print(f"✅ [壁纸引擎] 已更新 wallpapers.json，共包含 {len(wallpapers)} 张壁纸。")

# ================= 引擎 2：新浪快讯 =================
def fetch_sina():
    print(f"[{get_beijing_time().strftime('%H:%M:%S')}][新浪引擎] 开始抓取...")
    url = "https://zhibo.sina.com.cn/api/zhibo/feed?page=1&page_size=100&zhibo_id=152"
    
    news_list = []
    max_retries = 3
    for attempt in range(max_retries):
        try:
            # 斩断僵尸连接，加入弹性超时
            headers = {
                "User-Agent": get_random_ua(),
                "Connection": "close"
            }
            resp = requests.get(url, headers=headers, timeout=15)
            data = resp.json()
            items = data.get("result", {}).get("data", {}).get("feed", {}).get("list", [])
            
            for item in items:
                clean_txt = clean_html(item.get("rich_text", "").replace("<br>", ""))
                if clean_txt:
                    # 提取重要性标记 (focus字段或is_top字段)
                    is_important = str(item.get("focus", "0")) == "1" or str(item.get("is_top", "0")) == "1"
                    
                    ts_val = item.get("create_time")
                    try:
                        if isinstance(ts_val, str):
                            dt = datetime.strptime(ts_val, '%Y-%m-%d %H:%M:%S')
                            ts = int(dt.timestamp())
                            time_str = dt.strftime('%H:%M')
                        else:
                            ts = int(ts_val)
                            time_str = (datetime.utcfromtimestamp(ts).replace(tzinfo=timezone.utc).astimezone(timezone(timedelta(hours=8)))).strftime('%H:%M')
                    except Exception as e:
                        now = get_beijing_time(); ts = int(now.timestamp()); time_str = now.strftime('%H:%M')
                    news_list.append({
                        "time": time_str, 
                        "raw_time": ts, 
                        "content": f"【新浪】{clean_txt}", 
                        "url": "",
                        "is_important": is_important,
                        "category": "news",
                        "source": "sina"
                    })
            print(f"✅ [新浪引擎] 成功抓取 {len(news_list)} 条。")
            return news_list  # 成功抓取后直接返回
        except Exception as e:
            print(f"⚠️ [新浪引擎] 第 {attempt + 1} 次尝试失败: {e}")
            if attempt < max_retries - 1:
                time.sleep(2)
            else:
                print(f"❌ [新浪引擎] 达到最大重试次数，抓取任务终止。")
    
    return news_list

# ================= 引擎 3：强化版 RSS 引擎 =================
def fetch_rss_news():
    print(f"[{get_beijing_time().strftime('%H:%M:%S')}][RSS引擎] 开始抓取全球顶级媒体...")
    rss_sources = [
        {"name": "华尔街日报", "url": "https://cn.wsj.com/zh-hans/rss"},
        {"name": "FT中文网", "url": "https://www.ftchinese.com/rss/feed"},
        {"name": "纽约时报", "url": "https://cn.nytimes.com/rss/"},
        {"name": "BBC", "url": "https://feeds.bbci.co.uk/zhongwen/simp/rss.xml"},
        {"name": "联合早报", "url": "https://www.zaobao.com.sg/realtime/world/rss"},
        {"name": "Yahoo", "url": "https://finance.yahoo.com/news/rssindex"},
        {"name": "CNBC", "url": "https://search.cnbc.com/rs/search/combinedcms/view.xml?id=10000664"},
        {"name": "FT", "url": "https://www.ft.com/?format=rss"}
    ]
    all_rss_news = []
    for source in rss_sources:
        source_news = []
        try:
            headers = {"User-Agent": get_random_ua()}
            resp = requests.get(source["url"], headers=headers, timeout=15)
            if resp.status_code != 200: continue
            feed = feedparser.parse(resp.text)
            for entry in feed.entries[:20]:
                try:
                    title = entry.get("title", "").strip()
                    link = entry.get("link", "")
                    if not title: continue
                    ts = int(get_beijing_time().timestamp())
                    pub_parsed = entry.get("published_parsed")
                    if pub_parsed: ts = calendar.timegm(pub_parsed)
                    time_str = (datetime.utcfromtimestamp(ts).replace(tzinfo=timezone.utc).astimezone(timezone(timedelta(hours=8)))).strftime('%H:%M')
                    source_news.append({
                        "time": time_str, 
                        "raw_time": ts, 
                        "content": f"【{source['name']}】{title}", 
                        "url": sanitize_url(link),
                        "is_important": False,
                        "category": "foreign",
                        "source": source["name"]
                    })
                except Exception as e: continue
            print(f"✅ [RSS引擎] {source['name']} 成功解析 {len(source_news)} 条")
            all_rss_news.extend(source_news)
        except Exception as e: print(f"❌ [RSS引擎] {source['name']} 失败: {e}")
    return all_rss_news

def translate_en_to_zh(text):
    if not text: return ""
    try:
        translated = GoogleTranslator(source='en', target='zh-CN').translate(text)
        time.sleep(0.5) # 降低翻译频率，防止被封
        return translated
    except Exception as e:
        print(f"⚠️ [翻译引擎] 失败: {e}")
        return text

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
    resp = HTTP_SESSION.get(url, headers=headers, timeout=(5, timeout))
    resp.raise_for_status()
    data = resp.json()
    if not isinstance(data, dict):
        raise ValueError("GitHub API response format is invalid")
    return data.get("items", [])[:limit]

def build_github_html_legacy(items):
    github_html = "銆怗itHub 瓒嬪娍 (鍙岃瀵圭収/鎮仠灞曞紑)銆?"
    for i, repo in enumerate(items):
        name = escape_text(repo.get("full_name"))
        stars = int(repo.get("stargazers_count") or 0)
        desc_en_raw = repo.get("description") or "No description"
        desc_en = escape_text(desc_en_raw)
        desc_zh = escape_text(translate_en_to_zh(desc_en_raw[:200]))
        repo_url = escape_text(sanitize_url(repo.get("html_url")))
        github_html += f'<div class="group mb-3 border-b border-white/5 pb-2 last:border-0">'
        github_html += f'<a href="{repo_url}" target="_blank" rel="noopener noreferrer" class="font-bold text-blue-400 hover:text-blue-300 transition-colors">{i+1}. {name} (STAR {stars})</a>'
        github_html += f'<div class="text-white/80 text-sm mt-1">{desc_en}</div>'
        github_html += f'<div class="overflow-hidden max-h-0 opacity-0 group-hover:max-h-24 group-hover:opacity-100 transition-all duration-500 ease-in-out text-white/50 text-xs mt-1">鈫?ZH: {desc_zh}</div></div>'
    return github_html

def build_github_html(sections):
    github_html = '<div class="font-semibold text-white mb-3">GitHub Trends</div>'
    for section in sections:
        github_html += f'<div class="text-white/60 text-xs uppercase tracking-[0.2em] mt-4 mb-2">{escape_text(section["label"])}</div>'
        for i, repo in enumerate(section["items"]):
            name = escape_text(repo.get("full_name"))
            stars = int(repo.get("stargazers_count") or 0)
            desc_en_raw = repo.get("description") or "No description"
            desc_en = escape_text(desc_en_raw)
            desc_zh = escape_text(translate_en_to_zh(desc_en_raw[:200]))
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

def fetch_tech_news_legacy():
    print(f"[{get_beijing_time().strftime('%H:%M:%S')}][科技引擎] 开始抓取并聚合趋势...")
    tech_blocks = []
    now_bj = get_beijing_time()
    ts = int(now_bj.timestamp())
    time_str = now_bj.strftime('%H:%M')
    
    # 1. GitHub Trends (聚合模式)
    try:
        items = fetch_github_trends()
        
        github_html = "【GitHub 趋势 (双语对照/悬停展开)】"
        for i, repo in enumerate(items):
            name = repo.get("full_name")
            stars = repo.get("stargazers_count")
            desc_en = repo.get("description") or "No description"
            desc_zh = translate_en_to_zh(desc_en[:200])
            github_html += f'<div class="group mb-3 border-b border-white/5 pb-2 last:border-0">'
            github_html += f'<a href="{repo.get("html_url")}" target="_blank" class="font-bold text-blue-400 hover:text-blue-300 transition-colors">{i+1}. {name} (⭐{stars})</a>'
            github_html += f'<div class="text-white/80 text-sm mt-1">{desc_en}</div>'
            github_html += f'<div class="overflow-hidden max-h-0 opacity-0 group-hover:max-h-24 group-hover:opacity-100 transition-all duration-500 ease-in-out text-white/50 text-xs mt-1">↳ ZH: {desc_zh}</div></div>'
        
        tech_blocks.append({
            "time": time_str, "raw_time": ts, "content": github_html, "url": "", "is_important": False, "category": "tech"
        })
        print(f"✅ [科技引擎] GitHub 聚合成功")
    except Exception as e: print(f"❌ [科技引擎] GitHub 失败: {e}")

    # 2. Hacker News (聚合模式)
    try:
        resp = requests.get("https://hnrss.org/frontpage?points=50", headers={"User-Agent": get_random_ua()}, timeout=15)
        if resp.status_code == 200:
            feed = feedparser.parse(resp.text)
            hn_html = "【HN 热帖 (双语对照/悬停展开)】"
            for i, entry in enumerate(feed.entries[:10]):
                title_en = entry.get("title", "").strip()
                title_zh = translate_en_to_zh(title_en)
                hn_html += f'<div class="group mb-3 border-b border-white/5 pb-2 last:border-0">'
                hn_html += f'<a href="{entry.get("link")}" target="_blank" class="font-bold text-blue-400 hover:text-blue-300 transition-colors">{i+1}. {title_en}</a>'
                hn_html += f'<div class="overflow-hidden max-h-0 opacity-0 group-hover:max-h-20 group-hover:opacity-100 transition-all duration-500 ease-in-out text-white/50 text-xs mt-1">↳ ZH: {title_zh}</div></div>'
            
            tech_blocks.append({
                "time": time_str, "raw_time": ts, "content": hn_html, "url": "", "is_important": False, "category": "tech"
            })
            print(f"✅ [科技引擎] HN 聚合成功")
    except Exception as e: print(f"❌ [科技引擎] HN 失败: {e}")

    # 3. V2EX (聚合模式)
    try:
        resp = requests.get("https://www.v2ex.com/index.xml", headers={"User-Agent": get_random_ua()}, timeout=15)
        if resp.status_code == 200:
            feed = feedparser.parse(resp.text)
            v2ex_html = "【V2EX 热门】"
            for i, entry in enumerate(feed.entries[:10]):
                v2ex_html += f'<div class="mb-3 border-b border-white/5 pb-2 last:border-0">'
                v2ex_html += f'<a href="{entry.get("link")}" target="_blank" class="text-blue-400 hover:text-blue-300 transition-colors">{i+1}. {entry.get("title", "").strip()}</a></div>'
            
            tech_blocks.append({
                "time": time_str, "raw_time": ts, "content": v2ex_html, "url": "", "is_important": False, "category": "tech"
            })
            print(f"✅ [科技引擎] V2EX 聚合成功")
    except Exception as e: print(f"❌ [科技引擎] V2EX 失败: {e}")

    return tech_blocks

# ================= 引擎 5：稳定天气 (Open-Meteo) =================
def fetch_weather():
    try:
        url = "https://api.open-meteo.com/v1/forecast?latitude=41.80&longitude=123.43&current_weather=true"
        headers = {"User-Agent": get_random_ua()}
        resp = requests.get(url, headers=headers, timeout=10).json()
        curr = resp.get("current_weather", {})
        temp, code = curr.get("temperature"), curr.get("weathercode")
        emoji_map = {0: "☀️", 1: "☁️", 2: "☁️", 3: "☁️", 45: "🌫️", 48: "🌫️", 51: "🌧️", 53: "🌧️", 55: "🌧️", 61: "🌧️", 63: "🌧️", 65: "🌧️", 71: "❄️", 73: "❄️", 75: "❄️", 95: "⛈️"}
        emoji = emoji_map.get(code, "☁️")
        if 71 <= code <= 77: emoji = "❄️"
        elif 51 <= code <= 67: emoji = "🌧️"
        with open("./public/weather.txt", "w", encoding="utf-8") as f: f.write(f"{emoji} {temp}°C")
    except Exception as e: print(f"[天气引擎] 失败: {e}")

# ================= 引擎 5：行情条 (多源 Provider Chain) =================
TICKER_FILE = "./public/ticker.json"
TICKER_STATUS_FILE = "./public/ticker-status.json"
TICKER_RETRY_MAX = 3
TICKER_RETRY_BACKOFF = [1, 2, 4]
TWELVEDATA_API_KEY = os.environ.get("TWELVEDATA_API_KEY", "").strip()


def _fetch_twelvedata_quotes(configs):
    result_map = {}
    if not configs:
        return result_map
    if not TWELVEDATA_API_KEY:
        print("  ⚠️ [行情引擎] TWELVEDATA_API_KEY 未设置，跳过 Twelve Data")
        return result_map

    symbol_to_config = {}
    for cfg in configs:
        td_sym = cfg["symbols"].get("twelvedata")
        if td_sym:
            symbol_to_config[td_sym] = cfg

    all_symbols = list(symbol_to_config.keys())
    batch_size = 8
    batches = [all_symbols[i:i + batch_size] for i in range(0, len(all_symbols), batch_size)]

    for batch_idx, batch_syms in enumerate(batches):
        symbols_str = ",".join(batch_syms)
        url = f"https://api.twelvedata.com/quote?symbol={symbols_str}&apikey={TWELVEDATA_API_KEY}"

        for attempt in range(TICKER_RETRY_MAX):
            try:
                resp = HTTP_SESSION.get(url, headers={"User-Agent": get_random_ua()}, timeout=20)
                if resp.status_code in (429, 500, 502, 503, 504):
                    raise requests.HTTPError(f"HTTP {resp.status_code}", response=resp)
                resp.raise_for_status()
                data = parse_json_response(resp, "Twelve Data batch")

                results_list = []
                if "symbol" in data:
                    results_list = [data]
                elif "code" in data and data.get("code") != 0:
                    raise ValueError(f"Twelve Data API error: {data.get('message', 'unknown')}")
                else:
                    for key, val in data.items():
                        if isinstance(val, dict) and "symbol" in val:
                            results_list.append(val)

                for item in results_list:
                    sym = item.get("symbol", "")
                    cfg = symbol_to_config.get(sym)
                    if not cfg:
                        continue
                    price = item.get("close") or item.get("price")
                    pct = item.get("percent_change")
                    prev = item.get("previous_close")
                    if price and pct is not None and prev:
                        try:
                            p = float(price)
                            pc = float(prev)
                            if p > 0 and pc > 0:
                                result_map[cfg["symbol"]] = build_ticker_entry(cfg, p, pc, source="TwelveData")
                        except (ValueError, TypeError):
                            pass
                break

            except (requests.HTTPError, requests.Timeout, requests.ConnectionError) as e:
                resp_obj = getattr(e, 'response', None)
                sc = resp_obj.status_code if resp_obj is not None else "timeout"
                wait = TICKER_RETRY_BACKOFF[attempt] if attempt < len(TICKER_RETRY_BACKOFF) else TICKER_RETRY_BACKOFF[-1]
                print(f"  ⚠️ [行情引擎] Twelve Data 批次 {batch_idx+1} HTTP {sc}，第 {attempt+1} 次重试，等待 {wait}s...")
                time.sleep(wait)
            except (ValueError, JSONDecodeError) as e:
                wait = TICKER_RETRY_BACKOFF[attempt] if attempt < len(TICKER_RETRY_BACKOFF) else TICKER_RETRY_BACKOFF[-1]
                print(f"  ⚠️ [行情引擎] Twelve Data 批次 {batch_idx+1} 解析错误: {e}，第 {attempt+1} 次重试，等待 {wait}s...")
                time.sleep(wait)
            except Exception as e:
                print(f"  ❌ [行情引擎] Twelve Data 批次 {batch_idx+1} 未知错误: {type(e).__name__}: {e}")
                break

        if batch_idx < len(batches) - 1:
            time.sleep(1.0)

    return result_map


def _fetch_sina_for_configs(configs):
    result_map = {}
    if not configs:
        return result_map
    sina_configs = []
    for cfg in configs:
        sina_sym = cfg["symbols"].get("sina")
        if sina_sym:
            sina_configs.append({"symbol": sina_sym, "canonical": cfg["symbol"], "name": cfg["name"],
                                 "category": cfg["category"], "decimals": cfg["decimals"]})

    if not sina_configs:
        return result_map

    try:
        symbols = ",".join([c["symbol"] for c in sina_configs])
        url = f"http://hq.sinajs.cn/list={symbols}"
        headers = {"Referer": "http://finance.sina.com.cn/", "User-Agent": get_random_ua()}
        resp = HTTP_SESSION.get(url, headers=headers, timeout=10)
        resp.raise_for_status()

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

        for sc in sina_configs:
            raw = sina_raw.get(sc["symbol"])
            if not raw:
                continue
            try:
                p = None
                pc = None
                sym = sc["symbol"]

                if sym.startswith("gb_") and len(raw) > 26:
                    p = float(raw[1])
                    pc = float(raw[26])
                elif sym.startswith("fx_") and len(raw) > 3:
                    p = float(raw[1])
                    pc = float(raw[3])
                elif sym.startswith("hf_") and len(raw) > 8:
                    p = float(raw[0])
                    pc = float(raw[7])
                elif sym.startswith("rt_hk") and len(raw) > 6:
                    p = float(raw[6])
                    pc = float(raw[3])
                elif sym.startswith("s_") and len(raw) > 2:
                    p = float(raw[1])
                    change_val = float(raw[2])
                    pc = p - change_val
                elif sym.startswith("b_"):
                    continue
                else:
                    if len(raw) > 3:
                        p = float(raw[1])
                        pc = float(raw[3])

                if p and pc and p > 0 and pc > 0:
                    cfg_full = {"symbol": sc["canonical"], "name": sc["name"], "category": sc["category"], "decimals": sc["decimals"]}
                    result_map[sc["canonical"]] = build_ticker_entry(cfg_full, p, pc, source="Sina")
            except (ValueError, TypeError, IndexError):
                pass

    except Exception as e:
        print(f"  ⚠️ [行情引擎] Sina 抓取异常: {type(e).__name__}: {e}")

    return result_map


def fetch_ticker():
    ts_str = get_beijing_time().strftime('%H:%M:%S')
    print(f"[{ts_str}][行情引擎] 开始同步行情 (多源模式)...")

    total_count = len(MARKET_TICKERS)
    result_map = {}
    provider_stats = {"TwelveData": 0, "Sina": 0}
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

    # 1. Twelve Data 主源
    if TWELVEDATA_API_KEY:
        td_configs = [c for c in MARKET_TICKERS if "twelvedata" in c.get("providers", [])]
        print(f"  [行情引擎] Twelve Data: {len(td_configs)} 标的")
        td_results = _fetch_twelvedata_quotes(td_configs)
        for sym, entry in td_results.items():
            if sym not in result_map:
                result_map[sym] = entry
                provider_stats["TwelveData"] += 1
    else:
        print("  ⚠️ [行情引擎] TWELVEDATA_API_KEY 未配置，跳过 Twelve Data 主源")

    # 2. Sina 补齐：Twelve Data 没拿到的、且有 sina provider 的标的
    td_failed = [c for c in MARKET_TICKERS if c["symbol"] not in result_map and "sina" in c.get("providers", [])]
    if td_failed:
        print(f"  [行情引擎] Sina 补齐: {len(td_failed)} 标的")
        sina_results = _fetch_sina_for_configs(td_failed)
        for sym, entry in sina_results.items():
            if sym not in result_map:
                result_map[sym] = entry
                provider_stats["Sina"] += 1

    # 3. 逐标的沿用旧值
    for config in MARKET_TICKERS:
        sym = config["symbol"]
        if sym not in result_map and sym in old_ticker_map:
            result_map[sym] = old_ticker_map[sym]
            stale_used.append(config["name"])

    unique_count = len(result_map)
    threshold = max(10, int(total_count * 0.7))
    primary_count = provider_stats["TwelveData"]
    fallback_count = provider_stats["Sina"]

    # 4. 状态判定与写入
    if unique_count >= threshold:
        atomic_save_json(TICKER_FILE, list(result_map.values()))
        if primary_count >= threshold:
            status = "ok"
        elif fallback_count > 0 or len(stale_used) > 0:
            status = "degraded"
        else:
            status = "ok"
        print(f"  ✅ [行情引擎] 本轮写入 {unique_count} 条 (阈值 {threshold}) 状态={status}")
    else:
        if os.path.exists(TICKER_FILE):
            status = "failed"
            print(f"  ⚠️ [行情引擎] 本轮仅 {unique_count} 条 (阈值 {threshold})，保留上次成功数据")
        else:
            status = "failed"
            print(f"  ⚠️ [行情引擎] 本轮仅 {unique_count} 条且无历史文件，跳过写入")

    # 5. 写入状态文件
    status_payload = {
        "updated_at": int(get_beijing_time().timestamp()),
        "status": status,
        "primary_provider": "twelvedata",
        "primary_success_count": primary_count,
        "fallback_success_count": fallback_count,
        "stale_used_count": len(stale_used),
        "final_count": unique_count,
        "total_count": total_count
    }
    atomic_save_json(TICKER_STATUS_FILE, status_payload)

    # 6. 日志汇总
    print(f"  📊 [行情引擎] 总标的: {total_count} | TwelveData: {primary_count} | Sina: {fallback_count} | 沿用旧值: {len(stale_used)} | 最终: {unique_count} | 状态: {status}")
    if stale_used:
        print(f"  ℹ️ [行情引擎] 沿用旧值: {', '.join(stale_used)}")

# ================= 主循环控制 =================
def fetch_tech_news_legacy_2():
    print(f"[{get_beijing_time().strftime('%H:%M:%S')}][绉戞妧寮曟搸] 寮€濮嬫姄鍙栧苟鑱氬悎瓒嬪娍...")
    tech_blocks = []
    now_bj = get_beijing_time()
    ts = int(now_bj.timestamp())
    time_str = now_bj.strftime('%H:%M')

    try:
        items = fetch_github_trends()
        github_html = build_github_html(items)
        tech_block = {
            "time": time_str,
            "raw_time": ts,
            "content": github_html,
            "url": "",
            "is_important": False,
            "category": "tech"
        }
        tech_blocks.append(tech_block)
        atomic_save_json(GITHUB_CACHE_PATH, tech_block)
        print(f"鉁?[绉戞妧寮曟搸] GitHub 鑱氬悎鎴愬姛")
    except Exception as e:
        cached_github = atomic_load_json(GITHUB_CACHE_PATH, default={})
        if cached_github:
            tech_blocks.append(cached_github)
            print(f"鈿狅笍 [绉戞妧寮曟搸] GitHub 澶辫触锛屼娇鐢ㄤ笂娆＄紦瀛? {e}")
        else:
            print(f"鉂?[绉戞妧寮曟搸] GitHub 澶辫触: {e}")

    try:
        resp = requests.get("https://hnrss.org/frontpage?points=50", headers={"User-Agent": get_random_ua()}, timeout=15)
        if resp.status_code == 200:
            feed = feedparser.parse(resp.text)
            hn_html = "銆怘N 鐑笘 (鍙岃瀵圭収/鎮仠灞曞紑)銆?"
            for i, entry in enumerate(feed.entries[:10]):
                title_en = entry.get("title", "").strip()
                title_zh = translate_en_to_zh(title_en)
                hn_html += f'<div class="group mb-3 border-b border-white/5 pb-2 last:border-0">'
                hn_html += f'<a href="{entry.get("link")}" target="_blank" class="font-bold text-blue-400 hover:text-blue-300 transition-colors">{i+1}. {title_en}</a>'
                hn_html += f'<div class="overflow-hidden max-h-0 opacity-0 group-hover:max-h-20 group-hover:opacity-100 transition-all duration-500 ease-in-out text-white/50 text-xs mt-1">鈫?ZH: {title_zh}</div></div>'

            tech_blocks.append({
                "time": time_str, "raw_time": ts, "content": hn_html, "url": "", "is_important": False, "category": "tech"
            })
            print(f"鉁?[绉戞妧寮曟搸] HN 鑱氬悎鎴愬姛")
    except Exception as e:
        print(f"鉂?[绉戞妧寮曟搸] HN 澶辫触: {e}")

    try:
        resp = requests.get("https://www.v2ex.com/index.xml", headers={"User-Agent": get_random_ua()}, timeout=15)
        if resp.status_code == 200:
            feed = feedparser.parse(resp.text)
            v2ex_html = "銆怴2EX 鐑棬銆?"
            for i, entry in enumerate(feed.entries[:10]):
                v2ex_html += f'<div class="mb-3 border-b border-white/5 pb-2 last:border-0">'
                v2ex_html += f'<a href="{entry.get("link")}" target="_blank" class="text-blue-400 hover:text-blue-300 transition-colors">{i+1}. {entry.get("title", "").strip()}</a></div>'

            tech_blocks.append({
                "time": time_str, "raw_time": ts, "content": v2ex_html, "url": "", "is_important": False, "category": "tech"
            })
            print(f"鉁?[绉戞妧寮曟搸] V2EX 鑱氬悎鎴愬姛")
    except Exception as e:
        print(f"鉂?[绉戞妧寮曟搸] V2EX 澶辫触: {e}")

    return tech_blocks

def fetch_tech_news():
    print(f"[{get_beijing_time().strftime('%H:%M:%S')}][tech] fetching trend blocks...")
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
        tech_blocks.append(tech_block)
        atomic_save_json(GITHUB_CACHE_PATH, tech_block)
        print("[tech] GitHub block updated")
    except Exception as e:
        cached_github = atomic_load_json(GITHUB_CACHE_PATH, default={})
        if cached_github:
            tech_blocks.append(cached_github)
            print(f"[tech] GitHub request failed, using cached block: {e}")
        else:
            print(f"[tech] GitHub request failed: {e}")

    try:
        resp = requests.get("https://hnrss.org/frontpage?points=50", headers={"User-Agent": get_random_ua()}, timeout=15)
        if resp.status_code == 200:
            feed = feedparser.parse(resp.text)
            hn_html = "HN Trends"
            for i, entry in enumerate(feed.entries[:10]):
                title_en_raw = entry.get("title", "").strip()
                title_en = escape_text(title_en_raw)
                title_zh = escape_text(translate_en_to_zh(title_en_raw))
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
            print("[tech] HN block updated")
    except Exception as e:
        print(f"[tech] HN request failed: {e}")

    try:
        hot_resp = requests.get("https://www.v2ex.com/api/topics/hot.json", headers={"User-Agent": get_random_ua()}, timeout=15)
        new_resp = requests.get("https://www.v2ex.com/api/topics/latest.json", headers={"User-Agent": get_random_ua()}, timeout=15)
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
            print("[tech] V2EX block updated")
    except Exception as e:
        print(f"[tech] V2EX request failed: {e}")

    return tech_blocks

global_rss_news = []
global_tech_news = []

def main():
    global global_rss_news, global_tech_news
    last_wallpaper_date = None
    last_rss_time = 0
    last_weather_time = 0
    last_tech_time = 0
    
    while True:
        try:
            now_ts = time.time()
            now_bj = get_beijing_time()
            print(f"\n--- {now_bj.strftime('%Y-%m-%d %H:%M:%S')} 开始轮询 ---")
            
            # 1. 壁纸逻辑 (每天一次)
            if now_bj.strftime('%Y-%m-%d') != last_wallpaper_date or not os.path.exists("./public/bg_0.jpg"):
                fetch_bing_wallpaper()
                last_wallpaper_date = now_bj.strftime('%Y-%m-%d')
            
            # 2. 天气逻辑 (每 30 分钟)
            if now_ts - last_weather_time >= 1800:
                fetch_weather()
                last_weather_time = now_ts

            # 3. 扫描壁纸列表 (每 60 秒)
            update_wallpaper_list()
                
            # 4. 行情逻辑 (每 60 秒)
            fetch_ticker()
            
            # 5. RSS 逻辑 (每 15 分钟)
            if now_ts - last_rss_time >= 1800 or not global_rss_news:
                rss_news_raw = fetch_rss_news()
                seen_rss = set(); unique_rss = []
                for item in rss_news_raw:
                    if item["content"] not in seen_rss:
                        unique_rss.append(item); seen_rss.add(item["content"])
                unique_rss.sort(key=lambda x: x.get("raw_time", 0), reverse=True)
                global_rss_news = unique_rss[:500]
                last_rss_time = now_ts

            # 6. 科技逻辑 (每 15 分钟)
            if now_ts - last_tech_time >= 1800 or not global_tech_news:
                tech_news_raw = fetch_tech_news()
                seen_tech = set(); unique_tech = []
                for item in tech_news_raw:
                    if item["content"] not in seen_tech:
                        unique_tech.append(item); seen_tech.add(item["content"])
                global_tech_news = unique_tech[:100]
                last_tech_time = now_ts

            # 7. 新浪快讯 (每 60 秒)
            sina_news_raw = fetch_sina()
            seen_sina = set()
            unique_sina = []
            for item in sina_news_raw:
                if item["content"] not in seen_sina:
                    unique_sina.append(item)
                    seen_sina.add(item["content"])
            sina_1500 = unique_sina[:1500]

            # 8. 合并并保存
            final_news = sina_1500 + global_rss_news + global_tech_news
            final_news.sort(key=lambda x: (x.get("is_important", False), x.get("raw_time", 0)), reverse=True)
            
            if final_news:
                output_data = {
                    "last_updated": int(now_bj.timestamp()),
                    "news_list": final_news
                }
                atomic_save_json("./public/finance-news.json", output_data)
                print(f"✅ 更新完成：总库 {len(final_news)} 条。")
                
        except Exception as e:
            print(f"🚨 [主循环] 发生严重异常: {e}")
            
        print("休眠 60 秒...")
        time.sleep(60)

if __name__ == "__main__":
    main()
