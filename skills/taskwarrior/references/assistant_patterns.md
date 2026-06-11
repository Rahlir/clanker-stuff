# Personal Assistant Patterns

Opinionated recipes for the agent acting as the user's personal assistant
over their Taskwarrior database. Load this when the user asks a question
deeper than "show me X" or "add Y", e.g. "what should I focus on", "plan my
day", "weekly review".

All commands assume placeholders are resolved from `taskwarrior.local.md`.
If the user has not defined "critical" / "important" / "soon" there, fall
back to the defaults in each section and tell the user once that you used
defaults.

---

## Pattern 1: "What should I work on right now?"

**User intent:** a single, short, ranked answer they can act on in the next
15-60 minutes.

**Steps:**

1. Check the active context: `task context show`. If a context is active
   and matches the user's framing (e.g. they said "work" and `work` context
   is active), keep it. If they said "work" and `personal` is active,
   switch (with permission) or temporarily bypass with `rc.context:`.
2. Pull a small, focused candidate set as JSON:
   ```bash
   task status:pending -waiting -someday \
     limit:25 \
     export | jq 'sort_by(-.urgency)'
   ```
3. Apply the user's `Critical` / `Important` definitions from
   `taskwarrior.local.md`.
4. Surface 3-7 tasks ranked by urgency. Show: id, description, project,
   due (if any), urgency (1 decimal), tags worth knowing.
5. Recommend ONE to start with and explain why in one sentence (overdue,
   highest urgency, easiest unblock, blocking other tasks, etc.).
6. Do not auto-start it. Ask "want me to `task <id> start`?"

**Template:**

> You have 4 ready candidates in `work`:
>
> 1. **[12]** Submit Q3 review · `work.admin` · due **today** · urg 14.2
> 2. **[18]** Reply to Alex on RFC · `work.client_a` · urg 9.1 · `+next`
> 3. **[7]**  Renew SSL cert · `work.platform` · due **Fri** · urg 8.4
> 4. **[22]** Read accessibility doc · `learn` · urg 4.3 · `+deep`
>
> Start with **#12**: it is due today and has the highest urgency. Want me
> to mark it active (`task 12 start`)?

---

## Pattern 2: Daily Plan

**User intent:** "plan my day" or "what's on my plate today".

**Steps:**

1. Get overdue first:
   ```bash
   task +OVERDUE -waiting export | jq 'sort_by(-.urgency)'
   ```
2. Get due today:
   ```bash
   task due:today -waiting export
   ```
3. Get scheduled for today:
   ```bash
   task scheduled.before:tomorrow scheduled.any: -waiting export
   ```
4. Get top 3 by urgency excluding the above:
   ```bash
   task status:pending -waiting -someday -OVERDUE \
     'due.after:today or due.none:' \
     limit:5 export | jq 'sort_by(-.urgency)'
   ```
5. Active tasks (already started but not stopped):
   ```bash
   task +ACTIVE export
   ```
6. Present in three sections: **Overdue**, **Today**, **If time permits**.
   Mention any active task at the top so the user remembers it is running.
7. Estimated total minutes if the `estimate` UDA exists:
   ```bash
   task <plan filter> export | jq '[.[].estimate // 0 | tonumber] | add'
   ```
8. Offer to switch context to one matching the morning's work block.

**Do not** add or modify tasks during a daily plan. Just summarize.

---

## Pattern 3: Weekly Review

**User intent:** structured GTD-ish weekly review.

Walk the user through the steps below in order. Pause for input between
sections. Do not blast all output at once.

### 3.1 Status check

```bash
task stats                                # high-level counts
task summary                              # by-project completion %
task completed end.after:1week-ago count  # how many closed this week
task add.after:1week-ago count            # how many added this week
```

Surface the deltas as one or two sentences.

### 3.2 Overdue triage

```bash
task +OVERDUE export | jq 'sort_by(.due) |
  .[] | {id, due, days_late: ((now - (.due | strptime("%Y%m%dT%H%M%SZ") | mktime)) / 86400 | floor),
         project, description}'
```

For each overdue task, ask:

- Reschedule (`task <id> modify due:<date>`)
- Drop the date (`task <id> modify due:`)
- Mark done if it actually happened
- Move to `+someday`
- Delete

Apply changes one at a time after explicit user choice.

### 3.3 Waiting items

```bash
task +waiting export | jq 'sort_by(.entry) |
  .[] | {id, description, project, waiting_since: .entry, annotations}'
```

For each, ask: still waiting, follow up, or move forward.

### 3.4 Stale tasks

Tasks that have not been touched in N days but are not waiting:

```bash
task status:pending modified.before:2weeks-ago -waiting export |
  jq 'sort_by(.modified) | .[:20] |
      .[] | {id, description, project, modified}'
```

For each, ask: still relevant, deprioritize, or close.

### 3.5 Inbox / no-project tasks

```bash
task project: status:pending export
```

These are tasks added in haste without a project. Ask the user to assign
projects.

### 3.6 Next-actions audit

```bash
task +next status:pending export | jq 'group_by(.project) |
  map({project: .[0].project, count: length, items: map({id, description})})'
```

Make sure every active project has at least one `+next`. Flag projects
with none.

### 3.7 Closeout

Summarize the changes made during the review (count of tasks rescheduled,
closed, deleted, deprioritized). Suggest the user run a backup if the
review touched more than a handful of tasks:

```bash
tar czf ~/task-backup-$(date +%Y%m%d).tgz -C ~ .task .taskrc
```

Do not run the backup automatically. Ask first.

---

## Pattern 4: Overdue Triage (Quick)

