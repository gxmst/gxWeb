"""Static crawler configuration, market symbol tables, feed sources, and cache paths."""
import os
import re

USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Edge/121.0.0.0",
]

MARKET_TICKERS = [
    {"symbol": "shcomp", "name": "上证综指", "category": "亚太", "decimals": 2, "sina": "s_sh000001", "tencent": "sh000001"},
    {"symbol": "szcomp", "name": "深证成指", "category": "亚太", "decimals": 2, "sina": "s_sz399001", "tencent": "sz399001"},
    {"symbol": "chinext", "name": "创业板指", "category": "亚太", "decimals": 2, "sina": "s_sz399006", "tencent": "sz399006"},
    {"symbol": "csi300", "name": "沪深300", "category": "亚太", "decimals": 2, "sina": "s_sh000300", "tencent": "sh000300"},
    {"symbol": "dji", "name": "道琼斯", "category": "美股", "decimals": 2, "sina": "gb_dji", "tencent": "usDJI"},
    {"symbol": "ixic", "name": "纳斯达克", "category": "美股", "decimals": 2, "sina": "gb_ixic", "tencent": "usIXIC"},
    {"symbol": "nvda", "name": "英伟达", "category": "美股", "decimals": 2, "sina": "gb_nvda", "tencent": "usNVDA"},
    {"symbol": "gc00y", "name": "COMEX黄金", "category": "商品", "decimals": 2, "sina": "hf_GC"},
    {"symbol": "si00y", "name": "COMEX白银", "category": "商品", "decimals": 3, "sina": "hf_SI"},
    {"symbol": "hg00y", "name": "COMEX铜", "category": "商品", "decimals": 4, "sina": "hf_HG"},
    {"symbol": "cl00y", "name": "WTI原油", "category": "商品", "decimals": 2, "sina": "hf_CL"},
    {"symbol": "usdcny", "name": "美元/人民币", "category": "外汇", "decimals": 4, "sina": "fx_susdcny"},
    {"symbol": "usdjpy", "name": "美元/日元", "category": "外汇", "decimals": 3, "sina": "fx_susdjpy"},
    {"symbol": "n225", "name": "日经225", "category": "亚太", "decimals": 2, "sina": "b_NKY"},
    {"symbol": "hsi", "name": "恒生指数", "category": "亚太", "decimals": 2, "sina": "rt_hkHSI", "tencent": "hkHSI"},
    {"symbol": "hscei", "name": "恒生国企", "category": "亚太", "decimals": 2, "sina": "rt_hkHSCEI", "tencent": "hkHSCEI"},
    {"symbol": "kospi", "name": "韩国KOSPI", "category": "亚太", "decimals": 2, "sina": "b_KOSPI"},
    {"symbol": "spx", "name": "标普500", "category": "美股", "decimals": 2, "sina": "gb_inx", "tencent": "usINX"},
    {"symbol": "ndx", "name": "纳斯达克100", "category": "美股", "decimals": 2, "sina": "gb_ndx", "tencent": "usNDX"},
    {"symbol": "aapl", "name": "苹果", "category": "美股", "decimals": 2, "sina": "gb_aapl", "tencent": "usAAPL"},
    {"symbol": "msft", "name": "微软", "category": "美股", "decimals": 2, "sina": "gb_msft", "tencent": "usMSFT"},
    {"symbol": "tsla", "name": "特斯拉", "category": "美股", "decimals": 2, "sina": "gb_tsla", "tencent": "usTSLA"},
    {"symbol": "amzn", "name": "亚马逊", "category": "美股", "decimals": 2, "sina": "gb_amzn", "tencent": "usAMZN"},
    {"symbol": "meta", "name": "Meta", "category": "美股", "decimals": 2, "sina": "gb_meta", "tencent": "usMETA"},
    {"symbol": "ftse", "name": "富时100", "category": "欧洲", "decimals": 2, "sina": "b_FTSE"},
    {"symbol": "gdaxi", "name": "DAX 40", "category": "欧洲", "decimals": 2, "sina": "b_DAX"},
    {"symbol": "fchi", "name": "CAC 40", "category": "欧洲", "decimals": 2, "sina": "b_CAC"},
    {"symbol": "twii", "name": "台湾加权", "category": "亚太", "decimals": 2, "sina": "b_TWSE"},
    {"symbol": "sensex", "name": "印度Sensex", "category": "亚太", "decimals": 2, "sina": "b_SENSEX"},
    {"symbol": "as51", "name": "澳洲200", "category": "亚太", "decimals": 2, "sina": "b_AS51"},
]

IMPORTANCE_THRESHOLD = 75

