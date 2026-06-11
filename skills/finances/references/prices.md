# Updating market prices

How to refresh the `P` price directives that valued reports (net worth,
holdings value, ROI) depend on. The flow is: fetch quotes with a read-only
script, review them with the user, append to a dedicated prices journal under
the same write discipline as every other journal write.

Two hard rules:

- **Never modify or delete existing `P` lines** - not in the main journal
  (where older, manually entered prices may be interspersed by date), not in
  the prices journal. Prices are only ever appended.
- **The script never writes.** `scripts/update-prices.py` prints proposed
  directives to stdout; the append is a separate, user-confirmed step.

## One-time setup: the prices journal

Automated prices go to a dedicated `prices.journal` beside the main journal,
so automation never touches the transaction file. If it does not exist yet:

1. Confirm the plan with the user, then create it:
   ```bash
   printf '; Market prices appended by the finances skill. Append-only.\n' \
     > "$(dirname "$LEDGER_FILE")/prices.journal"
   ```
2. Append the include to the **end** of the main journal (appending avoids
   editing mid-file; show the exact line and get confirmation first). The
   relative path is correct: hledger resolves `include` paths relative to the
   including file, and both files sit in the same directory:
   ```bash
   printf '\ninclude prices.journal\n' >> "$LEDGER_FILE"
   ```
3. Verify: `hledger check accounts ordereddates commodities` and
   `hledger check balanced` (separate invocations, as always), then
   `hledger files` should list the new journal.

Existing manually entered `P` lines stay where they are; hledger merges
prices from all included files and uses the newest by date.

## Refresh workflow

Run this when the stale-price guard fires (offer it, don't force it) or when
the user asks to update prices.

### 1. Fetch

```bash
<skill-dir>/scripts/update-prices.py            # all of [prices.sources]
<skill-dir>/scripts/update-prices.py USD NVDA   # subset
```

The script reads `finances.toml` beside `$LEDGER_FILE` (`--config` to
override) and prints one `P` line per commodity:

```
P 2026-06-10 USD 20.9520 CZK
P 2026-06-10 NVDA 200.42 USD
```

Exit 1 means some commodities failed (warnings on stderr name them);
successful lines are still printed and may still be used. Commodities in
`[prices].commodities` without a `[prices.sources]` entry are intentionally
manual - the guard keeps warning about them, the script does not touch them.
That is the script's whole contract - treat it as a black box; there is no
need to read its source. It writes no files, ever.

### 2. Review with the user

Before proposing the append, sanity-check each fetched line against the
current newest price:

```bash
for c in USD EUR NVDA; do hledger prices cur:"$c" | tail -n 1; done
```

- **Large jumps** (roughly >20% versus the previous price) are worth a human
  look - they can be real, but also a ticker change, a split, or a bad quote.
  Point them out explicitly.
- **Same-date duplicates**: compare each fetched line's date against the date
  on that commodity's current newest line from the loop above. If they match,
  that commodity is already up to date - drop the fetched line from the
  proposal and say so (re-running on the same day is the common cause; never
  "update" the existing line).
- **Dates on weekends/holidays** resolve to the last trading day - expected,
  not an error.

Show the exact lines that will be appended and get explicit confirmation.

### 3. Append, validate, roll back on failure

```bash
PRICES="$(dirname "$LEDGER_FILE")/prices.journal"
BYTES_BEFORE=$(wc -c < "$PRICES")

# append exactly the lines the user confirmed (example):
printf '%s\n' \
  'P 2026-06-10 USD 20.9520 CZK' \
  'P 2026-06-10 NVDA 200.42 USD' >> "$PRICES"

# then validate (separate invocations, as always):
hledger check accounts ordereddates commodities
hledger check balanced
```

If a check fails, restore the prices journal byte-exactly and report:

```bash
head -c "$BYTES_BEFORE" "$PRICES" > "$PRICES.tmp" && mv "$PRICES.tmp" "$PRICES"
```

Then rerun the valued report that triggered the refresh, and mention which
commodities (if any) are still stale because they failed or have no source.
If the journal directory is a git repo, commit `prices.journal` and push per
the **Git sync** policy in SKILL.md.

Note: `ordereddates` does not apply across files, and `P` directives are not
transactions - appending newest-last to `prices.journal` keeps it tidy, but a
re-fetch after a failed day landing slightly out of order is harmless.

## When a ticker breaks

Symptoms: the script warns `HTTP Error 404` / `No data found` for one
commodity, or refuses with a quote-currency mismatch. Companies get delisted,
merge, or restructure (e.g. Schaeffler: `SHA.DE` became `SHA0.DE` after their
2024 share restructuring).

1. Find the current ticker:
   ```bash
   curl -s -A 'Mozilla/5.0' \
     'https://query1.finance.yahoo.com/v1/finance/search?q=<company name>' \
     | jq -r '.quotes[] | "\(.symbol)\t\(.exchange)\t\(.longname)"'
   ```
2. Verify the candidate's quote currency by running the script once with a
   throwaway config, or just check that the fetched line's currency matches
   the holding.
3. Propose the corrected `[prices.sources]` entry and edit `finances.toml`
   after the user confirms.

If the whole API breaks (every ticker failing identically), say so plainly:
the endpoint is unofficial and can change. Prices can always be entered
manually in the meantime - one `P DATE COMMODITY PRICE CURRENCY` line per
quote, appended to `prices.journal` through the same review-confirm-validate
flow.
