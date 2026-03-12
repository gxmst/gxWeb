import re
import json
import time
import os
import requests
import feedparser
import calendar
import random
from datetime import datetime, timedelta, timezone
from PIL import Image
import io

# ================= 配置与工具 =================
USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Edge/121.0.0.0"
]

def get_random_ua():
    return random.choice(USER_AGENTS)

def atomic_save_json(path, data):
    tmp_path = f"{path}.tmp"
    try:
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp_path, path)
    except Exception as e:
        print(f"❌ [系统] 原子化保存失败 ({path}): {e}")
        if os.path.exists(tmp_path): os.remove(tmp_path)

def get_beijing_time():
    # 强制获取北京时间 (UTC+8)
    return datetime.now(timezone(timedelta(hours=8)))

def clean_html(text):
    if not text: return ""
    clean = re.sub(r'<[^>]+>', '', text)
    return clean.replace('&nbsp;', ' ').replace('&mdash;', '—').strip()

# ================= 引擎 1：必应壁纸 =================
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
                        "is_important": is_important
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
                        "url": link,
                        "is_important": False
                    })
                except Exception as e: continue
            print(f"✅ [RSS引擎] {source['name']} 成功解析 {len(source_news)} 条")
            all_rss_news.extend(source_news)
        except Exception as e: print(f"❌ [RSS引擎] {source['name']} 失败: {e}")
    return all_rss_news

# ================= 引擎 4：科技趋势 (V2EX, HN, GitHub) =================
def fetch_tech_news():
    print(f"[{get_beijing_time().strftime('%H:%M:%S')}][科技引擎] 开始抓取趋势...")
    tech_news = []
    ts = int(get_beijing_time().timestamp())
    
    # 1. V2EX
    try:
        resp = requests.get("https://www.v2ex.com/index.xml", headers={"User-Agent": get_random_ua()}, timeout=15)
        if resp.status_code == 200:
            feed = feedparser.parse(resp.text)
            for entry in feed.entries[:15]:
                tech_news.append({
                    "time": get_beijing_time().strftime('%H:%M'),
                    "raw_time": ts,
                    "content": f"【V2EX】{entry.get('title', '').strip()}",
                    "url": entry.get("link", ""),
                    "is_important": False
                })
            print(f"✅ [科技引擎] V2EX 抓取成功 {len(feed.entries[:15])} 条")
    except Exception as e: print(f"❌ [科技引擎] V2EX 失败: {e}")

    # 2. Hacker News
    try:
        resp = requests.get("https://hnrss.org/frontpage?points=50", headers={"User-Agent": get_random_ua()}, timeout=15)
        if resp.status_code == 200:
            feed = feedparser.parse(resp.text)
            for entry in feed.entries[:15]:
                tech_news.append({
                    "time": get_beijing_time().strftime('%H:%M'),
                    "raw_time": ts,
                    "content": f"【HN】{entry.get('title', '').strip()}",
                    "url": entry.get("link", ""),
                    "is_important": False
                })
            print(f"✅ [科技引擎] HN 抓取成功 {len(feed.entries[:15])} 条")
    except Exception as e: print(f"❌ [科技引擎] HN 失败: {e}")

    # 3. GitHub Trends (14 days)
    try:
        date_14d = (datetime.now(timezone.utc) - timedelta(days=14)).strftime('%Y-%m-%d')
        url = f"https://api.github.com/search/repositories?q=created:>{date_14d}&sort=stars&order=desc"
        resp = requests.get(url, headers={"User-Agent": get_random_ua()}, timeout=15).json()
        items = resp.get("items", [])[:10]
        for repo in items:
            name = repo.get("full_name")
            stars = repo.get("stargazers_count")
            desc = repo.get("description") or "无描述"
            tech_news.append({
                "time": get_beijing_time().strftime('%H:%M'),
                "raw_time": ts,
                "content": f"【GitHub】{name} (⭐{stars}) - {desc[:100]}",
                "url": repo.get("html_url", ""),
                "is_important": False
            })
        print(f"✅ [科技引擎] GitHub 抓取成功 {len(items)} 条")
    except Exception as e: print(f"❌ [科技引擎] GitHub 失败: {e}")

    return tech_news

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

