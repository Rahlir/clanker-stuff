---
name: finances
description: Manage personal finances tracked in an hledger plain-text journal. Use when the user asks about spending, account balances, net worth, equity, cash flow, income vs expenses, savings rate, investment value or ROI, budget status, wants to search past transactions, record a new transaction, import bank statements (CSV or PDF), update market prices, or set up finance tracking from scratch. Produces reports and appends validated transactions and prices; never edits or deletes existing entries.
---

# Finances (hledger)

Answer questions about the user's money by running read-only `hledger` reports
against their plain-text journal. This skill turns a natural-language question
("how much did I spend on food last month", "what's my net worth", "show my
checking transactions") into the right `hledger` invocation, applies the user's
valuation defaults, and interprets the output.

## Scope

This skill **reads** the journal and **appends new transactions** to it -
manually recorded ones and bank-statement imports - nothing else.

- **Read** with: `balance`/`bal`, `balancesheet`/`bs`, `balancesheetequity`/`bse`,
  `incomestatement`/`is`, `cashflow`/`cf`, `register`/`reg`, `aregister`/`areg`,
  `roi`, `prices`, `print`, `accounts`, `payees`, `descriptions`, `commodities`,
  `tags`, `stats`, `activity`, `check`.
- **Write** to the journal only by appending: a single transaction through the
  guarded flow in [Recording a transaction](#recording-a-transaction), a
  batch appended by `hledger import` to the source's own included journal
  file through the guarded flow in
  [references/import.md](references/import.md), or fetched `P` price
  directives appended to the dedicated prices journal through the guarded
  flow in [references/prices.md](references/prices.md). Auxiliary writes
  permitted by those flows: confirmed `account` declarations, import
  staging/rules files, `.latest` dedup state, archive moves, the one-time
  prices-journal setup, and `finances.toml` edits the user confirms.

Never edit or delete existing transactions - the sole exception is **adoption
remediation** per [references/setup.md](references/setup.md), where each fix
is individually diffed and confirmed by the user. Never modify or delete
existing `P` price directives (older manual ones are interspersed through the
main journal by date; new ones are only ever appended to the prices journal),
and never run a subcommand that rewrites files.

## Prerequisites

Run these checks first. If something is missing, help the user set it up using
the sections below. Do not guess paths or invent data. Two special cases route
to [references/setup.md](references/setup.md):

- **No journal at all**: walk through "Starting from zero" - this skill can
  start someone from scratch.
- **A journal exists but this skill has never been used with it** (e.g. no
  `finances.toml` yet, or the first write is about to happen): run "Adopting
  an existing journal" first - inventory its conventions and verify the
  validation gates pass *before* the first write. Old journals often fail
  them for pre-existing reasons, which would brick every write flow.

```bash
which hledger            # the CLI must be installed
echo "$LEDGER_FILE"      # must point to the main journal
```

### If `hledger` is missing

Tell the user it is required and give install instructions for their OS; do not
install it yourself unless they explicitly ask.

- macOS: `brew install hledger`
- Debian/Ubuntu: `sudo apt install hledger`
- Arch: `sudo pacman -S hledger`
- Other: https://hledger.org/install.html

### If `LEDGER_FILE` is unset

`hledger` reads the journal from the `LEDGER_FILE` environment variable. Help the
user set it permanently:

1. Locate or choose their main journal (e.g. `~/finances/main.journal`). If they
   are unsure, look for `*.journal`, `*.ledger`, or `*.hledger` files and ask
   which is the top-level one (it usually `include`s the others).
2. Add this to their shell profile (`~/.bashrc`, `~/.zshrc`, or
   `~/.config/fish/config.fish` with `set -x`):
   ```bash
   export LEDGER_FILE="$HOME/path/to/main.journal"
   ```
3. Reload the shell (`source ~/.zshrc`) or open a new terminal, then re-run
   `echo "$LEDGER_FILE"` to confirm.

Until it is set you can pass the journal explicitly with
`hledger -f /path/to/main.journal ...`, but prefer fixing `LEDGER_FILE` so every
command works without `-f`.

### Skill config: `finances.toml`

Valuation and price-staleness defaults live in a `finances.toml` next to
`LEDGER_FILE`:

```bash
ls "$(dirname "$LEDGER_FILE")/finances.toml"
```

If present, read it (it is small, read it directly) for:

- `[valuation].base_currency` - the commodity to report values in (e.g. `CZK`).
- `[valuation].default_value` - the `--value` argument for valued reports
  (e.g. `end,CZK`).
- `[valuation].infer_market_prices` - whether to pass `--infer-market-prices`.
- `[prices].commodities` - the commodities to monitor in the stale-price guard.
- `[prices].stale_after_days` - the freshness threshold for that guard.
- `[prices.sources]` - per-commodity tickers for `scripts/update-prices.py`
  (may be a subset of `commodities`; the rest stay manually priced).

If it is absent, offer to create one from
[assets/finances.example.toml](assets/finances.example.toml): copy it beside
`LEDGER_FILE` and customize. If you cannot read it, fall back to reporting in the
journal's own commodities (no forced valuation) and say so.

## Answering a question

1. Pick the matching recipe from [references/reports.md](references/reports.md).
2. If the report expresses value across commodities (net worth, holdings,
   anything "in CZK/USD"), apply the valuation defaults from `finances.toml`
   (`--value`, `--infer-market-prices`) and run the **stale-price guard** first.
3. Run the command. No `-f` is needed; `LEDGER_FILE` is used automatically.
4. Interpret the numbers in plain language, and show the exact command you ran so
   the user can rerun or tweak it.

## Recording a transaction

Appending a transaction is the only write this skill performs (plus, when
needed, the confirmed `account` declaration in step 2). Follow every step;
the writing conventions live in [references/conventions.md](references/conventions.md).

1. **Gather the facts.** Date (default today), payee/description, amount and
   commodity (default base currency), the category account, and the **funding
   account** (which account or card the money came from or went to). If the
   funding account or category is unclear, ask; never guess which card paid.
2. **Use declared accounts only.** List them with `hledger accounts`. If a
   required account is not declared in `definitions.journal`, stop, propose the
   exact `account` line to add, and add it only after the user confirms.
3. **Render and confirm.** Show the full transaction in journal format and wait
   for explicit confirmation before writing. Manual entries are marked pending
   (`!`) until reconciled.
4. **Insert in date order:** immediately after the last transaction dated on or
   before the new entry's date (for a today-dated entry, after the final
   transaction). `P` price directives are interspersed by date; skip them and
   never split a price block. Never reorder existing entries.
5. **Validate** with both commands (run `balanced` on its own; see conventions):
   `hledger check accounts ordereddates commodities` then `hledger check balanced`.
6. **On any failure, remove exactly the lines you added** and report what broke.
   Never leave a partial or invalid entry.

For investment or multi-commodity entries (security purchases, currency
conversions), use the dedicated section in
[references/conventions.md](references/conventions.md) and double-confirm the
price notation.

## Importing bank statements

When the user wants to import bank exports (CSV or PDF), follow
[references/import.md](references/import.md) exactly. In brief: route the file
via `finances.toml`'s `[import]` config, stage it (mechanical cleanup for CSV;
extract-transcribe-verify for PDF, with mandatory count and sum gates),
preview through the account's rules file, resolve unknown payees with the user
and write them back as durable rules, then `hledger import --dry-run`, confirm,
import **into the source's own journal file** (never the main journal - see
"Why per-source journals" there), and run the validation gate. Imports are
deduplicated by `.latest` state files; imported entries are cleared (`*`),
manual ones pending (`!`).
Onboarding a new bank account or starting with no journal at all:
[references/import.md](references/import.md) and
[references/setup.md](references/setup.md).

