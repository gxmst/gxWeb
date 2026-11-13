"""Crawler logging setup with emoji-level auto-routing."""
import logging

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
_logger = logging.getLogger("spider")


def log(msg):
    """按 emoji 前缀自动分级：❌/🚨 → ERROR，⚠️ → WARNING，其它 → INFO。"""
    s = str(msg).lstrip()
    if s.startswith(("❌", "🚨")):
        _logger.error(msg)
    elif s.startswith("⚠️"):
        _logger.warning(msg)
    else:
        _logger.info(msg)
