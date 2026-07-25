---
name: design-doc
description: Author living design docs that capture the shape of a solution - the "how" - so the doc can evolve during implementation and read as accurate documentation once the work is done. Use when the user asks to write, update, reconcile, or settle a design doc, or when work needs a durable picture of the solution shape but its decisions are not (yet) ADR-worthy. Companion to the `adr` skill - ADRs record decisions (why/what) and are immutable; design docs describe shape (how) and evolve with the code. This skill does NOT decide where the doc lives - that belongs to the repo's conventions.
---

# Design Doc Authoring

You are writing a **living design doc**. It has one body and two lives:

- **While the work is in flight** it is a working artifact: mutable, edited
  freely, expected to track the code as the design emerges.
- **When the work is done** it is reader documentation: the accurate
  description of the shape that was built, with pointers to why.

One rule makes a single document serve both lives: **describe the system,
never the work**. "The relay claims rows by setting `claimed_at`" stays true
no matter what order the work happens in. "First we add the column, then we
build the relay" is stale the moment reality reorders it. Present tense, end
state, no sequencing.

## What a design doc is - and isn't

A design doc **is**:

- A description of the solution shape: components, responsibilities,
  boundaries, data flow, and the contracts between parts.
- The staging ground for decisions that are not yet stable enough to be
  ADRs.
- Mutable while `draft` or `active`. Editing it is normal, not ceremony.

A design doc is **not**:

- A plan. No phases, no task lists, no checkboxes, no rollout sequences, no
  "Steps". Ordering of work lives in tickets or in chat, and dies there.
- A decision record. A decision that is architectural, non-obvious, and has
  stabilized graduates to an ADR. The doc links to it; it never restates the
  rationale.
- A devlog or status report. No dated session entries, no done/remaining
  tallies.
- A tutorial. Onboarding material belongs in `README.md` or a docs site.

If the document grows past roughly 1500 rendered words, or acquires headers
like "Phase 1", "Tasks", "Migration steps", **stop**. Either the shape is
really several docs (split by subsystem) or plan content is creeping in
(evict it to a ticket or chat).

## When to write one

Write a design doc when **both** are true:

1. The shape spans multiple components, files, or services, so a
   fresh-context reader (human or agent) needs the picture to work on it.
2. The work spans multiple sessions, people, or agents - someone will arrive
   later without today's context.

Route elsewhere when:

- The outcome is a single settled decision → write an ADR (`adr` skill).
- The work is small and you hold full context until it ships → no doc; the
  thinking lives in chat and dies there.
- What needs recording is order or ownership of work → a ticket, with the
  design doc (or ADR) as its context link.

One doc per body of work. Do not grow a repo-wide monolith, and do not
shard one feature's shape across five files.

## Where the doc lives

This skill does **not** decide path. Resolve the destination in this order:

1. The user's explicit instruction.
2. Where the repo (or the effort) already keeps design docs - e.g. a
   `docs/design/` directory, or an effort-scoped directory that already
   holds related design material.
3. The convention documented in `README.md`, `CONTRIBUTING.md`, or an
   agent-instruction file (`AGENTS.md`, `CLAUDE.md`).

If none of the above resolves the path, **stop and ask**. Do not invent a
location.

## File naming

- Pattern: `kebab-case-solution-name.md`, e.g. `partial-releases.md`,
  `outbox-relay.md`.
- Name the solution, not the activity: `partial-releases.md`, not
  `implement-partial-releases.md` or `partial-releases-plan.md`.
- No numbering. Design docs do not form an ordered series the way ADRs do;
  if the directory already numbers its docs, match its convention.

## Template

Use [`templates/design-doc-template.md`](templates/design-doc-template.md).
Copy the file verbatim, then fill it in. Sections marked optional may be
removed when empty; do not invent sections that are not in the template -
in particular, no plan-shaped sections.

## Frontmatter conventions

`status` and `date` are required; `scope` is optional. Use these formats so
design-doc directories stay mechanically consistent:

| Field | Required | Format |
|---|---|---|
| `status` | Yes | One of: `draft`, `active`, `stable`, `superseded by <file>` |
| `date` | Yes | ISO `YYYY-MM-DD`. Last meaningful change. |
| `scope` | No | Short phrase naming subsystem or service (`management partial releases`). |

Do not invent new frontmatter fields.

## Status lifecycle

```
draft  -->  active  -->  stable  -->  superseded by <file>
              ^            |
              \------------/  (work on the shape resumes)
```

- **draft**: the shape is being explored; implementation has not meaningfully
  started. Everything may change.
- **active**: implementation is underway. The doc is expected to change and
  is reconciled against the code when the user calls for it (below). An
  `active` doc that contradicts the code is a bug in the doc.
- **stable**: the overall shape shipped and the doc was reconciled from the
  actual code. It is now reader documentation. Small in-place edits -
  typos, clarifications, accuracy fixes - are fine and need no ceremony.
  Changes to the shape itself mean either work has resumed (flip back to
  `active`) or the design is being replaced (supersede). This is *not*
  ADR-style immutability.
- **superseded by <file>**: replaced by a newer design doc. Update the old
  doc's status; do not delete it.

The contrast with ADRs is deliberate: an accepted ADR's body is immutable
and changes only by supersession; a design doc stays editable for as long
as it lives. That is why decisions ripen here and are recorded there.

## Reconciling: the doc follows the code

Reconciling is deliberate, not continuous. It happens **when the user calls
for it**, typically after a significant coding session - not after every
change. Do not reconcile on your own initiative without a really good
reason; instead, when a substantial slice of work has landed, nudge once:
"the design doc may have drifted - want to reconcile it?" A doc updated
after every edit is a devlog with extra steps.

A reconcile does the following:

