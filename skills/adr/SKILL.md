---
name: adr
description: Author architecture decision records (ADRs) that humans will actually read and agents can reliably act on. Use when the user asks to write, draft, propose, supersede, deprecate, or revise an ADR, or when another instruction routes an artifact to an ADR directory. This skill defines the template, the status lifecycle, the index conventions, and the writing rules. It does NOT decide where the ADR file lives - that belongs to the repo's own conventions.
---

# ADR Authoring

You are writing an **architecture decision record**. An ADR captures a
single decision: the problem, the options considered, the choice, and what
follows from it. The audience is **future developers** (yours and the rest
of the team) and **future agents**. The single most common failure mode is
producing something so long that humans skim past it. Treat brevity as a
correctness property, not a style preference.

## What an ADR is - and isn't

An ADR **is**:

- A record of a decision and the alternatives that were on the table.
- Short. A reader should be able to absorb it in a few minutes.
- Stable. Once accepted, you do not rewrite it; you supersede it.

An ADR is **not**:

- A design document. Designs explore "how"; ADRs commit to "what" and "why".
- A migration plan. Plans, tickets, and rollout steps live elsewhere.
- A tutorial. Onboarding material belongs in `README.md` or a docs site.
- A status report. The `status` field already conveys that.
- A code sample dump. Link to a reference implementation instead.

If during writing the document grows past roughly 1500 rendered words, or
acquires headers like "Migration Status", "File Organization", "Before /
After", **stop**. That content belongs in a sibling design doc, a planning
artifact, or a ticket. Link to it from the ADR.

## When to write an ADR

Write one when **all three** are true:

1. The decision is **architectural**: it constrains how other code is written, not just this one feature.
2. The decision is **non-obvious**: a competent reader would reasonably reach for a different option, so the rationale needs to be on the record.
3. The decision is **stable**: you intend it to hold until explicitly superseded, not "until we get a chance to revisit".

Things that are **not** ADR-worthy: library version bumps, one-off tactical
fixes, naming preferences, decisions that bind a single file. If in doubt,
ask the user before opening a new ADR; the cost of a misplaced ADR is high
because they accumulate and get referenced.

## Where the ADR lives

This skill does **not** decide path. Resolve the destination in this order:

1. The user's explicit instruction.
2. An existing ADR directory in the repo (commonly `docs/adr/`, `docs/architecture/decisions/`, or `adr/`).
3. The convention documented in the repo's `README.md`, `CONTRIBUTING.md`, or agent-instruction file (e.g. `AGENTS.md`, `CLAUDE.md`).

If none of the above resolves the path, **stop and ask**. Do not invent a
location.

## File naming and numbering

- Pattern: `NNNN-kebab-case-title.md`, e.g. `0007-vue-query-server-state.md`.
- Number is **four digits**, zero-padded, monotonically increasing within
  the ADR directory. Look at existing files to pick the next number.
- Use `max(existing) + 1`. **Numbers are never reused**, even if a previous
  ADR was deleted (which itself is a bad practice - prefer superseding).
- The title in the filename mirrors the H1 title, minus the `ADR-NNNN:`
  prefix and any punctuation, lowercased and kebab-cased.
- Exception: if a repo already uses a different padding (e.g. 3-digit), match
  the existing convention. Do not mix widths within one directory.

## Template

Use [`templates/adr-template.md`](templates/adr-template.md). Copy the file
verbatim, then fill it in. Do not invent sections that are not in the
template, and do not skip required sections (Context, Decision drivers,
Options considered, Decision, Consequences). `Compliance` and `References`
are optional - omit them if you have nothing crisp to write, do not pad.

## Frontmatter conventions

Following MADR, all frontmatter fields are optional except `status`, which
is required so that the lifecycle below applies. When a field is present,
use the format below so the ADR directory stays mechanically consistent
(searchable, sortable, parseable by tools).

| Field | Required | Format |
|---|---|---|
| `status` | Yes | One of: `proposed`, `accepted`, `deprecated`, `superseded by ADR-NNNN` |
| `date` | No | ISO `YYYY-MM-DD`. The date of the last meaningful change to status or content. |
| `deciders` | No | Comma-separated names (`Jane Doe, John Smith`), or a single name. |
| `scope` | No | Short phrase, a few words. Names a subsystem, service, or layer (`frontend state management`, `payments service`, `auth`). |

Do not invent new frontmatter fields. If something does not fit, write it
into the body.

## Status lifecycle

```
proposed  -->  accepted  -->  deprecated
                       \-->  superseded by ADR-NNNN
```

- **proposed**: drafted, not yet agreed. Default for new ADRs.
- **accepted**: agreed; the codebase is expected to follow it.
- **deprecated**: no longer applies but no direct replacement exists.
- **superseded by ADR-NNNN**: replaced by a newer ADR.

