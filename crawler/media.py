"""Bing wallpaper downloader, favorite scanner, and Open-Meteo default weather."""
import io
import os

from PIL import Image

from .io_utils import (
    atomic_save_json,
    atomic_save_text,
    get_beijing_time,
    get_random_ua,
    get_session,
)
from .log_utils import log


def fetch_bing_wallpaper():
    log(f"[{get_beijing_time().strftime('%H:%M:%S')}][壁纸引擎] 正在检查今日必应壁纸...")
    try:
        url = "https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=5&mkt=zh-CN"
        metadata_resp = get_session().get(url, headers={"User-Agent": get_random_ua()}, timeout=10)
        metadata_resp.raise_for_status()
        images = (metadata_resp.json().get("images") or [])
        if not images:
            raise ValueError("必应未返回图片列表")

        new_images = []
        meta_map = {}
        for i, item in enumerate(images):
            img_url = "https://www.bing.com" + item["url"]
            img_resp = get_session().get(img_url, headers={"User-Agent": get_random_ua()}, timeout=15)
            img_resp.raise_for_status()
            new_images.append((i, Image.open(io.BytesIO(img_resp.content)).convert("RGB")))
            meta_map[f"bg_{i}.jpg"] = {
                "title": str(item.get("title") or "").strip(),
                "copyright": str(item.get("copyright") or "").strip(),
                "startdate": str(item.get("startdate") or "").strip(),
            }

        tmp_paths = []
        try:
            for i, img in new_images:
                tmp_path = f"./public/bg_{i}.jpg.tmp"
                img.save(tmp_path, "JPEG", quality=82, optimize=True, progressive=True)
                tmp_paths.append((i, tmp_path))
        except Exception:
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

        atomic_save_json("./public/wallpapers-meta.json", meta_map)

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
        for f in os.listdir(favorite_dir):
            if f.lower().endswith((".jpg", ".jpeg", ".png", ".webp")):
                favorite_files.append(f"favorite/{f}")
    except Exception as e:
        log(f"❌ [壁纸引擎] 扫描收藏夹失败: {e}")
        raise

    bing_files = [f"bg_{i}.jpg" for i in range(5) if os.path.exists(f"./public/bg_{i}.jpg")]
    wallpapers = favorite_files + bing_files

    if atomic_save_json("./public/wallpapers.json", wallpapers):
        log(f"✅ [壁纸引擎] 已更新 wallpapers.json，共包含 {len(wallpapers)} 张壁纸。")
    return len(wallpapers)


def get_weather_coordinates():
    def parse_coordinate(name, default, minimum, maximum):
        try:
            value = float(os.getenv(name, str(default)))
        except (TypeError, ValueError):
            return default
        return value if minimum <= value <= maximum else default

    return (
        parse_coordinate("WEATHER_LATITUDE", 41.80, -90, 90),
        parse_coordinate("WEATHER_LONGITUDE", 123.43, -180, 180),
    )


def fetch_weather():
    try:
        latitude, longitude = get_weather_coordinates()
        url = "https://api.open-meteo.com/v1/forecast"
        response = get_session().get(
            url,
            params={"latitude": latitude, "longitude": longitude, "current_weather": "true"},
            headers={"User-Agent": get_random_ua()},
            timeout=10,
        )
        response.raise_for_status()
        curr = response.json().get("current_weather", {})
        temp, code = curr.get("temperature"), curr.get("weathercode")
        if temp is None or code is None:
            raise ValueError("天气接口缺少 temperature/weathercode")
        emoji_map = {
            0: "☀️", 1: "☁️", 2: "☁️", 3: "☁️",
            45: "🌫️", 48: "🌫️", 95: "⛈️",
        }
        if 71 <= code <= 77:
            emoji = "❄️"
        elif 51 <= code <= 67:
            emoji = "🌧️"
        else:
            emoji = emoji_map.get(code, "☁️")
        atomic_save_text("./public/weather.txt", f"{emoji} {temp}°C")
        log("✅ [天气引擎] 天气数据已更新。")
        return 1
    except Exception as e:
        log(f"❌ [天气引擎] 失败: {e}")
        raise
