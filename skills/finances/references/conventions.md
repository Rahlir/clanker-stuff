# Journal conventions for recording transactions

How to write a transaction that matches this journal's existing style and passes
validation. Read this before adding any entry. The authoritative chart of
accounts, tags, and commodities lives in `definitions.journal` (which the main
journal `include`s); query the live list with `hledger accounts`, `hledger tags`,
`hledger commodities`.

## Anatomy of a transaction

```
2024-03-05 ! DM Drogerie Markt
    Expenses:Drugstore      377.00 CZK
    Liabilities:ACard
```

- **Date** `YYYY-MM-DD`.
- **Status flag** after the date: this skill writes `!` (pending) for manually
  entered transactions, because they have not been reconciled against a bank
  statement yet. Imported/reconciled entries in this journal use `*` (cleared);
  do not use `*` for hand-entered ones.
- **Payee / description** follows the flag.
- **Postings** are indented 4 spaces: an account, then (optionally) an amount,
  separated by at least two spaces.

## The auto-balance rule (preferred posting style)

Give the amount on the category posting and leave the **funding posting blank**;
hledger infers it so the transaction balances exactly. This is the dominant style
in the journal:

```
2024-03-05 ! Albert
    Expenses:Food:Groceries      187.70 CZK
    Liabilities:MasterCard
```

Only one posting may be left blank. Every other posting needs an explicit amount.

## Funding account

Every entry needs a source: the account the money came from or went to (a
checking account, a credit card, cash, Revolut, etc.). You cannot infer which
card or account paid, so ask if it is not stated. Common sources here:
`Assets:Checking`, `Assets:Savings`, `Assets:Revolut`, `Liabilities:MasterCard`,
`Liabilities:ACard`.

## Accounts: declared-only

`hledger check accounts` is part of the validation gate, so every account used
must be declared in `definitions.journal`. If an entry needs an account that is
not declared:

1. Stop. Do not silently use it.
2. Propose the exact line to add, in the right section, e.g.:
   ```
   account Expenses:Hobbies
   ```
3. Add it only after the user confirms, then continue.

Pick the most specific existing account that fits (`Expenses:Food:Restaurants`,
not `Expenses:Food`, when the subcategory exists).

## Amounts and commodities

- Currency amounts: number, space, commodity, two decimals: `1234.50 CZK`. `CZK`
  is the base commodity; `USD` and `EUR` also occur.
- Securities are whole/fractional units: `1 VUG`, `4 SHA`.
- Negative for money leaving an asset / increasing a liability's paid-down side;
  positive the other way. With the auto-balance rule you usually only write the
  one signed category amount and let the funding posting balance.

## Tags and comments

Comments start with `;`. Tags live inside comments, two forms, both in use:

- Flag tag: `; :fixed:` (declared flag tags: `fixed`, `occasion`).
- Key/value tag: `; type: repeated` or `; occasion: vacation`.

Place a comment on its own indented line under the date or under a posting:

```
2024-03-06 ! MBank Joint Account
    ; :fixed:
    Assets:Checking          -7100.00 CZK
    Expenses:Joint Checking
```

Declared tags and the form to use for each:

| Tag | Form | Example |
|-----|------|---------|
| `fixed` | flag only | `; :fixed:` |
| `occasion` | flag or key/value | `; :occasion:` or `; occasion: vacation` |
| `type` | key/value only | `; type: repeated` |

Never write `; fixed: true` or similar; `fixed` is always the flag form. Use
these tags so the discretionary and occasion-aware reports keep working.

## Balance assertions

Optionally assert an account's running balance after a posting with `= BALANCE`:

```
    Liabilities:ACard      -377.00 CZK = -20562.56 CZK
```

Only add an assertion when the user gives a known post-transaction balance; a
wrong assertion fails validation. When unsure, omit it.

## Multi-commodity and investment entries (double-confirm)

These are error-prone; show the rendered entry and confirm the price notation
explicitly before writing.

- **Currency conversion / FX:** record the exchange with `@@` (total price) so it
  balances. Example (CZK to USD on Revolut):
  ```
  2024-01-02 ! Revolut
      ; Currency conversion with Revolut
      Assets:Revolut          -11600.00 CZK
      Assets:Revolut             516.34 USD @@ 11600.00 CZK
  ```
- **Buying a security:** the cash leg balances the units via `@` (unit price) or
  `@@` (total):
  ```
  2024-03-05 ! freedom24.com
      Assets:Broker                1 VUG @@ 339.34 USD
      Assets:Broker
  ```
- Do **not** add standalone `P` price directives to the main journal; fetched
  prices are appended to the dedicated prices journal through the flow in
  [prices.md](prices.md).

## Placement and ordering

- The journal is kept in **date order** (`hledger check ordereddates` is part of
  the gate). The check validates each file **independently**: this rule governs
  the hand-edited main journal, while imported entries land in per-source
  journal files that `hledger import` keeps ordered on its own (see
  [import.md](import.md), "Why per-source journals"). Insert a new entry
  immediately after the last *transaction* dated on or before its date. For an
  entry dated today (the common case) that means after the final transaction in
  the file.
- `P` price directives (and their `; Prices as of ...` headers) are interspersed
  through the file by date, not gathered in one trailing block. Skip over them
  when locating the insertion point, and never split or move a price block.
- Separate transactions with one blank line. Never reorder or edit existing
  entries.
- **Backdated entries are risky:** inserting into the past shifts the running
  balance of the touched accounts and can break a later `= BALANCE` assertion.
  The validation gate catches this. If it happens, do not force the entry: report
  the conflicting assertion and let the user decide.

## Validation gate

After inserting, the entry must pass **both** commands. Run `balanced` as its own
invocation: when combined with other check names, hledger's implicit
two-commodity cost inference can mask an unbalanced conversion, so a missing
`@@` would slip through.

```bash
hledger check accounts ordereddates commodities
hledger check balanced
```

If either fails, remove exactly the lines you added (surgical rollback) and
report what failed. Never leave an invalid or partial entry in the journal.