## Updating market prices

When the user wants fresh prices (or accepts the stale-guard's offer), follow
[references/prices.md](references/prices.md) exactly. In brief: run
`scripts/update-prices.py` (read-only - it prints `P` directives for the
commodities mapped in `finances.toml`'s `[prices.sources]`), review the
quotes against the current newest prices (flag large jumps, drop same-date
duplicates), get explicit confirmation, append to the dedicated
`prices.journal`, and run the validation gate with byte-exact rollback on
failure. The one-time `prices.journal` setup also lives there.

## Stale-price guard

Market valuation (net worth, equity, holdings value, anything using
`--value=now/end/then` or `-X`/`-V`) is only as fresh as the latest `P` price
directives, which are maintained manually. Before such a report:

```bash
# Newest declared price per monitored commodity (prices print in date order):
for c in USD EUR VUG; do hledger prices cur:"$c" | tail -n 1; done
```

Use the commodity list from `finances.toml`'s `[prices].commodities` in the loop
(do not truncate the overall output instead: a sparse commodity's newest price
can be pushed out by other commodities' recent entries). Compare each
commodity's most recent price date against today. If any is older than `stale_after_days`, warn
the user that the valuation may be outdated, name the stale commodities and how
old each is. Then **offer to refresh them** via
[Updating market prices](#updating-market-prices) - offer, don't force, and
note that commodities without a `[prices.sources]` entry stay manual. Do not
block the report; just caveat it. Skip this guard entirely for reports in the
base commodity that need no conversion.

## Quick reference

`<CCY>` = `base_currency` from `finances.toml`. `<ACCT>` = an account regex.

| Intent | Command |
|--------|---------|
| Net worth (valued) | `hledger bs --value=end,<CCY> --infer-market-prices` |
| Net worth over time | `hledger bs -M --value=end,<CCY> --infer-market-prices` |
| Income vs expenses (monthly) | `hledger is -M` |
| Spending by category | `hledger bal ^Expenses -p "last month" -S` |
| Discretionary spend (excl. tagged) | `hledger bal ^Expenses -M -SA not:tag:occasion not:tag:fixed` |
| Top payees | `hledger bal ^Expenses --pivot payee -S -p "this year"` |
| Cash flow | `hledger cf -M` |
| One account's balance | `hledger bal <ACCT>` |
| One account's transactions | `hledger areg <ACCT> -p "this year"` |
| Find transactions | `hledger print desc:<PAYEE>` or `hledger reg desc:<PAYEE>` |
| Holdings market value | `hledger bal ^Assets:Broker --value=now,<CCY> --infer-market-prices` |
| Investment ROI | `hledger roi --inv ^Assets:Broker --pnl unrealized --value=then,<CCY> --infer-market-prices -e today` |
| Budget status | `hledger bal --budget -M` (needs periodic `~` txns in scope) |
| List accounts / payees / tags | `hledger accounts` / `hledger payees` / `hledger tags` |

Full recipes, flags, query language, and valuation details:
[references/reports.md](references/reports.md).
