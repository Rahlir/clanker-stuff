---
# status and date are required. scope is optional - remove it if unused.
status: draft
date: YYYY-MM-DD
scope: <short phrase, e.g. "management partial releases">
---

# <Title: name the solution, not the task>

<!--
One or two sentences: what this design provides, present tense.
A reader should know from this alone whether the doc concerns them.
-->

## Problem

<!--
Two to four sentences: the problem this shape solves and what makes it
non-trivial. Link to tickets, ADRs, or prior docs instead of restating
them. No solution content here.
-->

## Shape

<!--
The heart of the doc. Components, their responsibilities, boundaries, and
how data flows between them. Present tense, end state - describe the
system as it will exist, never the order in which it gets built. Name
real modules, tables, and endpoints. ASCII diagrams welcome. Subsections
per component are fine when the shape has natural parts.
-->

## Contracts

<!--
Optional. Surfaces the parts promise each other: schemas, endpoint
shapes, enums, invariants. Interface level only - no implementations.
Once real code exists, prefer linking to it. Remove this section if
Shape already covers it.
-->

## Decisions

<!--
Working ledger, one line per decision:
  <decision> - <one-line rationale> - <state>
States: `open` (may change), `settled` (holding; below the ADR bar), or
an ADR link (`ADR-0012`, proposed or accepted) once graduated. When a
decision graduates, replace its rationale with the ADR link - do not
restate it.
-->

- ... - ... - `open`

## Open questions

<!--
First-class while draft/active. An active doc with no open questions is
either finished or lying. Prune at reconcile: fold the answer into Shape
or Decisions and delete the question.
-->

- ...

## Out of scope

<!--
What this shape deliberately does not cover, so future readers do not
mistake omission for oversight. Also the graveyard for speculative
"later this could..." ideas.
-->

- ...

## References

<!-- Optional. ADRs, tickets, prior design docs, key code entry points. Remove if empty. -->

- ...
