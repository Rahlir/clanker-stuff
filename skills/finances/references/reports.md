# hledger reporting recipes

Read-only report recipes for the `finances` skill. Pick the closest one, adjust
the period/query, apply valuation defaults when values cross commodities, run it,
then explain the result.

Conventions used below:

- `LEDGER_FILE` is set, so no `-f` is needed.
- `<CCY>` = `base_currency` from `finances.toml` (e.g. `CZK`).
- `<ACCT>` = an account name or regex (hledger account queries are regexes,
  anchored with `^` for "starts with").
- Commands use long flags on first mention and short aliases afterwards.

---

## 1. Net worth & balance sheet

Net worth = Assets - Liabilities. Because it sums many commodities (cash,
foreign currency, securities), always value it. Run the **stale-price guard**
first (see SKILL.md).

```bash
# Net worth right now, everything converted to one currency
hledger balancesheet --value=end,<CCY> --infer-market-prices

# Net worth trend (also -Q quarterly, -Y yearly)
hledger bs -M --value=end,<CCY> --infer-market-prices

# Include the Equity section explicitly (opening balances, retained earnings)
hledger balancesheetequity --value=end,<CCY> --infer-market-prices
```

Useful knobs: `--depth 2` to roll up sub-accounts; `-T` row totals, `-A`
averages, `-S` sort by amount; `-H/--historical` to carry balances forward from
before the report period (important when you start a balance sheet mid-history).

```bash
# What is in a whole top-level area, summarized two levels deep
hledger bs --depth 2 --value=end,<CCY> --infer-market-prices
```

## 2. Income & expenses

The income statement = Revenues - Expenses for a period (a *flow*, unlike the
balance sheet which is a *stock*).

```bash
hledger incomestatement -M                 # monthly income vs expenses, with net
hledger is -Y                              # yearly
hledger is -M -A -T                        # add per-row average and total columns
hledger is -p "this year" --depth 2        # this year, rolled up
```

Savings rate is the income-statement "net" divided by income; read both from the
report, or compute spending-vs-income directly:

```bash
hledger bal ^Income ^Expenses -p "this year"   # totals to eyeball the gap
```

## 3. Cash flow

Cash flow shows money moving in and out of liquid (cash) accounts, ignoring
non-cash bookkeeping.

```bash
hledger cashflow -M                        # monthly cash in/out
hledger cf -p "last quarter"
```

## 4. Spending analysis

The workhorse for "where does my money go".

```bash
# Spending by category last month, biggest first
hledger bal ^Expenses -p "last month" -S

# Monthly spend per category, sorted by average (the discretionary view)
hledger bal ^Expenses -M -SA

# Same, excluding one-off / fixed items via tags
hledger bal ^Expenses -M -SA not:tag:occasion not:tag:fixed

# Roll everything up to top-level categories only
hledger bal ^Expenses -p "this year" --depth 2 -S

# Each category as a percentage of total spend
hledger bal ^Expenses -p "this year" -S -%

# Top payees instead of categories (pivot by the payee field)
hledger bal ^Expenses --pivot payee -S -p "this year"

# Pivot by a tag (e.g. spend grouped by the `occasion` tag)
hledger bal ^Expenses --pivot occasion -S

# Cumulative spend across the year (running total)
hledger bal ^Expenses -M --cumulative
```

Drill into a single category:

```bash
hledger bal ^Expenses:Food -M -S          # food sub-categories over time
hledger areg ^Expenses:Food:Restaurants   # every restaurant posting, running total
```

## 5. Transactions & account registers (search)

`register` is a posting-level ledger; `aregister` shows one account with a
running balance; `print` shows whole transactions in journal format.

```bash
# A single account's activity with running balance
hledger areg Assets:Checking -p "this year"

# All postings matching a payee, with running total
hledger reg desc:Albert -p "last month"

# Full transactions (journal format) for a payee or note
hledger print desc:Albert
hledger print payee:"Trader Joe"

# Postings in a category over a window
hledger reg ^Expenses:Food -p "2024-01 to 2024-04"

# Large transactions only (absolute amount >= 1000 in <CCY>)
hledger reg "cur:<CCY>" "amt:>=1000" -p "this year"

# Anything tagged for a trip/occasion
hledger print tag:occasion=vacation
```

See the query cheat sheet below for the full matcher syntax.

## 6. Investments & equity valuation

Securities are commodities priced via `P` directives. Distinguish three numbers:
units held, cost basis, and current market value.

```bash
# Units held per security (e.g. "10 VUG, 5 NVDA")
hledger bal ^Assets:Broker --no-total

# Cost basis (what you paid)
hledger bal ^Assets:Broker --cost

# Current market value (run the stale-price guard first)
hledger bal ^Assets:Broker --value=now,<CCY> --infer-market-prices

# Unrealized gain = market value - cost
hledger bal ^Assets:Broker --gain --infer-market-prices

# How holdings value changed over the period
hledger bal ^Assets:Broker -M --valuechange --infer-market-prices
```

Return on investment (IRR and time-weighted return). `--inv` selects the
investment account(s); `--pnl` selects where gains/losses are booked. `roi` must
reduce every holding to one commodity, so always pass a single-commodity
`--value=...,<CCY>` (or `-X <CCY>`) together with `--infer-market-prices`.

```bash
# Overall return, all holdings valued into one currency
hledger roi --inv ^Assets:Broker --pnl unrealized --value=then,<CCY> --infer-market-prices -e today

# Broken down by year (only works if prices exist in every period; see note)
hledger roi --inv ^Assets:Broker --pnl unrealized --value=then,<CCY> --infer-market-prices -e today -Y
```

Gotchas:

