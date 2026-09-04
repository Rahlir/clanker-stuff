---
name: plain-prose
description: Write prose that reads like a careful human wrote it, in plain English with no machine-sounding phrasing. Use when drafting anything a person will read - MR review notes, code comments, docstrings, commit messages, tickets, docs, ADRs - and when auditing existing comments or docstrings for readability. Also use when the user says text sounds "AI generated", "too formal", "convoluted", or "full of jargon".
---

# Plain Prose

You are writing for a colleague: often junior, often not a native English
speaker, possibly reading at 3 AM, and certain to skim anything long. Clarity
beats sounding professional. Write the way a good engineer writes to a
colleague: plain and direct. That rules out both extremes, the polished
machine voice and the overly chatty one.

The reader must never have to translate a sentence before they can act on it.

## Rules

Each rule comes with a real example of what to avoid and what to write instead.

**1. Say what is wrong, then why.** The reader sees your text before they see
the reasoning behind it. Lead with the concrete point or ask; reasons follow.

- Avoid: "Measured, the post-processor changes two things in the document..."
  (three paragraphs of argument before the objection appears)
- Write: "Please drop the `require_acting_user_header` post-processor. Nobody
  reads the flag it sets: ..."

**2. State your position directly.** Whether you are suggesting a fix,
recording a decision, or describing a rule, say it as a statement. Hedges
("would you consider", "might be worth", "one could argue") and importance
disclaimers ("Minor:", "Non-blocking, but") make the reader guess how much
you mean it. If you are unsure, say what you are unsure about. Direct is not
curt: a one-clause reason after the ask keeps it collegial.

- Avoid: "Would it be worth adding the same cheap type check here?"
- Write: "I suggest adding the same type check here, so both callers fail the same way."
- Avoid: "It might be worth considering whether the flag could be removed."
- Write: "Let's remove the flag. Nothing reads it."

**3. Match length to the problem.** A one-line fix gets a two-line note. Cut
verification narratives, restatements of what the reader can see in the code,
and full error dumps when one line identifies the error. If a sentence can be
deleted without losing anything, delete it.

- Avoid: "Nothing wrong with the change itself. I checked the config on main,
  the job already has the same flag, and pipeline #3127408 confirms it passes
  in 2m14s."
- Write: "Nothing wrong with the change itself, I checked it against a real run."
- Avoid: "With this MR, `orderSpecs.remove` deletes every selected row." right
  after a paragraph that already said so
- Write: nothing; delete the restatement

**4. No meta framing.** Do not announce what you are about to say, qualify
its importance, or defend that it is worth saying. Just say it.

- Avoid: "To be clear about the boundary, since this is easy to overdo: ..."
- Avoid: "Point 4 is not busywork. The engine reads ..."
- Write: "The engine reads ..."

**5. Kill the "X, not Y" construction.** "It's A, not B", "A is acceptable;
B is not", "not a theoretical one" add emphasis and no information. State the
positive claim alone. Use a contrast only when the reader would otherwise
assume the wrong thing.

- Avoid: "It's a durable boundary guard, not a migration artifact."
- Write: "This check has to stay after the migration: it protects ..."

**6. Concrete words over metaphor.** Say what the thing does or what breaks.
Made-up compound nouns ("churn budget", "request-context gate", "ordered
ladder", "wire contract") and figurative language force the reader to
translate before they can understand.

- Avoid: "The combine works here, but it's load-bearing on absolute paths."
- Write: "This works only because the paths are absolute. If ..."
- Avoid: "needs a wiring line in the composition root"
- Write: "a closure that needs to be applied in `app.py`"

**7. Write for the actual reader.** Explain a technical term the first time
if the reader may not know it ("contravariant" gets a parenthetical; "CTA"
gets spelled out). Never reference context the reader does not have: session
nicknames ("A1"), local files, earlier drafts, what you plan to raise elsewhere.

- Avoid: "Land this after A1, see HANDOVER.md for the locale wiring."
- Write: "Do this after the frontend ticket (HSCTR-9406) is merged."

**8. No label prefixes.** `**Bug:**`, `**Suggested fix:**`, `**Ask:**`,
`Suggestion:` read as a form. Say it in prose.

- Avoid: "**Bug: the Active switch does nothing on create.**"
- Write: "The Active switch does nothing on create: ..."

**9. Simple sentences, active voice, one idea each.** If you had to reread
your own sentence, the reader will have to reread it twice.

- Avoid: "Both back negative assertions that no `Authorization` header is
  sent when the token is absent, which the current fixture setup makes
  vacuously true."
- Write: "Both tests check that no `Authorization` header is sent without a
  token. Right now they pass even if the header is sent, because ..."
- Avoid: "It is suggested that `allow_failure: true` be set on `coverage_combine`."
- Write: "Set `allow_failure: true` on `coverage_combine`."

## Words and phrases that mark text as machine-written

Treat a hit as a signal to rewrite the sentence, not to swap in a synonym.

| Avoid | Instead |
|---|---|
| load-bearing | say what breaks without it |
| lands, landed, once X lands | is merged, is implemented, is deployed |
| seam, boundary (as a metaphor) | name the actual interface, module, or layer |
| dovetails, defuses, bites, the case that actually bites | describe the concrete interaction or failure |
| by construction, holds by construction | say what guarantees it |
| folklore, archaeology, prior art | tribal knowledge, git history, existing example |
| genuinely, frankly, actually (as emphasis) | delete |
| nit, non-trivial, battle-tested, robust, seamless | delete or state the concrete property |
| roll out, ship, wire up | deploy, add, connect |
| worth noting, to be clear, keep in mind | delete, say the thing |
| not X but Y / X, not Y / not merely cosmetic | state the positive claim alone |
| em dash | comma, colon, or a new sentence |
| rendered arrows (`→`, `⇒`) | ASCII `->` |

## Comments and docstrings

All rules above apply, plus:

- A comment must earn its place: it explains *why* or a contract callers rely
  on. Delete comments that narrate what the code does.
- Length: usually one line, rarely more than two. A `# pyright: ignore` reason
  is a few words, never a sentence.
- Describe the state of the code, never a change or a process. "The first
  write path in the codebase", "temporary until HSCTR-1234", "now that X is
  merged" are true for a few weeks and then mislead every later reader.
  Comments should still be correct and understandable years from now.
- Docstrings describe behavior and parameters in plain words; no marketing
  ("robust", "flexible"), no design essays.

- Avoid: "`VoucherStatus` is exclusive per voucher, so it is counted in a single scan."
- Write: "A voucher has exactly one status."

When asked to audit existing comments, apply these rules to each one and
prefer deleting over rewriting.

## Final pass

Do this for every piece of prose, whether a note, a document, or a block of
comments, before you hand it over:

1. Read it once as the recipient. Where did you slow down? Rewrite that.
2. Delete every sentence whose removal loses nothing.
3. Scan for the table above, em dashes, rendered arrows, and label prefixes.
