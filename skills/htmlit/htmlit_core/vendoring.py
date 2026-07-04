"""Download the front-end libraries htmlit serves locally.

The daemon serves each asset from the CDN until a local copy exists (see
``config.asset_url``). To avoid a permanent CDN round-trip, the daemon prefetches
any missing asset in the background on first use, so the next page load is served
from disk. The ``htmlit vendor`` command does the same fetch up front.

Downloads run in parallel and write atomically (through a ``.part`` temp file),
so a page request can never read a half-written asset.
"""

from __future__ import annotations

import concurrent.futures
import urllib.request

from . import config

USER_AGENT = "htmlit-vendor/1.0"
FETCH_TIMEOUT = 30
MAX_WORKERS = 5


def missing() -> dict[str, str]:
    """Return the {name: cdn_url} assets that are not yet cached locally."""
    out: dict[str, str] = {}
    for name, url in config.VENDOR_CDN.items():
        dest = config.VENDOR_DIR / name
        if not dest.is_file() or dest.stat().st_size == 0:
            out[name] = url
    return out


def _fetch(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=FETCH_TIMEOUT) as response:
        return response.read()


def _download(name: str, url: str) -> None:
    """Fetch one asset and write it atomically so a partial file is never served."""
    data = _fetch(url)
    if not data:
        raise ValueError("empty response")
    config.VENDOR_DIR.mkdir(parents=True, exist_ok=True)
    tmp = config.VENDOR_DIR / (name + ".part")
    tmp.write_bytes(data)
    tmp.replace(config.VENDOR_DIR / name)


def download(items: dict[str, str], workers: int = MAX_WORKERS) -> tuple[list[str], dict[str, str]]:
    """Download the given assets in parallel.

    Returns ``(saved, failed)`` where ``saved`` lists the names written and
    ``failed`` maps each failed name to its error message. Never raises: a failed
    asset simply keeps its CDN fallback.
    """
    if not items:
        return [], {}
    saved: list[str] = []
    failed: dict[str, str] = {}
    workers = max(1, min(workers, len(items)))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(_download, name, url): name for name, url in items.items()}
        for future in concurrent.futures.as_completed(futures):
            name = futures[future]
            try:
                future.result()
                saved.append(name)
            except Exception as exc:  # noqa: BLE001 - best effort, reported per asset
                failed[name] = str(exc)
    return saved, failed


def vendor(force: bool = False, workers: int = MAX_WORKERS) -> tuple[list[str], dict[str, str]]:
    """Download the vendored assets, skipping cached ones unless ``force``."""
    items = dict(config.VENDOR_CDN) if force else missing()
    return download(items, workers=workers)
