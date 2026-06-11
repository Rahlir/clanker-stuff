#!/usr/bin/env python3
"""Fetch the latest market price for each commodity and print hledger P directives.

Sources come from the [prices.sources] table of finances.toml (located beside
$LEDGER_FILE, or passed with --config). Quotes are fetched from Yahoo Finance's
unofficial chart API; stdlib only. Requires Python 3.11+ (tomllib).

Read-only by design: this script never writes any file. Review the printed
P directives and append them to the prices journal through the guarded flow
in references/prices.md.

Exit codes:
  0  all commodities fetched
  1  some commodities failed (successful ones are still printed)
  2  configuration or usage error
"""

import argparse
import http.client
import json
import os
import sys
import tomllib
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import NoReturn
from zoneinfo import ZoneInfo

CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?range=5d&interval=1d"
USER_AGENT = "Mozilla/5.0 (compatible; finances-skill-update-prices/1.0)"
TIMEOUT_S = 15


def die(msg: str) -> NoReturn:
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(2)


def default_config_path() -> Path:
    ledger = os.environ.get("LEDGER_FILE")
    if not ledger:
        die("LEDGER_FILE is not set and no --config given")
    return Path(ledger).expanduser().parent / "finances.toml"


def load_sources(config_path: Path) -> dict[str, dict]:
    if not config_path.is_file():
        die(f"config file not found: {config_path}")
    with config_path.open("rb") as fp:
        config = tomllib.load(fp)
    sources = config.get("prices", {}).get("sources")
    if not sources:
        die(f"no [prices.sources] table in {config_path}")
    for name, entry in sources.items():
        if not isinstance(entry, dict) or "ticker" not in entry or "quote" not in entry:
            die(f"[prices.sources].{name} must define 'ticker' and 'quote'")
    return sources


def fetch_quote(ticker: str) -> tuple[str, float, str, int]:
    """Return (ISO date, close, quote currency, decimal hint) for a ticker.

    The date is the trading day in the exchange's own timezone, so a US
    after-hours timestamp does not roll over to the next UTC day.
    """
    url = CHART_URL.format(ticker=urllib.parse.quote(ticker, safe="=^.-"))
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
        data = json.load(resp)

    chart = data.get("chart") or {}
    if chart.get("error"):
        err = chart["error"]
        raise RuntimeError(err.get("description") or err.get("code") or "unknown API error")
    result = (chart.get("result") or [None])[0]
    if not result:
        raise RuntimeError("empty chart result")

    meta = result.get("meta") or {}
    closes = (result.get("indicators", {}).get("quote") or [{}])[0].get("close") or []
    timestamps = result.get("timestamp") or []
    points = [(ts, c) for ts, c in zip(timestamps, closes) if c is not None]
    if points:
        ts, close = points[-1]
    elif meta.get("regularMarketPrice") is not None and meta.get("regularMarketTime"):
        ts, close = meta["regularMarketTime"], meta["regularMarketPrice"]
    else:
        raise RuntimeError("no close prices in response")

    try:
        tz = ZoneInfo(meta.get("exchangeTimezoneName") or "UTC")
    except Exception:
        tz = timezone.utc
    date = datetime.fromtimestamp(ts, tz).date().isoformat()

    hint = meta.get("priceHint")
    decimals = hint if isinstance(hint, int) and 0 <= hint <= 8 else 2
    return date, close, meta.get("currency") or "?", decimals


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Print hledger P directives with the latest market prices."
    )
    parser.add_argument(
        "-c", "--config", type=Path, default=None,
        help="path to finances.toml (default: beside $LEDGER_FILE)",
    )
    parser.add_argument(
        "commodities", nargs="*", metavar="COMMODITY",
        help="fetch only these commodities (default: all in [prices.sources])",
    )
    args = parser.parse_args()

    sources = load_sources(args.config or default_config_path())
    if args.commodities:
        unknown = [c for c in args.commodities if c not in sources]
        if unknown:
            die(f"not in [prices.sources]: {', '.join(unknown)}")
        sources = {name: sources[name] for name in args.commodities}

    failed = []
    for name, entry in sources.items():
        ticker, quote = entry["ticker"], entry["quote"]
        try:
            date, close, api_ccy, decimals = fetch_quote(ticker)
        except (
            urllib.error.URLError,
            http.client.HTTPException,
            RuntimeError,
            KeyError,
            ValueError,
        ) as exc:
            print(f"warning: {name} ({ticker}): {exc}", file=sys.stderr)
            failed.append(name)
            continue
        if api_ccy != quote:
            print(
                f"warning: {name} ({ticker}): API quotes in {api_ccy}, "
                f"config expects {quote}; skipping (fix the ticker or quote)",
                file=sys.stderr,
            )
            failed.append(name)
            continue
        print(f"P {date} {name} {close:.{decimals}f} {quote}")

    if failed:
        print(f"warning: failed commodities: {', '.join(failed)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
