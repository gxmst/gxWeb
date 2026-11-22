"""Global financial market ticker fetcher (Sina primary + Tencent fallback)."""
import json
import os

from runtime_config import read_config

from .config import MARKET_TICKERS, TICKER_FILE, TICKER_STATUS_FILE
from .io_utils import (
    atomic_save_json,
    format_market_price,
    get_beijing_time,
    get_random_ua,
    get_session,
)
from .log_utils import log


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
        "source": source or "Sina",
    }


def _parse_sina_quote(sym, raw):
    """按新浪行情前缀提取 (当前价, 昨收价)；无效或缺少字段返回 (None, None)。"""
    n = len(raw)
    if sym.startswith("gb_") and n > 26:
        return float(raw[1]), float(raw[26])
    if sym.startswith("fx_") and n > 3:
        return float(raw[1]), float(raw[3])
    if sym.startswith("hf_") and n > 8:
        return float(raw[0]), float(raw[7])
    if sym.startswith("rt_hk") and n > 6:
        return float(raw[6]), float(raw[3])
    if sym.startswith("s_") and n > 2:
        price = float(raw[1])
        return price, price - float(raw[2])
    if sym.startswith("b_") and n > 2:
        # b_ 全球指数：[1]=当前价，[2]=涨跌额，完整字段下 [9]=昨收（部分指数如台湾加权仅返回 6 个字段）
        price = float(raw[1])
        prev_close = float(raw[9]) if n > 9 and raw[9] else price - float(raw[2])
        return price, prev_close
    return None, None


def _fetch_sina_all(configs):
    result_map = {}
    sina_entries = [
        {
            "symbol": cfg["sina"],
            "canonical": cfg["symbol"],
            "name": cfg["name"],
            "category": cfg["category"],
            "decimals": cfg["decimals"],
        }
        for cfg in (configs or [])
        if cfg.get("sina")
    ]
    if not sina_entries:
        return result_map

    try:
        symbols = ",".join(c["symbol"] for c in sina_entries)
        url = f"https://hq.sinajs.cn/list={symbols}"
        headers = {
            "Referer": "https://finance.sina.com.cn/",
            "Origin": "https://finance.sina.com.cn",
            "Accept": "*/*",
            "User-Agent": get_random_ua(),
        }
        resp = get_session().get(url, headers=headers, timeout=15)
        resp.raise_for_status()
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
            if len(data) >= 2:
                sina_raw[key] = data

        for entry in sina_entries:
            raw = sina_raw.get(entry["symbol"])
            if not raw:
                continue
            try:
                p, pc = _parse_sina_quote(entry["symbol"], raw)
                if p and pc and p > 0 and pc > 0:
                    cfg_full = {
                        "symbol": entry["canonical"],
                        "name": entry["name"],
                        "category": entry["category"],
                        "decimals": entry["decimals"],
                    }
                    result_map[entry["canonical"]] = build_ticker_entry(cfg_full, p, pc, source="Sina")
            except (ValueError, TypeError, IndexError):
                pass

    except Exception as e:
        log(f"  ⚠️ [行情引擎] Sina 抓取异常: {type(e).__name__}: {e}")

    return result_map


def _fetch_tencent_all(configs):
    """腾讯 qt.gtimg.cn 备用源，仅补齐 Sina 拉取失败的标的。"""
    result_map = {}
    entries = [c for c in configs if c.get("tencent")]
    if not entries:
        return result_map

    try:
        symbols = ",".join(c["tencent"] for c in entries)
        url = f"https://qt.gtimg.cn/q={symbols}"
        headers = {"Referer": "https://gu.qq.com/", "User-Agent": get_random_ua()}
        resp = get_session().get(url, headers=headers, timeout=15)
        resp.raise_for_status()
        resp.encoding = "gbk"

        tencent_raw = {}
        for line in resp.text.splitlines():
            if not line or "=" not in line:
                continue
            key = line.split("=")[0].split("_", 1)[-1]
            data_str = line.split("=", 1)[1].strip().strip('";')
            if data_str:
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
    ts_str = get_beijing_time().strftime("%H:%M:%S")
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

    sina_results = _fetch_sina_all(MARKET_TICKERS)
    result_map.update(sina_results)
    sina_count = len(sina_results)

    missing_configs = [c for c in MARKET_TICKERS if c["symbol"] not in result_map]
    tencent_count = 0
    if missing_configs:
        tencent_results = _fetch_tencent_all(missing_configs)
        result_map.update(tencent_results)
        tencent_count = len(tencent_results)

    for config in MARKET_TICKERS:
        sym = config["symbol"]
        if sym not in result_map and sym in old_ticker_map:
            result_map[sym] = old_ticker_map[sym]
            stale_used.append(config["name"])

    unique_count = len(result_map)
    threshold = max(10, int(total_count * 0.5))

    price_history_map = {
        sym: item["price_history"]
        for sym, item in old_ticker_map.items()
        if isinstance(item.get("price_history"), list) and item["price_history"]
    }

    for sym, entry in result_map.items():
        try:
            current_price = float(entry["price"])
            old_history = price_history_map.get(sym, [])
            entry["price_history"] = (old_history + [current_price])[-20:]
        except (ValueError, KeyError):
            pass

    fresh_count = sina_count + tencent_count
    if unique_count >= threshold and fresh_count > 0:
        atomic_save_json(TICKER_FILE, list(result_map.values()), compact=True)
        status = "degraded" if stale_used else "ok"
        log(f"  ✅ [行情引擎] 本轮写入 {unique_count} 条 (阈值 {threshold}) 状态={status}")
    else:
        status = "failed"
        if os.path.exists(TICKER_FILE):
            log(
                f"  ⚠️ [行情引擎] 本轮新鲜数据 {fresh_count} 条、最终 {unique_count} 条 "
                f"(阈值 {threshold})，保留上次成功数据"
            )
        else:
            log(f"  ⚠️ [行情引擎] 本轮仅 {unique_count} 条且无历史文件，跳过写入")

    status_payload = {
        "updated_at": int(get_beijing_time().timestamp()),
        "status": status,
        "interval": read_config()["intervals"]["fast"],
        "primary_provider": "sina",
        "primary_success_count": sina_count,
        "fallback_provider": "tencent",
        "fallback_success_count": tencent_count,
        "stale_used_count": len(stale_used),
        "final_count": unique_count,
        "total_count": total_count,
    }
    atomic_save_json(TICKER_STATUS_FILE, status_payload)

    log(
        f"  📊 [行情引擎] 总标的: {total_count} | Sina: {sina_count} | "
        f"Tencent: {tencent_count} | 沿用旧值: {len(stale_used)} | 最终: {unique_count} | 状态: {status}"
    )
    if stale_used:
        log(f"  ℹ️ [行情引擎] 沿用旧值: {', '.join(stale_used)}")
    return status_payload