1. Re-read the doc against the actual code. Code that is *not yet built* is
   fine - the doc describes the end state. Code that was *built differently*
   than described is a doc bug: fold the change into the doc. List each fold
   for the user so they can veto ones that are actually code bugs; never
   leave doc and code silently disagreeing.
2. Prune answered open questions. The answer moves into Shape or Decisions;
   the question disappears.
3. Review the Decisions section: graduate entries that now meet the ADR bar
   (below).
4. If the work is complete, do a final full pass from the code and flip the
   status to `stable`.

Reconciling never produces plan content. "What remains to be built" is
visible from the doc-code delta; do not write it down as steps.

## Graduating decisions to ADRs

The default route: decisions ripen in the design doc and are recorded as
ADRs **after** they have survived contact with the code, typically at a
reconcile. An accepted ADR written before the design stabilizes gets
superseded within days or, worse, illegally edited.

The second route: when a decision is meant to *constrain* the
implementation up front - an architectural guardrail the feature must
follow - open the ADR as `proposed` alongside the design doc and flesh
both out during implementation. The doc links to it like any graduated
decision; the ADR's own `status` field carries its maturity. Promote to
`accepted` when it has held, on the user's word (per the `adr` skill).

Either way, two things stay true: no `accepted` ADR for a decision still
in motion, and no rationale duplicated between doc and ADR.

Each entry in the doc's Decisions section carries a state:

- `open` - may still change; lives here and nowhere else.
- `settled` - holding, but fails the ADR bar (not architectural, or
  obvious); it stays a one-liner here permanently.
- `ADR-NNNN` - has an ADR (proposed or accepted); the entry's rationale is
  replaced by the link.

If implementation contradicts an *accepted* ADR, that is a supersession
conversation, not a design-doc edit.

## Writing rules

### Describe the system, not the work

Present tense, end state. Any sentence about ordering, effort, or who does
what is plan content - evict it. This single rule is what lets the doc
survive implementation churn and still read as documentation afterward.

### Be ruthlessly concrete

Name the real modules, tables, endpoints, and event types
(`BulkVoucherOperation.selection`, `POST /v1/batch/{id}/release`), not
roles ("the persistence layer"). ASCII diagrams are welcome where prose
gets clumsy.

### Keep it concise enough to actually be read

The doc is re-read at the start of every session that touches the work, by
humans and agents both - and humans skip or skim long docs. A skimmed
design doc is a failed design doc. Target a five-minute read. Say each
thing once: no restating, no second emphasizing sentence, no filler
("importantly", "note that", "as mentioned above"). Every sentence earns
its place. When the doc outgrows the target, split by subsystem or evict
creeping content - do not summarize the shape into vagueness.

### Open questions are first-class

While a doc is `draft` or `active`, the Open questions section is where
uncertainty lives honestly. An active doc with no open questions is either
finished or lying. Prune at reconcile.

### Cap code at interfaces

Schemas, signatures, endpoint shapes, enums: yes - that is shape.
Implementations: no. Once real code exists, prefer linking to it over
inlining it.

## Anti-patterns

Reject these whether writing or reviewing a design doc:

- **Plan creep.** "Phase 1", "Step 3", task checkboxes, rollout sequences,
  effort estimates. Plans are chat-ephemeral or tickets; a design doc that
  contains a plan starts rotting the day implementation starts.
- **Devlog creep.** Dated entries narrating what happened. Git history
  already does this. Reconciling after every small change is the same
  disease in slow motion.
- **Rationale essays.** Multi-paragraph why-we-chose-X belongs in an ADR
  (if it meets the bar) or gets cut to one line (if it does not).
- **Restating ADRs.** Link, never duplicate. Duplicated rationale forks.
- **Plan fidelity.** Treating an `active` doc as a contract and calling
  code changes "deviations" to be resisted or ceremonially approved. The
  doc follows the code; divergence is information, not disobedience.
- **Premature acceptance.** Accepting ADRs for decisions still in motion.
  A `proposed` ADR evolving alongside the doc is fine; an `accepted` one
  superseded a week later is churn.
- **Zombie stable.** A `stable` doc contradicting the code it describes.
  Reopen it (`active`) or supersede it; never leave it lying.
- **Speculative shape.** Documenting components nobody is building
  ("later this could also..."). Out of scope exists for exactly this.

## Workflow

1. Confirm a design doc is the right artifact (see "When to write one"). If
   the request is really an ADR or a ticket, say so.
2. Resolve the destination directory (see "Where the doc lives").
3. Read any sibling design docs for tone, length, and conventions.
4. Copy `templates/design-doc-template.md` to the new file.
5. Draft: Shape in present tense, seed Decisions (`open`) and Open
   questions with the genuinely undecided items. Default status: `draft`;
   `active` once implementation starts.
6. During implementation: edit freely as the shape moves; after a
   significant slice lands, nudge the user about reconciling (see
   "Reconciling").
7. Graduate stabilized decisions via the `adr` skill; open a guardrail ADR
   as `proposed` alongside the doc when the user wants one up front.
8. When the work ships: final reconcile from the code, prune, flip to
   `stable`.

## Stop conditions

Stop and ask the user if:

- The destination directory is unclear and the routing rules do not
  resolve it.
- The doc you are about to write fails the "When to write one" bar - say
  chat or an ADR suffices, and ask before proceeding.
- The shape you are documenting contradicts an accepted ADR. Resolve the
  supersession direction first; never encode the contradiction silently.
- The user asks to embed phases, task lists, or schedules. Push back once,
  offering a ticket as the home; comply only on explicit insistence.
- You are asked to change the *shape* described by a `stable` doc and it
  is unclear whether work is resuming (flip to `active`) or the doc should
  be superseded.
