---
name: analyze-pi-usage
description: Produce the user's pi usage report - a single HTML page on how they used pi over the last 30 days (models, repos, cost, outcomes, what works, what does not, quick wins, big ideas, community finds), built on the pi-sessions corpus and published with this skill's render script. Use only when the user invokes /skill:analyze-pi-usage.
disable-model-invocation: true
---

# pi usage report

The user's brief is below, verbatim. The rest of this file says how to meet
it: the data comes from the `pi-sessions` skill, the page from
`scripts/render.mjs`, which checks the report's structure, references and
history and refuses to publish one that fails (What render.mjs checks, below).
The fidelity rules are yours to keep. Arguments after the command (another window, a focus)
adjust the brief; use the same window for every command.

## The brief

Perform a comprehensive analysis of how I use `pi`. Focus your analysis on the
`pi` sessions created in the last 30 days.

To present your analysis, generate a readable HTML page with clean and good
looking UI.

This page should show the following information:
1. Overview of how I have been using `pi` in the last 30 days. What models am I
   using; what repositories do I work on; cost breakdown both by models and by
   repositories; what work do I use `pi` for.
2. Overall verdict and description of my workflow. Essentially describe what
   kind of `pi` user I am in one sentence + one short paragraph elaborating on
   that description.
3. What works well in my workflow. Identify particularly successful workflows
   and / or successful `pi` sessions.
4. What doesn't work well in my workflow.
5. Identify "quick wins" that would benefit my workflow. This means small
   changes to my skills / prompts / extensions. Anything that is easy to modify
   and would yield measurable improvements for me.
6. Identify big picture enhancements for my workflow. Here, **go big**. Think
   of something yourself based on my `pi` usage; what others have already
   built belongs in the next point. Essentially here I want you to explore my
   horizons of what is possible in `pi`.
7. Show me what the `pi` community uses. Look online what other users have
   been using recently: check popular extensions and skills. For each find,
   judge whether it fits my workflow based on my `pi` sessions, not on the
   package's own pitch.

In the footer of the site, write the date of the analysis and what model and
what thinking level has generated it.

Save your report to `~/.pi/agent/sessions/pi-session-report-{date}.html` where
`date` is the current date in the format `YYYY-MM-DD`.

What to focus on in your analysis: **outcomes and productivity**. De-emphasize
cost as the primary criteria for evaluating my workflow. I simply don't care
about cost that much. It's fine to suggest ways to lower the session cost or to
point out when I am consistently "throwing money against the wall" when I could
achieve the same outcomes at lower cost. But I care more about outcomes and
productivity, so make that the primary criteria in your analysis.

Earlier reports are available through `scripts/history.mjs`. Use them to get
some sense of what previous agents recommended and to understand how my
workflow might have changed over time, **but do not treat them as a guideline**
for what suggestions you should give me. This report **is your own original
work**, so approach it that way. _Referring to older recommendations and using
historical context in your report is allowed, but restating a previous
recommendation needs a good reason: mark it as a repeat or a follow-up and say
why it still matters._

## Workflow

Read [../pi-sessions/SKILL.md](../pi-sessions/SKILL.md) first. Keep working
files in a new, empty `${TMPDIR:-/tmp}/analyze-pi-usage/<date>-<HHMM>/` named
for the run's start (the run dir), never in an earlier run's. Below,
`piss` is `../pi-sessions/scripts/piss.mjs --corpus <run dir>/corpus.db`: a
corpus of the run's own, so another session's build cannot change the data
mid-run. Every windowed command gets `--since 30d --until built`, so all of
them, and render.mjs's defaults, cover the same 30 days ending at the build.

1. **Build first,** before any other command, including reading facts or
   tags: `piss build --since 60d` (two windows, so trends can be compared).
2. **Numbers:** `piss facts --since 30d --until built --compare`. Charts and
   KPI cards draw from the same facts; numbers in prose come from it, `piss
   outcomes` or `piss sql` (fidelity rule 2).
3. **History:** `scripts/history.mjs` prints each earlier report's
   recommendations with their ids (`2026-10-13#some-id`). Only those ids
   exist; never make one up. `--full` prints a whole report and is rarely
   worth its size. It leaves out reports dated today and names each one; never
   open them. When it says publishing replaces one, ask the user now whether
   it may.
4. **Read every prompt:** `piss prompts --since 30d --until built --free-text`,
   all pages.
