#!/usr/bin/env python3
"""Entry point for the htmlit review daemon.

The implementation lives in the :mod:`htmlit_core` package. This thin wrapper
keeps ``python3 htmlit_server.py`` working as the process the CLI spawns.
"""

from __future__ import annotations

from htmlit_core.server import main

if __name__ == "__main__":
    raise SystemExit(main())
