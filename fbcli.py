#!/usr/bin/env python3
"""Standalone launcher so you can run `python fbcli.py ...` without installing."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fbcli.cli import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