5. **Label the work:** `piss tag --list`, then
   `piss tag --untagged --since 30d --until built`; open sessions as needed and
   tag each with one kind of work, reusing existing labels. `piss facts` then
   groups time and spend by label.
6. **Outcomes:** `piss outcomes --since 30d --until built`, and save its
   `--json` output to `<run dir>/outcomes.json` for the KPI card. If a note
   says repos were past `--max-repos`, rerun with a higher one.
7. **Follow up the last report:** for every recommendation of the latest
   earlier report, and any older one you will mention, find out what happened:
   the file it names (git log), `piss find`, `piss sql` over prompts and tool
   calls. Record each in `findings.carried` (below).
8. **Evidence:** `piss show <ref>` every session you will cite anywhere, and
   read enough of it to back the claim.
9. **Community:** research what other pi users run now with the
   `brave-search` skill: popular packages on pi.dev/packages, GitHub,
   discussions. Open each candidate's page; judge its fit against the user's
   sessions, not against its own pitch.
10. **Write** `<run dir>/body.html` and `<run dir>/findings.json` (formats
    below). Write the prose with the `plain-prose` skill. Run step 11 with
    `--check` on the first draft: it lists every problem at once (see What
    render.mjs checks, below) and writes nothing.
11. **Publish:** `scripts/render.mjs --corpus <run dir>/corpus.db --body
    <run dir>/body.html --findings <run dir>/findings.json --outcomes
    <run dir>/outcomes.json`. Fix every listed problem and run it again until
    it writes the report. If a report for the date already exists (`--check`
    warns early), ask the user whether to replace it, and pass `--force` only
    on a yes.
12. **Look once:** one browser screenshot (`browser-tools`) of the published
    page, to catch broken layout only; the design is already reviewed.
13. **Report back:** the report path, the corpus coverage line, and any
    question piss could not answer that you had to query raw logs for.

## Required sections

The body must contain these sections, in this order; render.mjs refuses a
body that lacks one. Other sections may be added between them.

| `id` / `data-label` | Brief | Must contain |
|---|---|---|
| `overview` / Overview | 1 | `<!--chart:daily-->`, `repos`, `models`, `heatmap`; a table of kinds of work from the tags (sessions, time, spend); what the work was |
| `verdict` / Verdict | 2 | A `.verdict` card: `.persona` label, the one-sentence `.line`, `.traits`, one short paragraph |
| `works` / What works | 3 | `.finding` cards with evidence refs; successful sessions named; the user's own words in `.voice` quotes |
| `friction` / What does not | 4 | `.finding.friction` and `.finding.risk` cards with evidence refs |
| `since-last` / Since the last report | last paragraph | An `<h2>` that sums up what stuck, then `<!--chart:carried-->`, which renders every `findings.carried` item with the earlier report's own wording |
| `quick-wins` / Quick wins | 5 | `.rec` cards, each naming the file to change and the change (`.change`), with evidence and effort/payoff meters |
| `go-big` / Go big | 6 | `.bet` cards: your own ideas from the user's usage, each with concrete first steps; community packages go in the next section |
| `community` / From the community | 7 | A `.radar` of `.find` cards from the online research: link, popularity with its source, what it is, `.fit` grounded in the user's sessions (with refs), `.nofit`, and a `data-ring` verdict matching its findings ring (none for `look`) |
| `method` / Method | | A `.method` box: window, corpus coverage line, outcomes notes (repos not checked), what was read, ad-hoc queries, what is not covered |

## Writing the body

[assets/example-body.html](assets/example-body.html) uses every component and
renders as a finished report; read it before writing, and copy its markup.

- Start with `<header class="hero">`: an `<h1>` with one `<em>` phrase, a
  `<p class="lede">`, and `<!--chart:kpis-->`. render.mjs adds the kicker line
  and the map behind it.
- Each section is `<section id="..." data-label="...">` with an `<h2>` that
  states the finding as a sentence, then an optional `<p class="dek">`.
  render.mjs numbers sections and builds the navigation.
- Charts go where you put `<!--chart:NAME-->`: `kpis`, `daily`, `weekly`,
  `repos`, `models`, `heatmap`. Put two side by side in a `<div class="grid-2">`.
  `<!--chart:carried-->` belongs in Since the last report, once.