**Once an ADR is accepted, its body is immutable.** Status changes are
frontmatter-only and apply identically to deprecation and supersession.
The body is historical record; if a status change needs explanation
beyond the status value itself, that explanation belongs in the new
superseding ADR, the index, or the commit message - never in the
predecessor's body.

When you supersede an ADR:

1. Write the new ADR as a fresh file. Link to the predecessor in `References`.
2. Update the predecessor's frontmatter `status` to `superseded by ADR-NNNN`.
3. Do not edit the predecessor's body.

When you change an accepted ADR's substance (not just typos), you are
almost always actually writing a new ADR that supersedes it. The bar for
in-place edits is "the original wording was wrong about what was decided",
not "the decision evolved".

## Index file

Most ADR directories have a `README.md` index listing all ADRs with their
status. **Always update it** when adding, accepting, deprecating, or
superseding an ADR.

If the directory has no index yet and you are adding the first ADR, create
one. Minimum content:

```markdown
# Architecture Decision Records

| ID | Title | Status |
|----|-------|--------|
| [0001](./0001-...md) | ... | Proposed |
```

A one-line "what this ADR is about" column is fine if it adds value, but
do not turn the index into a duplicate of the ADRs themselves.

## Writing rules

These are the rules that make an ADR readable.

### Be ruthlessly concrete

Vague drivers ("scalability", "maintainability", "performance") tell a
reader nothing. Concrete drivers ("must support 50+ tenants on shared
hardware", "p95 page load under 1s on 3G") drive a real decision. If you
cannot make a driver concrete, drop it - it was decoration.

### Show alternatives, even bad ones

"Do nothing" and "keep the status quo" are valid options and should appear
when they were on the table. Two-line rejection notes are fine for
obviously-worse options. What is not fine is a "Considered Options"
section with only one option in it.

### Lead with the decision

The Decision section starts with `**We chose Option X.**` on its own line.
A reader who only reads that one sentence should walk away knowing what
was decided. Rationale comes after.

### Cap code at ~30 lines

ADRs are decision records, not code listings. A short snippet that makes
the shape of the decision concrete is good. Two pages of before/after
code is a design doc. Link to a reference implementation in the codebase
instead.

### Prefer prose to nested bullets

A paragraph of three sentences usually reads better than ten nested
bullets. Use bullets for genuinely list-shaped content (options,
drivers, consequences). Do not nest bullets more than one level.

### Write Compliance rules an agent can enforce

The `Compliance` section is the most agent-actionable part of an ADR.
Good rules name a thing and a constraint:

- "Imports of `@/services/managementApi` are forbidden outside `services/`."
- "Filter state lives in a Pinia store, never in component-local refs."
- "All money values cross service boundaries as `MinorUnits`, never `float`."

If you cannot state a rule that crisply, drop the section. Vague
compliance guidance is worse than none because it gets quoted out of
context.

## Anti-patterns

Reject these whether you are writing or reviewing an ADR:

- **Design-doc creep.** Sections like "Implementation phases", "File
  organization", "Migration backlog", "Setup required" do not belong in
  an ADR. They belong in a plan or design doc. Link to it.
- **Status reports embedded in the decision.** "Implementation Outcome
  (date): we did X, Y, Z over N lines of code" is project tracking, not
  a decision. The `status` field is enough; details go in a changelog,
  PR description, or separate progress log.
- **Pre-decided options.** A "Considered Options" section with only one
  serious entry and a strawman is theatre. Either rejected options got
  real consideration, or this ADR is not ready.
- **Mutable accepted ADRs.** Once accepted, the body is historical
  record. Edits beyond typos require superseding.
- **Cross-ADR sprawl.** If you find yourself writing "see ADR-001, -002,
  -003, -004" within a single decision, the ADRs are probably overlapping.
  Consider whether one of them should be superseded by a consolidating ADR.
- **Inventing ADR numbers or titles.** Read the index and the directory
  contents before assigning a number. Never reference an ADR by a number
  you have not verified exists.

## Workflow

1. Confirm an ADR is the right artifact (see "When to write an ADR" and "What an ADR is - and isn't").
2. Resolve the destination directory (see "Where the ADR lives").
3. Read the existing index and the last 2-3 ADRs in that directory for tone, length, and numbering. Pick the next number.
4. Copy `templates/adr-template.md` to the new file.
5. Draft. Keep the writing rules in mind. When in doubt, cut.
6. Update the index file in the same directory.
7. Default `status` to `proposed`. Promote to `accepted` only when the user explicitly says so.

## Stop conditions

Stop and ask the user if:

- The destination directory is unclear and the routing rules above do not resolve it.
- The proposed ADR does not meet the "When to write an ADR" criteria.
- The ADR you are about to write would supersede or contradict an existing accepted ADR (confirm the supersede direction first).
- The decision is still in flux ("we are trying X for now") - that is a devlog entry or a personal note, not an ADR.
