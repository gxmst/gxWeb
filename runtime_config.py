"""Shared crawler settings. The writable file lives outside the public web root."""
import json
import os
import tempfile
import threading
from pathlib import Path

INTERVAL_RULES = {
    "fast": (60, 3600, 60),
    "weather": (300, 86400, 1800),
    "wallpaper_list": (60, 86400, 300),
    "rss": (300, 86400, 1800),
    "tech": (300, 86400, 1800),
    "nodeseek": (300, 86400, 300),
    "linuxdo": (300, 86400, 300),
}


def default_intervals():
    result = {key: rule[2] for key, rule in INTERVAL_RULES.items()}
    try:
        forum = int(os.getenv("FORUM_POLL_INTERVAL_SECONDS", "300"))
    except ValueError:
        forum = 300
    result.update(nodeseek=max(300, min(86400, forum)), linuxdo=max(300, min(86400, forum)))
    return result


def config_path():
    return Path(os.getenv("CRAWLER_CONFIG_PATH", str(Path(__file__).resolve().parent / "state" / "crawler-settings.json")))


def read_config(path=None):
    result = {"version": 1, "revision": 0, "intervals": default_intervals()}
    try:
        saved = json.loads(Path(path or config_path()).read_text(encoding="utf-8"))
        if saved.get("version") != 1:
            return result
        result["revision"] = max(0, int(saved.get("revision", 0)))
        for key, value in saved.get("intervals", {}).items():
            if key in INTERVAL_RULES and type(value) is int:
                low, high, _ = INTERVAL_RULES[key]
                if low <= value <= high:
                    result["intervals"][key] = value
    except (OSError, ValueError, TypeError, AttributeError):
        pass
    return result


class ConfigStore:
    def __init__(self, path=None):
        self.path = Path(path or config_path())
        self.lock = threading.RLock()

    def update(self, intervals, revision):
        if not isinstance(intervals, dict) or not intervals or set(intervals) - INTERVAL_RULES.keys():
            raise ValueError("未知设置或空设置")
        for key, value in intervals.items():
            low, high, _ = INTERVAL_RULES[key]
            if type(value) is not int or not low <= value <= high:
                raise ValueError(f"{key} 需在 {low}–{high} 秒之间")
        with self.lock:
            current = read_config(self.path)
            if type(revision) is not int or revision != current["revision"]:
                raise RuntimeError("设置已被更新，请重新加载后保存")
            current["intervals"].update(intervals)
            current["revision"] += 1
            self.path.parent.mkdir(parents=True, exist_ok=True)
            descriptor, temporary = tempfile.mkstemp(prefix=".crawler-", dir=self.path.parent)
            try:
                with os.fdopen(descriptor, "w", encoding="utf-8") as output:
                    json.dump(current, output, ensure_ascii=False)
                    output.flush()
                    os.fsync(output.fileno())
                os.replace(temporary, self.path)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
            return current