# 只匹配高确定性的事件。规则宁可漏报，也不把普通行情播报染成“重要”。
IMPORTANCE_RULES = (
    (
        90,
        "央行与利率决议",
        re.compile(
            r"(?:美联储|联邦储备|中国人民银行|欧洲央行|日本央行|英国央行|央行|"
            r"Federal Reserve|\bFed\b|\bECB\b|\bBOJ\b).{0,32}"
            r"(?:加息|降息|利率决议|基准利率|维持.{0,8}利率|量化宽松|缩表|"
            r"rate (?:cut|hike|decision))|"
            r"(?:加息|降息|利率决议).{0,32}"
            r"(?:美联储|中国人民银行|欧洲央行|日本央行|英国央行|央行)",
            re.IGNORECASE,
        ),
    ),
    (
        85,
        "核心经济数据",
        re.compile(
            r"(?:非农|消费者价格指数|\bCPI\b|\bPCE\b|国内生产总值|\bGDP\b).{0,36}"
            r"(?:公布|录得|同比|环比|升至|降至|增长|下降|超预期|不及预期|"
            r"rose|fell|unexpected)",
            re.IGNORECASE,
        ),
    ),
    (
        85,
        "市场异常波动",
        re.compile(
            r"(?:熔断|闪崩|暂停交易|触发临停|暴涨|暴跌|"
            r"(?:涨幅|跌幅)扩大至\s*(?:[5-9]|[1-9]\d)(?:\.\d+)?%)",
            re.IGNORECASE,
        ),
    ),
    (
        80,
        "重大政策或地缘事件",
        re.compile(
            r"(?:宣战|进入战争状态|发动空袭|发射导弹|核试验|全国进入紧急状态|"
            r"实施全面制裁|重大制裁|主权评级.{0,10}下调)",
            re.IGNORECASE,
        ),
    ),
    (
        75,
        "重大公司风险",
        re.compile(
            r"(?:申请破产保护|正式退市|暂停所有交易|债务违约|接管.{0,16}(?:银行|券商))",
            re.IGNORECASE,
        ),
    ),
)

SINA_PAGES = 3  # 该接口 page_size 上限 100/页，翻 3 页 ≈ 300 条

SINA_NEWS_LIMIT = 500
RSS_NEWS_LIMIT = 450
TECH_NEWS_LIMIT = 50
COMMUNITY_NEWS_LIMIT = 1000

NEWS_ARCHIVE_FILE = "./public/news-archive.json"
SINA_ARCHIVE_LIMIT = 1500
RSS_ARCHIVE_LIMIT = 1200
TECH_ARCHIVE_LIMIT = 80
COMMUNITY_ARCHIVE_LIMIT = 3000

RSS_SOURCES = [
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
    {"name": "法广", "url": "https://www.france24.com/en/rss", "lang": "en"},
]

FORUM_SOURCES = {
    "nodeseek": {"name": "NodeSeek", "url": "https://rss.nodeseek.com/", "hosts": {"nodeseek.com", "www.nodeseek.com"}},
    "linuxdo": {"name": "Linux DO", "url": "https://linux.do/latest.rss", "hosts": {"linux.do"}},
}

# Internal crawler caches live outside public/ so web servers never publish them.
SPIDER_CACHE_DIR = os.getenv("SPIDER_CACHE_DIR", "").strip() or "./state"
GITHUB_CACHE_PATH = os.path.join(SPIDER_CACHE_DIR, "github-tech-cache-v2.json")
LEGACY_GITHUB_CACHE_PATH = "./public/github-tech-cache-v2.json"
TRANSLATE_CACHE_PATH = os.path.join(SPIDER_CACHE_DIR, "translate-cache.json")
LEGACY_TRANSLATE_CACHE_PATH = "./public/translate-cache.json"
TRANSLATE_CACHE_MAX = 2000

try:
    TRANSLATE_API_TIMEOUT = max(1.0, float(os.getenv("TRANSLATE_API_TIMEOUT", "15")))
except ValueError:
    TRANSLATE_API_TIMEOUT = 15.0

TICKER_FILE = "./public/ticker.json"
TICKER_STATUS_FILE = "./public/ticker-status.json"
TICKER_RETRY_MAX = 3
TICKER_RETRY_BACKOFF = [1, 2, 4]

PIPELINE_STATUS_FILE = "./public/pipeline-status.json"
PIPELINE_JOBS = (
    "heartbeat", "ticker", "sina", "finance_news",
    "wallpaper", "weather", "wallpaper_list", "rss", "tech", "nodeseek", "linuxdo",
)

try:
    PIPELINE_JOB_TIMEOUT_SECONDS = max(
        1.0, float(os.getenv("PIPELINE_JOB_TIMEOUT_SECONDS", "1800"))
    )
except ValueError:
    PIPELINE_JOB_TIMEOUT_SECONDS = 1800.0