- Always pass `-e today`: without it the report period ends at the last
  transaction date, so all market movement since then is ignored. It is also
  required when your latest `P` price is dated after your last transaction
  (otherwise the end value cannot be priced).
- If hledger errors `Period ... has multiple commodities`, it lacks prices to
  convert some holding into `<CCY>` for that period. Fix by valuing into the
  currency the securities are actually quoted in (often `USD`), narrowing the
  period, or adding the missing `P` directives. Period subdivision (`-Y`/`-Q`)
  is the most likely to hit this when price history is sparse.

Inspect the price database itself:

```bash
hledger prices                              # explicit P directives
hledger prices --infer-market-prices        # plus prices inferred from trades
```

## 7. Budget

Compares actuals against periodic budget transactions (`~` entries). The
periodic transactions must be in scope: if they live in a separate file that the
main journal does not `include`, add it with an extra `-f`.

```bash
# Actual vs budget per category, this period
hledger bal --budget -M ^Expenses

# When budgets are in a separate file beside LEDGER_FILE
hledger bal --budget -M ^Expenses \
  -f "$LEDGER_FILE" -f "$(dirname "$LEDGER_FILE")/budget.journal"

# Show only categories that have a budget (hide unbudgeted noise)
hledger bal --budget --cumulative -p "this month" --depth 2
```

## 8. Forecast

Projects future balances/postings from periodic (`~`) transactions. Same
file-scope caveat as budgets.

```bash
# Project balances forward six months
hledger bal --forecast -M -e "+6 months"

# Forecast a specific account's trajectory
hledger areg Assets:Checking --forecast -e "+6 months"
```

## 9. Journal metadata & integrity

Quick structural questions and a health check (all read-only).

```bash
hledger accounts                  # all account names (add --tree for hierarchy)
hledger accounts ^Expenses        # accounts under a branch
hledger payees                    # distinct payees
hledger descriptions              # distinct descriptions
hledger commodities               # commodities/currencies in use
hledger tags                      # tag names (add a tag name for its values)
hledger stats                     # journal size, span, counts
hledger activity -M               # posting-frequency bar chart over time

# Validate the journal before trusting reports (does not modify anything).
# Run `balanced` as its OWN invocation: combined with other check names,
# hledger's implicit two-commodity cost inference can mask an unbalanced
# conversion (verified on hledger 1.52).
hledger check accounts ordereddates commodities
hledger check balanced
```

---

## Cheat sheet: period & date selection

| Want | Flag |
|------|------|
| Daily / weekly / monthly / quarterly / yearly columns | `-D` / `-W` / `-M` / `-Q` / `-Y` |
| A named period | `-p "this month"`, `-p "last quarter"`, `-p "this year"` |
| A literal period | `-p 2024`, `-p 2024-03`, `-p 2024Q1` |
| An explicit range | `-p "2024-01-01 to 2024-04-01"` (end is exclusive) |
| Start / end only | `-b 2024-01-01` / `-e 2024-04-01` |
| Smart dates | `today`, `yesterday`, `last week`, `this month`, relative `+6 months` |

`date:` as a query term does the same filtering inside a larger query, e.g.
`hledger reg ^Expenses date:"last month"`.

## Cheat sheet: query language

Terms combine as: **same type OR'd, different types AND'd**, and any term can be
negated with `not:`.

| Term | Matches |
|------|---------|
| `acct:REGEX` (or a bare regex) | account name; `^` anchors the start |
| `desc:REGEX` | transaction description |
| `payee:REGEX` / `note:REGEX` | payee / note halves of the description |
| `tag:NAME` or `tag:NAME=VALUE` | a tag, optionally with a value |
| `cur:REGEX` | commodity/currency |
| `amt:>N` `amt:<N` `amt:>=N` `amt:=N` | amount (use with `cur:` for clarity) |
| `date:PERIOD` | posting date in a period |
| `status:*` / `status:!` / `status:` | cleared / pending / unmarked |
| `depth:N` | limit account depth |
| `type:A` `type:L` `type:E` `type:R` `type:X` | account type (Asset, Liability, Equity, Revenue, eXpense) |

Examples:

```bash
hledger reg acct:Food acct:Car             # Food OR Car postings
hledger reg ^Expenses desc:albert          # Expenses AND description ~ albert
hledger reg ^Expenses not:tag:fixed        # Expenses, excluding fixed-tagged
```

## Cheat sheet: valuation

| Goal | Flag |
|------|------|
| Cost basis (what you paid) | `--cost` (alias `-B`) |
| Value at period-end prices | `--value=end[,CCY]` (alias `-V`) |
| Value at today's latest prices | `--value=now[,CCY]` |
| Value at each posting's date | `--value=then[,CCY]` |
| Value at a specific date | `--value=YYYY-MM-DD[,CCY]` |
| Convert everything to one commodity | `-X CCY` |
| Use prices implied by transactions too | `--infer-market-prices` |
| Show change in value over the period | `--valuechange` |
| Show unrealized gain (value - cost) | `--gain` |

Without `--infer-market-prices`, only explicit `P` directives are used for
conversion. Run the stale-price guard before any valued report.

## Cheat sheet: display & output

| Goal | Flag |
|------|------|
| Tree vs flat account layout | `--tree` / `--flat` |
| Limit account depth | `--depth N` |
| Row totals / averages | `-T` / `-A` |
| Sort by amount (then average) | `-S` / `-SA` |
| Show as percentages | `-%` |
| Running / cumulative totals | `-H` (historical) / `--cumulative` |
| Multi-commodity layout | `--layout=wide|tall|bare|tidy` |
| Pretty box-drawing tables | `--pretty` |
| Machine-readable output | `-O csv` / `-O json` / `-O tsv` |
