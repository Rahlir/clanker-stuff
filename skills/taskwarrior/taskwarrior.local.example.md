# Taskwarrior Local Configuration (template)

Copy this file to `${XDG_CONFIG_HOME:-$HOME/.config}/pi-clanker/taskwarrior.local.md`
and fill it in. `SKILL.md` reads that file every session to learn things about
how you use Taskwarrior that it cannot discover by running `task` itself.

This file stays in the skill's package directory as a template only; your
filled-in copy lives in the config directory so `pi update` never overwrites it.

This file is for **meaning, intent, and personal conventions** only. Do not
hardcode anything the agent can query (project names, context filters, UDA
types, hooks, default report, ...). See the [skill README](README.md#recommended-local-configuration)
for the full discoverable-vs-not breakdown.

Delete any section below that has nothing non-obvious to record. Keep this
file short; the agent reads it on every turn.

---

## Time framing

- **Time zone (only if different from system):** _e.g. `Europe/Vienna`_
- **Working hours:** _e.g. `Mon-Fri 09:00-18:00`_
- **How "today" works on weekends:** _e.g. "If I ask 'what's on for today'
  on a Sunday, treat it as Monday."_
- **How "this week" works:** _e.g. "Monday through Friday, not
  including the weekend."_

Drop any line you do not want the agent to assume.

---

## Project conventions

Describe the **naming scheme** and what each top-level or namespace means.
Do NOT enumerate every project; the agent will run `task _projects` for
that. Use this section to translate cryptic names and explain hierarchy.

Example:

- `work.*` ‑ paid job. Anything billable or job-related.
- `work.client_<name>` ‑ specific client engagement.
- `work.admin` ‑ internal: timesheets, expenses, performance reviews.
  Lower urgency by default; do not surface in "what should I do next"
  unless overdue.
- `personal.*` ‑ outside of work.
- `personal.home` ‑ house, repairs, errands.
- `personal.health` ‑ doctor, dentist, exercise, meds.
- `learn.*` ‑ side projects and study. Non-deadline-driven; never put in
  "critical" lists unless I explicitly tag it.

Document any project whose name is opaque (`work.platform`, `ops.q3`, ...)
so the agent can say what it actually is.

---

## Tag conventions

Explain what each tag **means** to you and how the agent should treat it.
You do not need to list every tag; cover the ones whose name is not
self-explanatory or whose handling matters.

Example:

- `+next` ‑ a curated GTD-style next action. **Do not auto-add this.** I
  apply it during weekly review.
- `+waiting` ‑ blocked on someone else. Surface "waiting since" age in
  reviews. Do not include in "what should I do" lists.
- `+someday` ‑ back-burner. Exclude from active reads unless I ask.
- `+errand` ‑ requires being out of the house.
- `+phone` ‑ requires a phone call.
- `+computer` ‑ needs a real keyboard, not phone.
- `+quick` ‑ under 5 minutes; safe to batch when I am tired.
- `+deep` ‑ needs a long uninterrupted block; do not suggest before short
  meetings.

---

## Context purposes

Describe **why** each context exists and **when** to use it. Do not copy
the filter (the agent will read it via `task context list`); you are
explaining intent the filter does not capture.

Example:

- `work` ‑ active by default during weekday daytime. Covers all paid-work
  projects.
- `personal` ‑ active evenings and weekends.
- `quick` ‑ short low-energy items only; useful right before standup or at
  the end of the day.

When the user says X, do Y:

- "switch to work" ‑ activate the `work` context.
- "show me work tasks" ‑ read with `work` context active; restore previous
  context after.
- "show me everything" ‑ read with `task rc.context: <command>` to bypass
  any active context for a single call.

---

## Personal definitions

These are subjective. Without them the agent will fall back to plain
urgency and may answer differently each time.

- **Critical:** _e.g. `+OVERDUE` OR (`priority:H` AND `due.before:eod+2`)_
- **Important:** _e.g. `priority:H` OR `urg.over:10`_
- **Soon:** _e.g. `due.before:eow`_
- **What "I should focus on right now" means to me:** _e.g. ready, not
  waiting, top of urgency under the active context_

If you have a personal interpretation of `priority:H/M/L` beyond
"high/medium/low", note it:

- _e.g. `H` = "I will personally feel bad if this slips a day"_
- _e.g. `M` = "should land this week"_
- _e.g. `L` = "nice to have"_

---

## UDA purposes

The agent can read each UDA's type, label, and allowed values via
`task show uda.`. Use this section to record what the values **mean** and
how they should drive the agent's behavior.

Example:

- `estimate` ‑ estimated effort in **minutes** (numeric). Agent should
  surface totals when planning a focus block.
- `energy` ‑ `low` / `med` / `high`. Suitability of the task for the
  user's energy level. Use when the user says "I'm tired" / "I'm sharp".
- `client` ‑ client identifier when `project` does not capture it (e.g.
  shared `work.consulting` project covers multiple clients).
- `jira` ‑ linked Jira ticket key. If present, mention it in summaries so
  I can cross-reference.

If you have no custom UDAs, delete this section.

---

## Working-style notes

Free-form. Anything else the agent should know that does not fit above.
Examples of useful entries:

- "Never auto-add `+next`. I curate next-actions manually during reviews."
- "Treat anything in `work.client_a` as billable; surface estimates in
  summaries."
- "I do my weekly review on Friday afternoons. If I ask for one earlier in
  the week, ask whether to do a full review or a mini one."
- "When I ask to add a task without a project, do not invent one. Ask."
- "I prefer concise summaries: 5 lines or fewer unless I ask for more."
