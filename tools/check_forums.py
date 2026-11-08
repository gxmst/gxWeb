"""One-off public RSS connectivity check; writes no application data."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import spider


def main():
    failed = False
    for source, config in spider.FORUM_SOURCES.items():
        try:
            items = spider.fetch_forum_news(source)
            print(f"OK {config['name']}: {len(items)} items; newest: {items[0]['content'][:100]}")
        except Exception as error:
            failed = True
            print(f"FAIL {config['name']}: {type(error).__name__}: {error}")
    return int(failed)


if __name__ == "__main__":
    sys.exit(main())
