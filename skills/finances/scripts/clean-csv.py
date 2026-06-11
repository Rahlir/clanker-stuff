#!/usr/bin/env python3
"""Mechanical cleanup for bank CSV exports, nothing semantic.

Converts to UTF-8 (auto-detecting the source encoding), normalizes line
endings to LF, and collapses runs of spaces. Fields and record structure
are deliberately untouched.

Numbers are untouched by default. With --decimal-comma, purely numeric
fields (e.g. "-1 234,56") are normalized to dot-decimal, space-free form
("-1234.56"). Use this when the journal's commodity style is dot-based:
hledger import copies amounts verbatim, so comma decimals reaching a
dot-style journal are silently re-read as digit-group marks.
"""

import argparse
import re
import sys
from pathlib import Path

# Tried in order when --encoding is not given. utf-8 is strict and tried
# first; windows-1250 covers Czech bank exports; latin-1 never fails and
# guarantees the fallback chain terminates.
ENCODING_CANDIDATES = ("utf-8", "windows-1250", "latin-1")

# A field is "purely numeric" when it is an optionally signed digit run with
# optional space digit-group separators and a comma decimal part. Anything
# else (dates, IDs, text) is left untouched.
NUMERIC_COMMA_FIELD = re.compile(r"-?\d[\d ]*,\d+")


def convert_decimal_commas(text: str, separator: str) -> str:
    def convert(field: str) -> str:
        if NUMERIC_COMMA_FIELD.fullmatch(field.strip()):
            return field.strip().replace(" ", "").replace(",", ".")
        return field

    return "\n".join(
        separator.join(convert(f) for f in line.split(separator))
        for line in text.split("\n")
    )


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
    parser.add_argument("--decimal-comma", action="store_true",
                        help="normalize purely numeric fields from comma "
                             "decimals to dot decimals (for dot-style "
                             "journals); requires a non-comma --separator")
    parser.add_argument("--separator", default=";",
                        help="field separator, used only to split fields "
                             "for --decimal-comma (default: ';')")
    args = parser.parse_args()

    if not args.input.is_file():
        parser.error(f"input file {args.input} does not exist")
    if args.decimal_comma and args.separator == ",":
        parser.error("--decimal-comma cannot work with a comma separator: "
                     "decimal commas and field boundaries are ambiguous")

    text, used = decode(args.input.read_bytes(), args.encoding)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"  +", " ", text)
    if args.decimal_comma:
        text = convert_decimal_commas(text, args.separator)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(text, encoding="utf-8")
    print(f"{args.input} -> {args.output} (source encoding: {used})",
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
