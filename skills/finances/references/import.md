# Importing bank statements

Protocol for getting bank exports (CSV or PDF) into the journal. Every source
funnels into the same shape: a **staging CSV** parsed by a per-account
**rules file**, deduplicated and appended by **`hledger import`** to the
source's **own journal file**, then validated and reconciled.

```
raw export (inbox)
  1. route       match the file to an account        ([import.accounts.*])
  2. stage       CSV: clean-csv.py  |  PDF: pdftotext + transcribe + verify
  3. preview     hledger -f <staging>/<name>.csv print  (via its .rules)
  4. categorize  fallback-account loop -> durable rules
  5. import      dry-run -> user confirms -> hledger import into the
                 source's own journal -> validation gate
  6. reconcile   staged totals vs statement balances (hard gate on a
                 source's first import; report-only afterwards)
  7. archive     raw file -> archive/YYYY-MM/
```

Write surface of this workflow: staging CSVs, rules files, `.latest.*` state
files, archive moves, appends made by `hledger import` to per-source journal
files, and the one-time confirmed `include` lines that connect those files.
The rules from SKILL.md still hold: never edit or delete existing journal
entries, and every journal write is followed by the validation gate.

## Configuration

The `[import]` section of `finances.toml` (see
[assets/finances.example.toml](../assets/finances.example.toml)). Relative
paths resolve against the directory of `LEDGER_FILE`.

| Key | Meaning |
|-----|---------|
| `inbox` | where the user drops raw downloads |
| `staging` | where staging CSVs + rules files live |
| `archive` | where raw files go after a successful import |
| `journals` | directory of per-source import journals (`<journals>/<name>.journal`) |
| `fallback_accounts` | reserved sentinel accounts (e.g. `Expenses:Unknown`) that mark a payee as "unknown"; no rule may assign them deliberately |
| `accounts.<name>.match` | regex tried against the raw filename and its first lines/page; routes the file |
| `accounts.<name>.account` | the journal account this source feeds |
| `accounts.<name>.format` | `csv`, `pdf-statement` (has balances), or `pdf-listing` (no balances) |
| `accounts.<name>.encoding` | optional source encoding for `clean-csv.py` |
| `accounts.<name>.decimal_comma` | optional, `true` when the export uses comma decimals and the journal style is dot-based: stage with `--decimal-comma` (see the decimal-mark invariant in Step 2) |

`<name>` doubles as the staging filename: staging is `<staging>/<name>.csv`,
rules `<staging>/<name>.csv.rules`, dedup state
`<staging>/.latest.<name>.csv`, and the import target
`<journals>/<name>.journal`.

### Why per-source journals

