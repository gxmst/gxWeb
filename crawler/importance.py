"""Deterministic importance scoring for financial news items."""
from .config import IMPORTANCE_RULES
from .io_utils import clean_html


def _is_positive_flag(value):
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    try:
        return float(value) > 0
    except (TypeError, ValueError):
        return str(value).strip().lower() in {"true", "yes", "on"}


def classify_news_importance(text, upstream=None):
    """返回可解释的重要性分数和原因；兼容新浪新旧字段。"""
    upstream = upstream or {}
    if _is_positive_flag(upstream.get("is_focus")) or _is_positive_flag(upstream.get("focus")):
        return 100, "新浪焦点"
    if _is_positive_flag(upstream.get("top_value")) or _is_positive_flag(upstream.get("is_top")):
        return 95, "新浪置顶"

    normalized = clean_html(str(text or ""))
    for score, reason, pattern in IMPORTANCE_RULES:
        if pattern.search(normalized):
            return score, reason
    return 0, ""
