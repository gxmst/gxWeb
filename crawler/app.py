"""Multi-threaded spider orchestrator, watchdog, and bounded snapshot publisher."""
import hashlib
import os
import signal
import threading
import time

from runtime_config import read_config

from .config import (
    COMMUNITY_NEWS_LIMIT,
    FORUM_SOURCES,
    PIPELINE_JOB_TIMEOUT_SECONDS,
    PIPELINE_JOBS,
    PIPELINE_STATUS_FILE,
    RSS_NEWS_LIMIT,
    SINA_NEWS_LIMIT,
    TECH_NEWS_LIMIT,
)
from .feeds import fetch_rss_news, fetch_sina
from .forums import _forum_retry_state, fetch_forum_news
from .io_utils import atomic_load_json, atomic_save_json, atomic_save_text, get_beijing_time
from .log_utils import log
from .markets import fetch_ticker
from .media import fetch_bing_wallpaper, fetch_weather, update_wallpaper_list
from .tech import fetch_tech_news


class SpiderWorkerFailure(RuntimeError):
    """工作线程死亡或任务超时时触发的进程级故障。"""


class SpiderApp:
    def __init__(self):
        self.sina_news = []
        self.rss_news = []
        self.tech_news = []
        self.community_news = []
        self.last_wallpaper_date = None
        self.last_rss_time = 0
        self.last_weather_time = 0
        self.last_tech_time = 0
        self.last_wallpaper_list_time = 0
        self.shutdown = False
        self._shutdown_event = threading.Event()
        self.job_timeout_seconds = PIPELINE_JOB_TIMEOUT_SECONDS

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
        """过滤损坏项并按 identity 去重，避免坏缓存让工作线程退出。"""
        seen = set()
        unique = []
        for item in items or []:
            if not isinstance(item, dict):
                continue
            content = item.get("content")
            if not isinstance(content, str) or not content:
                continue
            identity = f"{item.get('source', '')}|{item.get('url', '')}|{item.get('id') or content}"
            content_hash = hashlib.md5(identity.encode()).hexdigest()
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
            SINA_NEWS_LIMIT,
        )
        self.rss_news = self._dedupe_news(
            [item for item in items if isinstance(item, dict) and item.get("category") == "foreign"],
            RSS_NEWS_LIMIT,
            newest_first=True,
        )
        self.tech_news = self._dedupe_news(
            [item for item in items if isinstance(item, dict) and item.get("category") == "tech"],
            TECH_NEWS_LIMIT,
        )
        self.community_news = self._dedupe_news(
            [item for item in items if isinstance(item, dict) and item.get("category") == "community"],
            COMMUNITY_NEWS_LIMIT,
            newest_first=True,
        )
        recovered = len(self.sina_news) + len(self.rss_news) + len(self.tech_news) + len(self.community_news)
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
            state["running"] = False

    def _persist_pipeline_status(self):
        """串行化工作线程的状态写入；状态盘失败不影响业务任务。"""
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
        """执行隔离任务并更新统一状态。"""
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
                state["last_error"] = f"任务运行超过 {self.job_timeout_seconds:g} 秒，触发进程重启"
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

        workers = {
            "fast": threading.Thread(target=self._fast_loop, name="fast", daemon=True),
            "slow": threading.Thread(target=self._slow_loop, name="slow", daemon=True),
            "forums": threading.Thread(target=self._forum_loop, name="forums", daemon=True),
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
        atomic_save_text("./public/heartbeat.txt", str(int(time.time())))
        return 1

    def _merge_by_source(self, old_items, new_items, limit, *, newest_first=False):
        """新结果缺少某个来源时沿用该来源旧块，避免部分故障造成内容抖动。"""
        fresh_sources = {
            item.get("source")
            for item in new_items
            if isinstance(item, dict) and item.get("source")
        }
        retained = [
            item
            for item in old_items
            if isinstance(item, dict) and item.get("source") not in fresh_sources
        ]
        return self._dedupe_news(
            list(new_items) + retained,
            limit,
            newest_first=newest_first,
        )

    def _accumulate_news(
        self, old_items, new_items, limit, *, newest_first=True, per_source_limit=None
    ):
        """同源增量滚存合并：新条目刷新同 identity 数据，旧条目按各源配额累积留存。"""
        combined = self._dedupe_news(
            list(new_items or []) + list(old_items or []),
            max(limit * 2, limit),
            newest_first=newest_first,
        )
        if not per_source_limit or per_source_limit <= 0:
            return combined[:limit]

        selected = []
        overflow = []
        source_counts = {}
        for item in combined:
            src = item.get("source") or ""
            count = source_counts.get(src, 0)
            if count < per_source_limit:
                source_counts[src] = count + 1
                selected.append(item)
            else:
                overflow.append(item)

        if len(selected) < limit and overflow:
            selected.extend(overflow[: limit - len(selected)])
            if newest_first:
                selected.sort(key=lambda x: x.get("raw_time", 0), reverse=True)
        return selected[:limit]

    def _publish_finance_news(self):
        with self._data_lock:
            sina_snapshot = list(self.sina_news)
            rss_snapshot = list(self.rss_news)
            tech_snapshot = list(self.tech_news)
            community_snapshot = list(self.community_news)

        final_news = sina_snapshot + rss_snapshot + tech_snapshot + community_snapshot
        final_news.sort(key=lambda x: x.get("raw_time", 0), reverse=True)
        if not final_news:
            return []

        output_data = {
            "last_updated": int(get_beijing_time().timestamp()),
            "news_list": final_news,
        }
        atomic_save_json("./public/finance-news.json", output_data, compact=True)
        log(
            f"✅ [fast] 更新完成：总库 {len(final_news)} 条 "
            f"(新浪 {len(sina_snapshot)} / RSS {len(rss_snapshot)} / "
            f"科技 {len(tech_snapshot)} / 社区 {len(community_snapshot)})。"
        )
        return final_news

    def _fast_loop(self):
        """行情 + 新浪快讯；动态读取服务端间隔。"""
        last_completed = None
        last_heartbeat = None
        while not self.shutdown:
            now_mono = time.monotonic()
            if last_heartbeat is None or now_mono - last_heartbeat >= 60:
                self._run_job("heartbeat", self._touch_heartbeat)
                last_heartbeat = time.monotonic()
            interval = read_config()["intervals"]["fast"]
            if last_completed is not None:
                wait = last_completed + interval - time.monotonic()
                if wait > 0:
                    self._interruptible_sleep(min(10, wait))
                    continue
            now_bj = get_beijing_time()
            log(f"\n--- [fast] {now_bj.strftime('%H:%M:%S')} 行情+快讯 ---")

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
                    self.sina_news = self._accumulate_news(
                        self.sina_news, sina_news_raw, SINA_NEWS_LIMIT, newest_first=True
                    )

            self._run_job(
                "finance_news",
                self._publish_finance_news,
                success_if=bool,
                failure_message="没有可发布新闻，未覆盖现有文件",
            )

            last_completed = time.monotonic()
            self._interruptible_sleep(10)

    def _slow_loop(self):
        """慢任务独立记时与报错；抓取为空时保留内存中的 last-known-good。"""
        intervals = {"weather": 1800.0, "wallpaper_list": 300.0, "rss": 1800.0, "tech": 1800.0}
        last_completed = {name: None for name in intervals}
        wallpaper_retry_due = 0.0

        while not self.shutdown:
            intervals = read_config()["intervals"]
            now_mono = time.monotonic()
            today = get_beijing_time().strftime("%Y-%m-%d")

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
                wallpaper_retry_due = time.monotonic() + 300.0

            if last_completed["weather"] is None or now_mono >= last_completed["weather"] + intervals["weather"]:
                self.last_weather_time = time.time()
                self._run_job("weather", fetch_weather)
                last_completed["weather"] = time.monotonic()

            if last_completed["wallpaper_list"] is None or now_mono >= last_completed["wallpaper_list"] + intervals["wallpaper_list"]:
                self.last_wallpaper_list_time = time.time()
                self._run_job("wallpaper_list", update_wallpaper_list)
                last_completed["wallpaper_list"] = time.monotonic()

            if last_completed["rss"] is None or now_mono >= last_completed["rss"] + intervals["rss"]:
                self.last_rss_time = time.time()
                rss_ok, rss_news_raw = self._run_job(
                    "rss",
                    fetch_rss_news,
                    success_if=bool,
                    failure_message="本轮为空，已保留上次 RSS 数据",
                )
                if rss_ok:
                    with self._data_lock:
                        self.rss_news = self._accumulate_news(
                            self.rss_news,
                            rss_news_raw,
                            RSS_NEWS_LIMIT,
                            newest_first=True,
                            per_source_limit=60,
                        )
                last_completed["rss"] = time.monotonic()

            if last_completed["tech"] is None or now_mono >= last_completed["tech"] + intervals["tech"]:
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
                            self.tech_news, tech_news_raw, TECH_NEWS_LIMIT
                        )
                last_completed["tech"] = time.monotonic()

            self._interruptible_sleep(30)

    def _forum_loop(self):
        """社区任务独立轮询，不被翻译或科技抓取阻塞；失败时保留该来源旧数据。"""
        last_completed = {source: None for source in FORUM_SOURCES}
        while not self.shutdown:
            intervals = read_config()["intervals"]
            for source in FORUM_SOURCES:
                if self.shutdown:
                    break
                if time.monotonic() < _forum_retry_state.get(source, {}).get("until", 0):
                    continue
                if last_completed[source] is not None and time.monotonic() < last_completed[source] + intervals[source]:
                    continue
                ok, items = self._run_job(
                    source,
                    lambda source=source: fetch_forum_news(source),
                    success_if=bool,
                    failure_message="公开订阅暂不可用，保留上次帖子",
                )
                if ok:
                    with self._data_lock:
                        self.community_news = self._accumulate_news(
                            self.community_news,
                            items,
                            COMMUNITY_NEWS_LIMIT,
                            newest_first=True,
                            per_source_limit=180,
                        )
                last_completed[source] = time.monotonic()
            self._interruptible_sleep(30)

    def _handle_signal(self, signum, frame):
        log(f"\n🛑 收到信号 {signum}，正在优雅退出...")
        self.shutdown = True
        self._shutdown_event.set()