- Name what backs a claim, and put its marker right after the phrase it
  backs: `[[S261013-1258]]` for a session, `[[R:2026-10-13#some-id]]` for an
  earlier report's recommendation, `!66` for an MR, a short hash for a commit,
  the key for a ticket. Session and report markers become hover cards; a
  report chip reads only "13 Oct report", so the sentence names the
  recommendation itself. Never point at a date alone ("the 13 Oct idea"):
  a reader cannot open a date.
- Numbers in prose come from piss output, never from your own arithmetic over
  raw logs.
- piss counts sessions active in the window (pi-sessions' metrics.md), not
  sessions created in it: call them active.
- No `<style>` or `<script>`, and no em dashes anywhere: render.mjs rejects
  both.
- `data-ring` on a `.find` is `try`, `watch` or `pass`, as its `ring` in
  findings.json; leave it off when that ring is `look` ("worth a look").

## findings.json

The machine-readable part of the report; render.mjs writes it into the
sidecar `pi-session-report-<date>.json`, which the next report reads through
history.mjs. See [assets/example-findings.json](assets/example-findings.json).

- `verdict`: the verdict card's sentence, exactly as in the body.
- `recommendations`: one item per `.rec` card (`kind: "quick"`) and per
  `.bet` card (`kind: "big"`), with `id` (a slug), `title` (the card's heading,
  exactly), `summary`, `refs` (the sessions it rests on), `status`, `previous`.
  `status` is `new`, `repeat` (restating an earlier recommendation that was
  not adopted; say why it still matters) or `follow-up` (building on one); the
  last two set `previous` to the earlier id as history.mjs prints it, such as
  `2026-10-13#give-investigations-an-exit`, and follow that id up in `carried`.
- `carried`: one item per earlier recommendation the report follows up, with
  `ref` (its id), `outcome`, `evidence` (what happened and how you know: the
  commit, the file, the session; `[[S...]]` markers allowed), `effect` (the
  change since, in piss numbers, or null) and `refs`. `outcome` is `adopted`,
  `partly`, `not-adopted`, `dropped`, `superseded` or `unclear` (say in
  `evidence` what you checked). Cover every recommendation of the latest
  earlier report, and every older one the body or a `previous` cites. An
  older one may also go in when something happened to it in this window.
  render.mjs groups the cards by report under a count ("6 Oct report, 2 of
  16 recommendations") and quotes each item's title and summary from the
  earlier sidecar; do not retell them.
- `community`: one item per `.find` card with `name` (as in the body), `url`,
  and `ring` (`try`, `look`, `watch`, `pass`).

## What render.mjs checks

Every problem is listed at once, and nothing is written until there are none.

- **Body:** starts with the hero, which holds `<!--chart:kpis-->`; required
  sections present and in order; every section has `id`, `data-label` and an
  `<h2>`; Overview holds `daily`, `repos`, `models` and `heatmap`, Since the
  last report `carried` (once); known charts only; no em dashes in any form
  (`&mdash;` too); no `<style>`, `<script>`, `<iframe>`, `<form>` or similar,
  no `on...=` attributes, no `javascript:` links, no `<!--slot:...-->`. The
  page's Content-Security-Policy also blocks any script, image or font from
  outside, so link to sources rather than embedding them.
- **Refs:** every `[[S...]]` is in the corpus, in the body and in
  findings.json; every `[[R:...]]` is followed up in `carried`.
- **findings.json:** the format above, with at least one quick and one big
  recommendation and no em dashes; the verdict, every title and every
  community name appear in the body, and card counts match.
- **History:** every earlier sidecar is readable, and the latest earlier
  report has one; every `carried` and `previous` id exists in one; every
  `previous` is in `carried`; the latest earlier report is fully covered.
- **Outcomes:** `outcomes.json` covers the same window as the report. Repos
  that could not be checked show on the KPI card, never as zero.

The last lines of its output give the window, the corpus coverage line and
the outcomes notes for the Method section, and warn when the footer would
name no model (run render.mjs from inside pi).

## Fidelity rules

1. Every session the report cites, examples in tables included, is one you
   opened with `piss show`. Every claim in What works, What does not, Since
   the last report, and a community card's fit cites such sessions.
2. State numbers only from `piss facts`, `piss outcomes` or `piss sql`; the
   window in prose matches the window passed to render.mjs.
3. Earlier reports used other definitions: compare with them only through
   `facts --compare` and history.mjs, never by quoting their numbers.
4. The Method section quotes the corpus coverage line; a WARN must also be
   said in plain words.
5. Outcomes lead, cost follows: judge workflows by what shipped and what it
   took, and mention spend where it changes a decision.
