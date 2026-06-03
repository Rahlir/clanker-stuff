---
# status is required. date, deciders, scope are optional - remove the lines you do not use.
status: proposed
date: YYYY-MM-DD
deciders: <name, or comma-separated names>
scope: <short phrase, e.g. "frontend state management", "payments service">
---

# ADR-NNNN: <short title that states the decision, not the problem>

## Context

<!--
Two to four sentences. What is the real-world problem, and what makes it
hard or non-obvious? Link to issues, prior ADRs, or design notes instead
of restating them. Do not describe the solution here.
-->

## Decision drivers

<!--
The concrete criteria that pushed us toward one option. Be specific:
"must support 50+ tenants" beats "scalability". 2-5 bullets is plenty.
If you cannot name drivers, the decision is probably not ready for an
ADR yet.
-->

- ...
- ...

## Options considered

<!--
Name every option that got real airtime, including "do nothing" if that
was on the table. Two or three lines each for the rejected ones. The
chosen option gets fuller treatment under "Decision" below, so do not
duplicate that detail here.
-->

### Option A: <name>
- Good: ...
- Bad: ...

### Option B: <name>
- Good: ...
- Bad: ...

## Decision

**We chose Option X.**

<!--
One paragraph on why this option wins given the drivers above. Then,
only if it genuinely helps, a small concrete example showing the shape
of the decision in code or in a diagram. If a code example would run
more than ~30 lines, link to a reference implementation in the codebase
instead of inlining it.
-->

## Consequences

**Good**
- ...

**Bad**
- ...

## Compliance

<!--
How a reader (human or agent) tells whether new code follows this ADR.
Short, concrete rules work best:
  - "Imports of `legacyClient` are forbidden in new code."
  - "Cross-tenant queries must go through `tenantScope()`."
  - "Filter state lives in a Pinia store, never in component-local refs."
Remove this section if you cannot state a crisp rule. Vague guidance
here is worse than none.
-->

- ...

## References

<!-- Optional. Remove if empty. Link prior ADRs, RFCs, design notes, external articles. -->

- ...