# ================= 引擎 5：行情条 (新浪财经) =================
def fetch_ticker():
    print(f"[{get_beijing_time().strftime('%H:%M:%S')}][行情引擎] 开始抓取精准行情...")
    # 移除 UDI，加入英伟达、白银、铜、外汇、日经、恒指
    url = "https://hq.sinajs.cn/list=s_sh000001,gb_dji,gb_ixic,gb_nvda,hf_GC,hf_SI,hf_HG,hf_CL,fx_susdcny,fx_susdjpy,int_nikkei,int_hangseng"
    headers = {"Referer": "https://finance.sina.com.cn/", "User-Agent": get_random_ua()}
    ticker_list = []
    try:
        resp = requests.get(url, headers=headers, timeout=10)
        content = resp.content.decode('gbk')
        lines = content.strip().split('\n')
        mapping = {
            "s_sh000001": "上证", "gb_dji": "道琼斯", "gb_ixic": "纳斯达克", "gb_nvda": "英伟达",
            "hf_GC": "黄金", "hf_SI": "白银", "hf_HG": "伦铜", "hf_CL": "原油",
            "fx_susdcny": "美元/人民币", "fx_susdjpy": "美元/日元", "int_nikkei": "日经225", "int_hangseng": "恒生指数"
        }
        for line in lines:
            try:
                if '=' not in line: continue
                var_part, data_part = line.split('=')
                data = data_part.replace('"', '').replace(';', '').split(',')
                symbol = next((k for k in mapping.keys() if k in var_part), None)
                if not symbol: continue
                
                name = mapping[symbol]
                price, change_pct = "停盘", 0.0
                try:
                    if symbol.startswith(('s_', 'int_')): # 指数
                        price = format(float(data[1]), ".2f")
                        change_pct = float(data[3])
                    elif symbol.startswith('gb_'): # 美股
                        price = format(float(data[1]), ".2f")
                        change_pct = float(data[2])
                    elif symbol.startswith('hf_'): # 期货: [0]当前价, [7]昨收
                        price = format(float(data[0]), ".2f")
                        yest = float(data[7])
                        change_pct = (float(data[0]) - yest) / yest * 100 if yest != 0 else 0.0
                    elif symbol.startswith('fx_'): # 外汇: [1]当前价, [3]昨收
                        p_val = float(data[1])
                        price = format(p_val, ".4f")
                        yest = float(data[3])
                        change_pct = (p_val - yest) / yest * 100 if yest != 0 else 0.0
                except Exception:
                    price, change_pct = "停盘", 0.0
                
                change_str = ("+" if change_pct >= 0 else "") + format(change_pct, ".2f") + "%"
                ticker_list.append({"name": name, "price": price, "symbol": symbol, "change": change_str})
            except Exception as e: continue
        if ticker_list:
            atomic_save_json("./public/ticker.json", ticker_list)
            print(f"✅ [行情引擎] 已同步 {len(ticker_list)} 条行情。")
    except Exception as e: print(f"❌ [行情引擎] 失败: {e}")

# ================= 主循环控制 =================
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
            if now_ts - last_rss_time >= 900 or not global_rss_news:
                rss_news_raw = fetch_rss_news()
                seen_rss = set(); unique_rss = []
                for item in rss_news_raw:
                    if item["content"] not in seen_rss:
                        unique_rss.append(item); seen_rss.add(item["content"])
                unique_rss.sort(key=lambda x: x.get("raw_time", 0), reverse=True)
                global_rss_news = unique_rss[:500]
                last_rss_time = now_ts

            # 6. 科技逻辑 (每 15 分钟)
            if now_ts - last_tech_time >= 900 or not global_tech_news:
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
