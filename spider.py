import re
import json
import time
import os
import requests
import feedparser
import calendar
from datetime import datetime, timedelta, timezone

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
        url = "https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=3&mkt=zh-CN"
        headers = {"User-Agent": "Mozilla/5.0"}
        data = requests.get(url, headers=headers, timeout=10).json()
        for i in range(len(data["images"])):
            img_url = "https://www.bing.com" + data["images"][i]["url"]
            img_data = requests.get(img_url, headers=headers, timeout=15).content
            with open(f"./public/bg_{i}.jpg", "wb") as f: f.write(img_data)
            print(f"✅ [壁纸引擎] bg_{i}.jpg 下载成功。")
    except Exception as e: print(f"❌ [壁纸引擎] 获取失败: {e}")

# ================= 引擎 2：新浪快讯 =================
def fetch_sina():
    print(f"[{get_beijing_time().strftime('%H:%M:%S')}][新浪引擎] 开始抓取...")
    url = "https://zhibo.sina.com.cn/api/zhibo/feed?page=1&page_size=100&zhibo_id=152"
    headers = {"User-Agent": "Mozilla/5.0"}
    news_list = []
    try:
        resp = requests.get(url, headers=headers, timeout=10).json()
        items = resp.get("result", {}).get("data", {}).get("feed", {}).get("list", [])
        for item in items:
            clean_txt = clean_html(item.get("rich_text", "").replace("<br>", ""))
            if clean_txt:
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
                news_list.append({"time": time_str, "raw_time": ts, "content": f"【新浪】{clean_txt}", "url": ""})
        print(f"✅ [新浪引擎] 成功抓取 {len(news_list)} 条。")
    except Exception as e: print(f"❌ [新浪引擎] 失败: {e}")
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
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
    for source in rss_sources:
        source_news = []
        try:
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
                    source_news.append({"time": time_str, "raw_time": ts, "content": f"【{source['name']}】{title}", "url": link})
                except Exception as e: continue
            print(f"✅ [RSS引擎] {source['name']} 成功解析 {len(source_news)} 条")
            all_rss_news.extend(source_news)
        except Exception as e: print(f"❌ [RSS引擎] {source['name']} 失败: {e}")
    return all_rss_news

# ================= 引擎 4：稳定天气 (Open-Meteo) =================
def fetch_weather():
    try:
        url = "https://api.open-meteo.com/v1/forecast?latitude=41.80&longitude=123.43&current_weather=true"
        resp = requests.get(url, timeout=10).json()
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
    headers = {"Referer": "https://finance.sina.com.cn/", "User-Agent": "Mozilla/5.0"}
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
            with open("./public/ticker.json", "w", encoding="utf-8") as f: json.dump(ticker_list, f, ensure_ascii=False, indent=2)
            print(f"✅ [行情引擎] 已同步 {len(ticker_list)} 条行情。")
    except Exception as e: print(f"❌ [行情引擎] 失败: {e}")

# ================= 主循环控制 =================
def main():
    last_wallpaper_date = None
    while True:
        now = get_beijing_time()
        print(f"\n--- {now.strftime('%Y-%m-%d %H:%M:%S')} 开始轮询 ---")
        if now.strftime('%Y-%m-%d') != last_wallpaper_date or not os.path.exists("./public/bg_0.jpg"):
            fetch_bing_wallpaper(); last_wallpaper_date = now.strftime('%Y-%m-%d')
        fetch_weather(); fetch_ticker()
        
        # 1. 抓取新浪快讯
        sina_news_raw = fetch_sina()
        seen_sina = set(); unique_sina = []
        for item in sina_news_raw:
            if item["content"] not in seen_sina:
                unique_sina.append(item); seen_sina.add(item["content"])
        unique_sina.sort(key=lambda x: x.get("raw_time", 0), reverse=True)
        sina_1500 = unique_sina[:1500] # 新浪配额提升至 1500 条

        # 2. 抓取 RSS 快讯
        rss_news_raw = fetch_rss_news()
        seen_rss = set(); unique_rss = []
        for item in rss_news_raw:
            if item["content"] not in seen_rss:
                unique_rss.append(item); seen_rss.add(item["content"])
        unique_rss.sort(key=lambda x: x.get("raw_time", 0), reverse=True)
        rss_500 = unique_rss[:500] # RSS 配额提升至 500 条

        # 3. 合并并最终全局排序 (总库 2000 条)
        final_news = sina_1500 + rss_500
        final_news.sort(key=lambda x: x.get("raw_time", 0), reverse=True)
        
        with open("./public/finance-news.json", "w", encoding="utf-8") as f: json.dump(final_news, f, ensure_ascii=False, indent=2)
        print(f"✅ 更新完成：总库 {len(final_news)} 条。")
            
        print("休眠 60 秒...")
        time.sleep(60)

if __name__ == "__main__":
    main()
