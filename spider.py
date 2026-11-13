"""Spider entrypoint & backward-compatible facade over the `crawler` package."""
import logging
import os

from crawler import *  # noqa: F403
from crawler.log_utils import log
from crawler.translator import _load_translate_cache
from crawler.app import SpiderApp, SpiderWorkerFailure

if __name__ == "__main__":
    _load_translate_cache()
    app = SpiderApp()
    try:
        app.run()
    except SpiderWorkerFailure as e:
        # 翻译线程池等在解释器退出时会 join；硬退出确保 Docker restart 策略确实接管。
        log(f"🚨 [系统] 致命工作线程故障: {e}")
        logging.shutdown()
        os._exit(1)
