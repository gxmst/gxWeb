"""Local frontend preview. Demo responses stay in memory and never overwrite public data."""
import argparse
import io
import json
import time
import sys
import os
from datetime import datetime, timedelta, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from control_api import AdminHandlerMixin, AdminState
DATA_FILES = {"finance-news.json", "ticker.json", "ticker-status.json", "pipeline-status.json", "weather.txt", "wallpapers.json"}


def demo_wallpaper():
    from PIL import Image, ImageDraw
    image = Image.new("RGB", (1600, 1000))
    draw = ImageDraw.Draw(image)
    for y in range(1000):
        t = y / 1000
        draw.line((0, y, 1600, y), fill=(int(19+48*t), int(40+51*t), int(70+36*t)))
    draw.ellipse((1030, 145, 1110, 225), fill=(216, 212, 176))
    draw.polygon([(0, 610), (250, 350), (440, 600), (700, 305), (1060, 660), (1370, 400), (1600, 650), (1600, 1000), (0, 1000)], fill=(38, 66, 80))
    draw.polygon([(0, 770), (330, 530), (680, 840), (1000, 550), (1600, 910), (1600, 1000), (0, 1000)], fill=(18, 42, 53))
    buffer = io.BytesIO()
    image.save(buffer, "JPEG", quality=88)
    return buffer.getvalue()


def demo_news(now):
    examples = [
        ("nodeseek", "community", "分享一个轻量的 VPS 监控面板", "支持 Docker 部署和多节点监控，讨论安装体验与资源占用。", "技术"),
        ("linuxdo", "community", "自托管服务的备份与恢复，你有哪些实践？", "从定时备份到恢复验证，聊聊长期运行个人服务的经验。", "开发调优"),
        ("sina", "news", "主要股指上涨1.25%，科技板块领涨", "", ""),
        ("BBC", "foreign", "全球科技与能源市场观察", "", ""),
        ("nodeseek", "community", "最近有哪些适合个人主页的开源项目？", "整理一些简单、稳定、方便日常使用的个人主页工具。", "日常"),
        ("linuxdo", "community", "用浏览器打造自己的信息工作台", "分享 RSS 聚合、快捷入口和个性化布局的设计思路。", "资源荟萃"),
    ]
    result = []
    for i in range(84):
        source, category, title, summary, forum_category = examples[i % len(examples)]
        ts = now - i * 420
        result.append({
            "id": f"demo-{i}", "time": datetime.fromtimestamp(ts, timezone(timedelta(hours=8))).strftime("%H:%M"),
            "raw_time": ts, "content": title + (f" · 示例 {i+1}" if i >= len(examples) else ""),
            "summary": summary, "source": source, "category": category, "forum_category": forum_category,
            "url": "https://www.nodeseek.com/" if source == "nodeseek" else "https://linux.do/" if source == "linuxdo" else "",
            "format": "text", "is_important": source == "sina" and i % 12 == 2,
        })
    result.append({"id": "demo-tech", "raw_time": now-1200, "time": "", "source": "github", "category": "tech", "format": "html", "content": '<div class="tech-block-header">GitHub Trends · 示例</div><div class="tech-card-item"><a class="tech-title-link" href="https://github.com/gxmst/gxWeb">gxmst/gxWeb</a><div class="tech-desc-zh">实时信息工作台，聚合资讯、行情与社区讨论。</div></div>'})
    return {"last_updated": now, "news_list": sorted(result, key=lambda item: item["raw_time"], reverse=True)}


