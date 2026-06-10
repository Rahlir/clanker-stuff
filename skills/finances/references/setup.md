# Setup and adoption

Two entry paths into this skill, plus the baseline mechanics both share:

- **No journal at all** -> [Starting from zero](#starting-from-zero).
- **A journal already exists** but the skill has never been used with it ->
  [Adopting an existing journal](#adopting-an-existing-journal). Run that
  checklist before the first write; never apply the from-zero skeleton to an
  existing setup.

Everything here is propose-confirm: show the user each file or change before
writing it.

# Starting from zero

## 1. Create the journal

Pick (ask) a directory the user will keep finances in - ideally a git repo.
Create a main journal plus a definitions file it includes:

```
finances/
├── main.journal          # transactions; includes definitions.journal
├── definitions.journal   # account/commodity/tag declarations
└── finances.toml         # skill config (from assets/finances.example.toml)
```

`definitions.journal` skeleton - adapt accounts and currency to the user
(ask what they want to track; start small, accounts can be added any time):

```
account Assets
account Assets:Checking
account Assets:Cash

account Liabilities

account Equity
account Equity:Opening Balances
account Equity:Conversion

account Income
account Income:Salary

account Expenses
account Expenses:Food
account Expenses:Home
account Expenses:Transportation
account Expenses:Misc
account Income:Misc

commodity 1000.00 CZK
```

The `commodity` directive both declares the commodity and fixes its display
style. Declaring accounts up front is what makes `hledger check accounts`
(used by every write flow in this skill) effective.

`main.journal` starts as just:

```
include definitions.journal
```

## 2. Set LEDGER_FILE

Follow the SKILL.md prerequisites section: export `LEDGER_FILE` pointing at
`main.journal` in the shell profile, reload, verify with
`echo "$LEDGER_FILE"`.

## 3. Create finances.toml

Copy [assets/finances.example.toml](../assets/finances.example.toml) beside
the journal and adapt: base currency, commodities to monitor (none, for a
cash-only beginner), and later the `[import]` accounts.

## 4. Baselines

A baseline records what an account is worth at the moment tracking starts.
Used in three situations: brand-new journal, onboarding a new account into an
existing journal, and **re-baselining** an account after a tracking gap
(fresh start - the gap simply stays untracked).

One transaction per account, dated at the baseline date, using a balance
assignment (`= AMOUNT`) so hledger computes the adjustment:

```
2026-06-01 * Opening balance | Assets:Checking
    Assets:Checking          = 1053.49 CZK
    Equity:Opening Balances
```

- Take the amount from an authoritative source: a statement's opening
  balance, or the banking app on the baseline date. Liabilities are negative
  (`= -22555.02 CZK` for card debt).
- Choose the baseline date = the start of the first statement period that
  will be imported, so imports continue seamlessly from the baseline.
- For a re-baseline of an already-tracked account, the same form works: the
  assignment posts whatever difference accumulated during the gap to
  `Equity:Opening Balances`, and history before the gap stays intact.
- This is a journal write: it follows the full guarded flow from SKILL.md
  (render, confirm, validate with both check invocations, surgical rollback
  on failure).

## 5. Verify

```bash
hledger check accounts ordereddates commodities
hledger check balanced
hledger balancesheet
```

The balance sheet should show exactly the baselined amounts.

## 6. Next steps

- Record day-to-day transactions: SKILL.md "Recording a transaction".
- Connect bank exports: [import.md](import.md), "Onboarding a new account".

# Adopting an existing journal

Goal: learn the journal's own conventions and bring it to a state where the
write flows' validation gates can pass. Until step 2 is green, no write flow
(manual entry or import) may run against this journal.

## 1. Inventory - learn, don't assume

```bash
hledger files       # every included file; where do declarations live?
hledger stats       # size, date span, when the last transaction was
hledger accounts    # the chart of accounts as it actually is
hledger commodities
hledger tags
rg -l '^account ' $(hledger files)    # the declaration file(s)
```

Note the dominant currency, account naming style, tags in use, and where
`account`/`commodity` declarations live (possibly the main journal itself).
Every later write follows these existing conventions - the from-zero skeleton
above does not apply.

## 2. Health check and remediation

Run exactly the gates the write flows depend on:

```bash
hledger check accounts ordereddates commodities
hledger check balanced     # own invocation (see conventions.md)
```

If both pass, go to step 3. If not, remediate **with the user** first: a
pre-existing failure makes every write flow unusable (the post-write gate
would fail and the rollback would mis-blame the new entry). Typical failures
in old journals:

- **Undeclared accounts** (common in journals that never used declarations -
  this alone bricks `check accounts` permanently): build the list from actual
  usage with `hledger accounts --used`, present it, and let the user separate
  real accounts from typos - this is the best typo-catching moment the
  journal will ever get. Add the confirmed `account` lines to the
  declarations file.
- **Unbalanced multi-commodity conversions** (`check balanced` failing on old
  currency exchanges or security trades): propose adding total-cost notation
  (`@@`, see conventions.md) to the offending entries.
- **Out-of-order dates, undeclared commodities**: same pattern - minimal
  fix, shown, confirmed.

**Adoption remediation is the one sanctioned exception to "never edit
existing transactions"**, under strict conditions: every edit is shown as an
exact before/after diff and individually confirmed; edits must be minimal
(annotations like `@@`, declarations - not rewrites); and a key report
(e.g. `hledger bs` totals) is compared before and after remediation to prove
reported values did not change. Re-run both gates afterwards; the journal
must be green before continuing.

## 3. Derive finances.toml from the journal

Do not copy the example values blind - derive them: `base_currency` and
`default_value` from the dominant commodity, `[prices].commodities` from the
foreign currencies and securities actually held (balance sheet +
`hledger commodities`). Show the file before writing it.

## 4. Staleness

- **Last transaction long ago**: offer the choice between a re-baseline
  ([Baselines](#4-baselines) - fresh start, the gap stays untracked) and a
  full backlog import ([import.md](import.md)); explain the trade-off
  (effort vs. continuous history).
- **Old `P` price directives**: tell the user valued reports will carry the
  stale-price warning until prices are refreshed (manually, for now).

## 5. Legacy import assets

If the user already has hledger CSV rules files:

- **Adopt their category-slot orientation.** Read the fallback assignments in
  the existing rules: if legacy files put the category on `account1`, that
  choice is already made journal-wide - record it in the shared categories
  file's header comment (see import.md, Rules architecture). Do not introduce
  the opposite orientation alongside it.
- **Seed, don't fork:** an existing shared payee/categories rules file
  becomes the categories file - keep extending it rather than starting a new
  one.
- **Legacy preprocessing scripts** (encoding fixers, payee normalizers) are
  superseded by `clean-csv.py` plus rules-based normalization. Leave them in
  place untouched, but do not run them; their per-bank knowledge (header
  skip counts, field meanings) is worth mining when rebuilding rules files.
- Old rules may target an export format the bank no longer produces - verify
  against a fresh export before reuse (import.md, Format drift).