Imports never append to the main journal. Each source feeds its own journal
file, included from the main one (created at
[onboarding](#onboarding-a-new-account)). The reason is the validation gate:
`hledger check ordereddates` validates date order **within each file
independently**. Statements from different sources overlap in time, so
appending them all to one file breaks date order as soon as a second source
(or a manual entry dated after the batch) exists. With per-source files,
the hand-edited main journal stays hand-ordered, and each source file stays
ordered on its own: `hledger import` date-sorts every batch it appends, and
successive statements from one source are chronological. Within one source,
process catch-up statements **oldest-first** (stage and import one statement
at a time).

## Rules architecture

Rules files are layered with `include` so that shared knowledge lives in
exactly one place:

```
<name>.csv.rules          per ACCOUNT - thin: bank-account binding, account-
  └─ include <bank>.rules     specific overrides, include lines
       └─ include categories.rules
                          per BANK FORMAT - skip/separator/fields/date-format/
                            decimal-mark, fallback assignments
                          SHARED payee knowledge - description + category
                            blocks, used by every account at every bank
```

- **Per-account files stay thin**: the bank-account binding (e.g.
  `account1 Assets:Checking`), account-specific `if` overrides (e.g. routing
  a card-repayment transfer), and the `include`. Overrides go *after* the
  `include` line - later matching blocks win.
- **The per-bank layer** is only worth splitting out once a second account
  shares the same export format; until then its content can sit in the
  account file directly.
- **The shared categories file** (conventionally `categories.rules`) is the
  **only file the categorization loop ever writes**. Payee patterns match the
  whole CSV record case-insensitively, so one block covers the same merchant
  across different banks' formats. Before asking the user about an unknown
  payee, this is also where to look first - it may already be answered there
  from another account's imports.
- **One orientation, journal-wide**: every account/bank layer must put the
  category side on the **same `accountN` slot** (the slot the fallback
  assignments use), otherwise shared category blocks would invert
  transactions for some accounts. Record the chosen slot in a comment at the
  top of the categories file and verify new rules files against it at
  onboarding.

## Step 1 - Route

List the inbox; for each file, test every account's `match` against the
filename and the file's head (`head`/first PDF page). Exactly one match routes
the file. Zero or multiple matches: ask the user, never guess. If the source is
new, run [Onboarding a new account](#onboarding-a-new-account) first.

Multi-currency fintechs (e.g. Revolut) export **one file per currency
account**; treat each currency as its own `[import.accounts.*]` entry. If you
cannot tell from the file which currency it is, ask.

## Step 2 - Stage

### CSV inlet

```bash
# $SKILL = the skill root: the directory containing this skill's SKILL.md
# (the directory you loaded this reference file from).
"$SKILL/scripts/clean-csv.py" inbox/raw.csv -o <staging>/<name>.csv
```

The script only fixes encoding (auto-detect, or `--encoding` from config),
line endings, and runs of spaces. Already-clean exports pass through
unchanged.

**Decimal-mark invariant.** `hledger import` copies amounts into the journal
in the decimal style of the staging CSV, so the decimal mark that reaches the
journal **must match the journal's `commodity` directives**. A mismatch
corrupts silently: with `commodity 1000.00 CZK`, an imported `99763,4` is
re-read as `997634` (the comma becomes a digit-group mark), **every
`hledger check` gate still passes**, and only reconciliation (step 6)
catches it. Two valid configurations - never mix them for one source:

- **Dot-style journal, comma-decimal export**: set `decimal_comma = true`
  for the account and stage with
  `clean-csv.py ... --decimal-comma --separator ';'` (converts only purely
  numeric fields; refuses a comma separator). Do **not** declare
  `decimal-mark ,` in the rules - the staged file now uses dots.
- **Comma-style journal**: stage numbers as-is and declare `decimal-mark ,`
  in the rules file.

The canonical PDF staging format below always uses dot decimals (commas are
the field separator), so with a comma-style journal the same invariant bites
in reverse on PDF imports - raise it with the user before the first one
rather than importing dot amounts into a comma journal.

Treat it as a black box - there is no need to read its source. Its full
contract: the input file is never modified; only the `-o` path is written
(parent directories created as needed); the detected source encoding is
reported on stderr; exit is nonzero on a missing input file. It does nothing
semantic, so if staged numbers or fields look wrong, the problem is in the
raw export or the rules file, not in this script.

### PDF inlet

The agent transcribes; deterministic gates make that safe.

1. **Extract:** `pdftotext -layout file.pdf file.txt` (chunk big files with
   `-f`/`-l`). If there is no text layer (scanned), fall back to
   `pdftoppm -png` and read the page images.
2. **Transcribe** every transaction block into the canonical staging CSV:

   ```csv
   date,id,description,amount,ccy
   2026-06-08,ec64f73eaaf36012721c5bfbed131441,Gemuse Corner Kebab,-260.00,CZK
   ```

   - `date` = the **posting date** (what the account balance follows), ISO
     format. A separate transaction date can be kept as a secondary date in
     the rules (`date2`) if the rules file maps it.
   - `id` = the statement's transaction/payment ID; it lands in the journal
     as a comment tag (audit trail + exact-match dedup backstop).
   - `amount` = the booked amount with a **dot** decimal mark (see the
     decimal-mark invariant above; the sum-gate `awk` also requires dots).
   - Re-join wrapped lines (IDs and payees often break across lines); pick the
     most meaningful payee text for `description`; note original-currency
     amounts and FX rates in the description or drop them - the booked amount
     is what matters.
   - **No commas inside field values** - replace them with spaces when
     transcribing. The staging CSV must stay naively comma-splittable so the
     sum-gate `awk` below reads the right column.
3. **Verify - never skip, never proceed on mismatch:**
   - **Count gate.** Transaction blocks start with a date at line start:
     `rg -c '^\s*\d{1,2}\.\d{1,2}\.\d{4}\s' file.txt` must equal staged rows
     (`tail -n +2 staging.csv | wc -l`). Adjust the date regex to the
     statement's locale once, at onboarding.
   - **Sum gate.** Booked amounts sit at the end of those date lines and are
     mechanically extractable, e.g. for `-1 234,56 Kč` style:
     `rg -o '\-?[\d ]+,\d{2}(?= Kč$)' ...` (mind space thousands separators).
     Their total must equal the staged `amount` sum
     (`awk -F, 'NR>1{s+=$4} END{printf "%.2f\n", s}' staging.csv`).
     Compare pairwise when the totals disagree to find the bad row.
   - **Statement arithmetic** (`pdf-statement` format only): extract opening
     balance, closing balance, and any drawn/repaid totals from the summary
     block; check `closing = opening + sum(staged amounts)` (mind the sign
     convention for liability/card accounts). Record opening/closing for
     step 6.

   A failed gate means a transcription error: fix the staging row(s) and
   re-verify. Count+sum passing means amounts and dates are faithful; only
   description text rests on transcription alone, where an error is cosmetic.

## Step 3 - Preview

```bash
hledger -f <staging>/<name>.csv print | head -40   # eyeball first txns
hledger -f <staging>/<name>.csv stats              # txn count, date span
```

Errors here mean the rules file no longer fits the export - see
[Format drift](#troubleshooting-format-drift).

## Step 4 - Categorize unknowns (the learning loop)

Unknown payees fall through to the fallback accounts. List them:

```bash
hledger -f <staging>/<name>.csv reg <FALLBACK_1> <FALLBACK_2>
```

where `<FALLBACK_n>` are the entries of `fallback_accounts` in
`finances.toml` - substitute them, do not query literal accounts from this
example. Space-separated account queries OR together; avoid hand-building
`expr:'acct:... or ...'` strings here - a malformed variant silently matches
nothing, which reads as a false "zero unknowns".

**Fallback accounts are reserved sentinels.** No rule - in any rules file -
may assign a fallback account deliberately; they exist only as the
landing zone for unmatched records, so that "posts to a fallback account"
means exactly "unknown payee". If the user wants a genuine miscellaneous
category, use a separate declared account (e.g. `Expenses:Misc`) distinct
from the sentinels (e.g. `Expenses:Unknown`). When a rule assigning a
fallback account turns up anyway (legacy rules, earlier sessions), propose
moving it to a real category before continuing - otherwise this loop cannot
tell intentional from unmatched.

Group the unknowns by payee, then propose for the
whole batch at once: a clean display name + a category account. **Use declared
accounts only** (`hledger accounts`); a missing account follows the same
propose-confirm-declare flow as in SKILL.md step 2. The user confirms or
corrects the batch.

Write each confirmed payee as a durable block in the **shared categories
file - the single write target of this loop** (see
[Rules architecture](#rules-architecture)); never write payee blocks into
per-account or per-bank files:

```
if RAW PAYEE PATTERN
    description Clean Name
    account2 Expenses:Food:Groceries
```

Notes on these blocks:

- `if`-block assignments override top-level ones, so `description` here
  replaces the raw CSV text - this is the normalization mechanism.
- The pattern is a case-insensitive regex matched against the whole CSV
  record; keep it tight enough not to catch other payees.
- The block must use the journal-wide category slot (the `accountN` the
  fallback assignments use - see the orientation invariant in
  [Rules architecture](#rules-architecture)). The example assumes
  `account2` = category. Using the wrong slot replaces the bank posting
  instead of the category and inverts the transaction.
- True one-offs get an exact-match rule keyed on the transaction ID rather
  than a broad payee pattern.
- If the user wants the same payee categorized **differently for one specific
  account**, keep the general block in the categories file and add an
  override block in that account's own rules file, after its `include` line.
  This is the one exception to the single-write-target rule, and only on the
  user's explicit say-so.

Re-run the preview until nothing lands in a fallback account, or the user
explicitly accepts the remainder as unknown (the entries then carry the
sentinel account into the journal; they can be recategorized later).

## Step 5 - Import

```bash
# every import targets the source's own journal, never the main file:
TARGET="<journals>/<name>.journal"

# 0. rollback bookkeeping (import only ever appends, so a byte count is exact):
BYTES_BEFORE=$(wc -c < "$TARGET")
LATEST="<staging>/.latest.<name>.csv"        # full path: it lives beside the CSV
[ -f "$LATEST" ] && cp "$LATEST" "$LATEST.bak"   # absent on a first import - that's fine

# 1. preview exactly what would be appended:
hledger import -f "$TARGET" <staging>/<name>.csv --dry-run
```

Summarize the dry-run for the user - transaction count, date span, total per
account - and get **explicit confirmation**. Then:

```bash
hledger import -f "$TARGET" <staging>/<name>.csv
# gates run on the FULL journal (no -f, so $LEDGER_FILE): the new entries
# must hold up in the context of every included file, not just their own.
hledger check accounts ordereddates commodities   # gate part 1
hledger check balanced                            # gate part 2 (own invocation)
rm -f "$LATEST.bak"                               # gates passed: drop the backup
```

**On any gate failure**, roll back exactly and report what broke:

```bash
# byte-exact truncation back to the pre-import state:
head -c "$BYTES_BEFORE" "$TARGET" > "$TARGET.tmp" && mv "$TARGET.tmp" "$TARGET"
# dedup state: restore the backup, or remove the .latest a first import created:
if [ -f "$LATEST.bak" ]; then mv "$LATEST.bak" "$LATEST"; else rm -f "$LATEST"; fi
```

Never leave the journal failing a check that passed before the import, and
never leave `.latest` pointing past transactions that were rolled back.

First import for an account (no `.latest` yet): the CSV may overlap history
already in the journal. Preferred: stage only from the baseline/onboarding
date forward. If the export cannot be date-limited,
`hledger import -f "$TARGET" <staging>/<name>.csv --catchup` marks everything
as seen (imports nothing) - then later exports import only newer
transactions.

## Step 6 - Reconcile

On a source's **first import this step is a hard gate, not a report**: it is
the only check that catches silent amount corruption (a decimal-mark
mismatch passes every `hledger check`). On a first-import mismatch, roll
back exactly as in step 5, find the cause, and re-import; do not keep the
batch. On subsequent imports it is report-only.

Compare the journal against the statement's own totals:

```bash
hledger bal <account> -e <day after statement end>
```

Mind the sign convention: hledger shows liability balances negative, while
card statements quote the debt as a positive number - compare magnitudes
(journal `-22555.02 CZK` matches statement `22 555,02`), and do not report a
false mismatch over the sign.

- CSV with header balances (e.g. `Pocatecni/Konecny zustatek`): journal
  balance at period end should equal the closing balance.
- `pdf-statement`: use the opening/closing captured in step 2.
- Per-row balance columns (e.g. Revolut `Balance`): last row of each currency
  is that currency's closing balance.
- `pdf-listing` exports carry no balances: say so and skip this step.

Report match or mismatch with the amounts. A mismatch usually means missing
history (a gap), a duplicate, an unimported sibling export, or - especially
on a first import - corrupted amounts from a decimal-mark mismatch (compare
a few journal entries against raw export rows to rule it out). Investigate
with the user; do not "fix" numbers to force agreement.

## Step 7 - Archive

```bash
mkdir -p <archive>/YYYY-MM && mv inbox/<raw file> <archive>/YYYY-MM/
```

Use the statement period's year-month. Staging files may be overwritten by the
next import; `.latest.*` files must stay where they are.

## Onboarding a new account

Needed once per new source (new bank account, card, or fintech currency).

1. **Declare the journal account** if new (propose-confirm flow from SKILL.md).
2. **Add the `[import.accounts.<name>]` entry** to `finances.toml`: `match`,
   `account`, `format`, `encoding` if needed.
3. **Create the source's journal file and include it** (same pattern as the
   prices journal; show both writes and get confirmation first). The relative
   `include` path resolves against the including file:

   ```bash
   mkdir -p <journals>
   printf '; %s imports. Append-only; written by hledger import.\n' '<name>' \
     > <journals>/<name>.journal
   printf '\ninclude <journals>/<name>.journal\n' >> "$LEDGER_FILE"
   ```

   Verify: `hledger files` must list the new file, then run the gate -

   ```bash
   hledger check accounts ordereddates commodities
   hledger check balanced
   ```
4. **Author the rules file** `<staging>/<name>.csv.rules` interactively:
   get a real export, stage it, then iterate: propose a skeleton -> preview
   with `hledger -f <staging>/<name>.csv print` -> fix -> repeat. Respect the
   [rules architecture](#rules-architecture): include the shared categories
   file (directly, or via a per-bank base); if another account already uses
   the same bank's format, factor the format directives into a shared
   per-bank file instead of duplicating them; match the journal-wide category
   slot orientation.
5. **Baseline.** Unless the journal already tracks this account up to the
   first import date, record an opening-balance transaction first (see
   [setup.md](setup.md), "Baselines"), dated at the start of the first
   statement period, using the statement's opening balance.
6. Run the first import with the overlap handling from step 5 of the import
   protocol.

### Rules-authoring gotchas (each one verified the hard way)

- **Magic field names.** In `fields ...`, the names `date`, `date2`, `status`,
  `code`, `description`, `comment`, `account1..N`, `amount`/`amountN`,
  `currency`, `balance`/`balanceN` are *assignments*, not labels: naming a
  column `currency` prepends it to every amount; `balance` generates balance
  assertions. Name pass-through columns `ccy`, `bal_raw`, `amount_raw`, etc.,
  and assign explicitly (`amount1 %amount_raw %ccy`).
- **Decimal commas:** the journal's commodity style decides - see the
  decimal-mark invariant in Step 2. `decimal-mark ,` (which also handles
  space thousands separators like "1 000,50") is only correct when the
  journal itself uses comma decimals; for a dot-style journal, convert at
  staging instead.
- **A `date` field must exist** (or `date %N`), in `date-format` matching the
  export (`%d.%m.%Y`, `%Y-%m-%d %H:%M:%S`, ...).
- **Skipping records:** `skip` inside an `if` block drops matching records
  (e.g. `if %state PENDING` -> `skip`). There is no reliable negated matcher -
  enumerate the states to skip, and ask the user what states exist.
- **Paired exchange rows** (one row per side, e.g. Revolut `Exchanged to USD`
  at -800 CZK and its +USD sibling): post each side against
  `Equity:Conversion` (declare it once). Posting them against the asset
  account itself silently self-cancels and corrupts holdings. When all
  per-currency exports are imported, `Equity:Conversion` holds the conversion
  residue, analogous to manual `@@` entries.
- **Separate fee columns** (Revolut: `Amount` *excludes* `Fee`; the balance
  change is `Amount - Fee`): add a fee posting pair -

  ```
  if %fee [1-9]
      account3 Expenses:Bank Fees
      amount3 %fee %ccy
      account4 Assets:Revolut
      amount4 -%fee %ccy
  ```

  Verify against the export's balance column afterwards.
- **Per-currency exports:** one staging file + rules + `.latest` per currency;
  never merge them into one CSV.

## Troubleshooting format drift

Banks change export formats without notice. Symptoms: rules parse errors,
wrong field contents in the preview, a count/sum gate failing on a PDF whose
layout changed.

1. Diff the new export's header and first records against what the rules
   expect (`skip` count, field order, separator, date format).
2. Show the user what changed; update the rules file (or the PDF
   transcription approach) accordingly; re-run preview + gates.
3. Never silently "make it parse": a drifted format can shuffle field
   meanings while staying parseable. Confirm a few transactions against the
   raw export before importing.
