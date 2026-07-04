#!/usr/bin/env python3
"""Entry point for the htmlit command-line interface.

The implementation lives in :mod:`htmlit_core.cli`; this wrapper is what the
``htmlit`` launcher on PATH runs.
"""

from __future__ import annotations

from htmlit_core.cli import main

if __name__ == "__main__":
    raise SystemExit(main())