**User intent:** "what's overdue" or "I've been ignoring tasks, help me
catch up".

**Steps:**

1. Pull overdue with how-late info:
   ```bash
   task +OVERDUE export | jq 'sort_by(.due)'
   ```
2. Group by project:
   ```bash
   task +OVERDUE export | jq 'group_by(.project) |
     map({project: .[0].project, count: length})'
   ```
3. Surface the total count, then the top 5 most overdue and the top 5
   highest urgency.
4. Ask the user to triage in one of three buckets per task:
   - **Done**: `task <id> done`
   - **Reschedule**: `task <id> modify due:<date>`
   - **Cancel**: `task <id> delete` (confirm) or `due:` to drop the date

Process in batches the user can hold in their head (5 at a time).

---

## Pattern 5: "What's slipping?"

**User intent:** identify projects or commitments at risk.

**Signals to combine:**

1. Projects with overdue tasks:
   ```bash
   task +OVERDUE export | jq 'group_by(.project) |
     map({project: .[0].project, overdue: length})'
   ```
2. Projects with no recent activity:
   ```bash
   task status:pending export | jq 'group_by(.project) |
     map({project: .[0].project,
          last_modified: max_by(.modified).modified,
          pending_count: length})'
   ```
3. Tasks that have been `+waiting` for over 2 weeks:
   ```bash
   task +waiting modified.before:2weeks-ago export |
     jq 'sort_by(.modified)'
   ```
4. Long-running active tasks:
   ```bash
   task +ACTIVE export | jq '.[] | select(.start) |
     {id, description, started: .start}'
   ```

Synthesize into a short report:

> **At risk:**
> - `work.client_a`: 3 overdue, last touched 9 days ago
> - `personal.health`: 1 overdue (annual checkup, 22 days late)
>
> **Stale waiting:** PROJ-456 review feedback, waiting since Mar 1 (3 weeks)
>
> **Forgotten active:** task 18 has been `+ACTIVE` for 4 days. Was it really
> in progress that whole time?

Recommend concrete next steps. Do not auto-mutate.

---

## Pattern 6: Capture / Quick Add Multiple

**User intent:** "add a bunch of tasks: ..."

**Steps:**

1. Parse the list. If items lack project / due / tags, ask once for shared
   defaults.
2. Add one at a time, capturing the new id from the `Created task N` line:
   ```bash
   task add "Item 1" project:<p> +<tag>
   task add "Item 2" project:<p> +<tag>
   ```
3. Surface a summary list of the created ids and descriptions afterwards
   via:
   ```bash
   task entry.after:1minute-ago list
   ```
4. If any item is ambiguous, stop and ask. Do not guess project or due
   date.

---

## Pattern 7: Focus Block Suggestion

**User intent:** "I have 60 minutes / I'm low on energy / I'm at the
computer".

**Steps:**

1. Translate constraint into filters:
   - "60 minutes" + `estimate` UDA exists ⇒ `estimate.under:60`
   - "low energy" + `energy` UDA exists ⇒ `energy:low` or `+quick`
   - "at the computer" ⇒ `+computer`
   - "errand" / "out of the house" ⇒ `+errand`
   - "phone call" ⇒ `+phone`
2. Combine with `+READY` (= ready to work on, not waiting, not blocked):
   ```bash
   task +READY <constraint filters> limit:5 export | jq 'sort_by(-.urgency)'
   ```
3. Recommend one. Offer to start it.

If the relevant UDA is not defined, fall back to tags only and tell the
user. Suggest defining the UDA in `$TASKRC` if they want better
filtering, but do not modify config without asking.

---

## Pattern 8: Project Health Snapshot

**User intent:** "how is project X going" / "summarize work.client_a".

**Steps:**

```bash
P=work.client_a

task project:$P stats
task project:$P summary
task project:$P status:pending export | jq 'sort_by(-.urgency)'
task project:$P status:completed end.after:1month-ago count
task project:$P +OVERDUE count
task project:$P +waiting export
```

Present:

- Pending count, completed-this-month count, overdue count
- Top 3 by urgency
- Anything `+waiting` (with how long)
- Burndown if the user asks: `task project:$P burndown.weekly`

---

## Pattern 9: Surface Hidden Work

Tasks that are easy to miss. Run periodically when the user asks for a
"sanity check".

```bash
# Tasks without projects
task project: status:pending count

# Tasks without any tags
task tags.none: status:pending count

# Tasks without a due date in projects that usually have them
task project:work.client_a due.none: count

# Recurring templates that have never spawned an instance
task +PARENT mask: list

# Annotated tasks with no recent annotation
task +ANNOTATED modified.before:1month-ago list
```

Surface counts first. Drill in only if the user asks.

---

## Output Style

- Lead with the answer. Save the methodology for after, or skip it.
- Use ids in `[brackets]` so the user can reference them in the next turn.
- Show urgency to one decimal place when ranking.
- For dates, prefer human forms ("today", "Fri", "in 3d") over ISO.
- Never dump more than ~10 task lines without the user asking.
- When recommending an action, give exactly one recommendation, not three
  options. Let the user push back.

## What to Avoid

- Do not invent tasks the user did not ask about.
- Do not auto-start tasks (`task <id> start`) without confirmation, even
  during a daily plan.
- Do not silently re-prioritize. The user's `priority:` reflects their
  intent. If you think a priority is wrong, say so and let them decide.
- Do not treat your urgency analysis as authoritative. The user's lived
  context (meetings, energy, outside obligations) is not in the database.
- Do not run `task synchronize` as part of any review pattern.
