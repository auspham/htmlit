#!/usr/bin/env python3
"""Download the JS/CSS libraries htmlit serves locally, so the review surface
never waits on a CDN. Run once: `python3 vendor.py` (or `htmlit vendor`).

The daemon also prefetches any missing asset in the background on first use, so
this command is only needed to fetch everything up front or to `--force` a
refresh. The asset list and their pinned CDN sources live in
`htmlit_core/config.py` (`VENDOR_CDN`); the download logic is in
`htmlit_core/vendoring.py`.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from htmlit_core import config, vendoring  # noqa: E402  (import after sys.path setup)


def main() -> int:
    parser = argparse.ArgumentParser(description="Download htmlit vendored assets")
    parser.add_argument("--force", action="store_true", help="re-download even if cached")
    args = parser.parse_args()

    print(f"Vendoring into {config.VENDOR_DIR}")
    saved, failed = vendoring.vendor(force=args.force)
    for name in sorted(config.VENDOR_CDN):
        if name in saved:
            print(f"  saved {name}")
        elif name in failed:
            print(f"  FAIL  {name}: {failed[name]}", file=sys.stderr)
        else:
            print(f"  ok    {name} (cached)")
    if failed:
        print(f"{len(failed)} asset(s) failed; htmlit will fall back to CDN for those.", file=sys.stderr)
        return 1
    print("All assets vendored locally.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
