#!/usr/bin/env python3
"""Mechanical cleanup for bank CSV exports, nothing semantic.

Converts to UTF-8 (auto-detecting the source encoding), normalizes line
endings to LF, and collapses runs of spaces. Numbers, fields, and record
structure are deliberately untouched: decimal commas are handled by
`decimal-mark` in the hledger rules file, not here.
"""

import argparse
import re
import sys
from pathlib import Path

# Tried in order when --encoding is not given. utf-8 is strict and tried
# first; windows-1250 covers Czech bank exports; latin-1 never fails and
# guarantees the fallback chain terminates.
ENCODING_CANDIDATES = ("utf-8", "windows-1250", "latin-1")


def decode(raw: bytes, forced: str | None) -> tuple[str, str]:
    if forced:
        return raw.decode(forced), forced
    for enc in ENCODING_CANDIDATES:
        try:
            return raw.decode(enc), enc
        except UnicodeDecodeError:
            continue
    raise AssertionError("unreachable: latin-1 cannot fail")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="raw bank export")
    parser.add_argument("-o", "--output", type=Path, required=True,
                        help="cleaned UTF-8 file to write (the staging path)")
    parser.add_argument("--encoding",
                        help="source encoding; default: auto-detect "
                             f"({', '.join(ENCODING_CANDIDATES)})")
    args = parser.parse_args()

    if not args.input.is_file():
        parser.error(f"input file {args.input} does not exist")

    text, used = decode(args.input.read_bytes(), args.encoding)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"  +", " ", text)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(text, encoding="utf-8")
    print(f"{args.input} -> {args.output} (source encoding: {used})",
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