class PreviewHandler(AdminHandlerMixin, SimpleHTTPRequestHandler):
    demo = False
    data_dir = None
    wallpaper = b""

    def end_headers(self):
        # Local edits must be visible on reload, including imported JS modules.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_data(self, body, mime):
        if not isinstance(body, bytes):
            body = json.dumps(body, ensure_ascii=False).encode() if mime == "application/json" else body.encode()
        self.send_response(200)
        self.send_header("Content-Type", f"{mime}; charset=utf-8" if mime != "image/jpeg" else mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if not self.handle_admin_api():
            self.api_json(404, {"error": "未知接口"})

    def do_GET(self):
        if self.handle_admin_api():
            return
        path = urlsplit(self.path).path
        name = path.lstrip("/")
        if self.data_dir and name in DATA_FILES:
            target = self.data_dir / name
            if target.is_file():
                self.send_data(target.read_bytes(), "application/json" if name.endswith(".json") else "text/plain")
                return
        if self.demo:
            now = int(time.time())
            if path == "/__demo/wallpaper.jpg":
                self.send_data(self.wallpaper, "image/jpeg")
                return
            payloads = {
                "finance-news.json": demo_news(now),
                "wallpapers.json": ["/__demo/wallpaper.jpg"],
                "ticker-status.json": {"updated_at": now, "status": "ok", "final_count": 6, "total_count": 6},
                "pipeline-status.json": {"updated_at": now, "jobs": {key: {"last_success": now, "count": 30 if key in {"nodeseek", "linuxdo"} else 1} for key in ["heartbeat", "ticker", "sina", "finance_news", "wallpaper", "weather", "wallpaper_list", "rss", "tech", "nodeseek", "linuxdo"]}},
            }
            payloads["ticker.json"] = [{"symbol": symbol, "name": label, "price": f"{price:.2f}", "change": change, "category": "预览示例", "price_history": [price-8, price-2, price-5, price+2, price]} for symbol, label, price, change in [("gold", "黄金", 2688.5, "+1.25%"), ("btc", "比特币", 76532, "-0.42%"), ("nasdaq", "纳斯达克", 18450, "+0.85%"), ("sp500", "标普500", 5802, "+0.31%"), ("oil", "原油", 71.8, "-1.20%"), ("usdcny", "美元/人民币", 7.15, "+0.02%")]]
            if name in payloads:
                self.send_data(payloads[name], "application/json")
                return
            if path == "/weather.txt":
                self.send_data("沈阳 · ☀️ 12°C", "text/plain")
                return
            if path == "/api/weather/forecast":
                days = [(datetime.now(timezone(timedelta(hours=8))) + timedelta(days=i)).strftime('%Y-%m-%d') for i in range(7)]
                self.send_data({"current_weather": {"temperature": 16, "weathercode": 3}, "daily": {"time": days, "weather_code": [3, 0, 2, 61, 3, 0, 1], "temperature_2m_max": [19, 21, 18, 16, 17, 20, 22], "temperature_2m_min": [8, 9, 7, 6, 7, 9, 10], "precipitation_probability_max": [10, 0, 20, 80, 15, 0, 5]}}, "application/json")
                return
            if path == "/api/weather/geocoding":
                self.send_data({"results": [{"name": "北京", "admin1": "北京", "country": "中国", "latitude": 39.9, "longitude": 116.4}]}, "application/json")
                return
        super().do_GET()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--demo", action="store_true", help="Use in-memory sample data")
    mode.add_argument("--data-dir", type=Path, help="Read copied VPS JSON/TXT files from this directory")
    parser.add_argument("--port", type=int, default=1882)
    args = parser.parse_args()
    PreviewHandler.admin = AdminState("gxweb-demo-2026" if args.demo else os.getenv("ADMIN_PASSWORD", ""), path=ROOT / ".local-preview" / "crawler-settings.json", secure=False)
    PreviewHandler.demo = args.demo
    PreviewHandler.data_dir = args.data_dir.resolve() if args.data_dir else None
    if args.demo:
        PreviewHandler.wallpaper = demo_wallpaper()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), partial(PreviewHandler, directory=str(ROOT / "public")))
    print(f"Preview: http://127.0.0.1:{args.port} ({'demo data' if args.demo else 'local/VPS data'})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
