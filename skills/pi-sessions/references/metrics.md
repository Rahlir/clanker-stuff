# Metric definitions

How piss turns session logs into numbers. Every command computes them the same
way, so two outputs are comparable when their windows are.

## Corpus range and windows

| Term | Definition |
|------|------------|
| Corpus range | `piss build --since X --until Y` loads a session created before Y whose last user or assistant message, or last file write, is at or after X (the file time catches sessions resumed only for `!` commands or summaries). All of a loaded session's entries are stored. |
| Window | `--since/--until` on a query command. An entry belongs to the window when its timestamp falls in `[since, until)`. A relative `--since` (30d) counts back from `--until`, and `--until built` is the end of the corpus's range, so `--since 30d --until built` is the same window for every command run on that corpus. A window may not start before the corpus range, nor end after the `--until` of a historical build (one built with an explicit `--until`, recorded in `meta.open_ended`); a command's default window counts back from that end. |
| Previous window | `--compare`: the window right before, of the same length. A window of whole local days steps back in calendar days, so across a daylight-saving change both are 30 days (one an hour longer) and a `--since 60d` corpus covers them. |
| Excluded session | A build leaves out the session that runs it (`--include-self` keeps it); the corpus records which in `meta.excluded_session`, and report sidecars copy it. |
| Work | A prompt, an assistant turn, a tool result, a `!` shell command, or a summary (compaction, branch summary, with or without usage of its own). Housekeeping is everything else: renames, labels, model and thinking changes, extension state and injected messages (memory on resume), system prompt updates, context edits. pi's `usage` entries (cache warming pings every few minutes of idle) are spend only, neither work nor housekeeping. Reopening or renaming an old session writes housekeeping only. |
| Session active in a window | Has work in the window. A session resumed over weeks counts in every window it worked in, with only its in-window activity; reopening it without working does not count. |
| Last activity | The session's latest work entry. |
| Forks, clones and imports | pi copies the parent's entries (same id, timestamp and usage) into the new session. Entries older than the session itself are those copies, and each counts once across the corpus: in the original, or in the oldest surviving copy when the original was deleted. `/import` copies a whole file (same session id): a second file with an id already seen counts only the entries added after the copy. Skipped copies are listed in the `inherited` table; `show` still displays them, marked `[inherited]`. |

Usage reports made before piss counted sessions by creation date, so their
numbers are not directly comparable: use `facts --compare` for trends.

## Cost

Every entry counts, including abandoned branches: that money was spent.

| Source (`usage_events.source`) | What it is |
|------|------------|
| `assistant` | The main agent's own turns (`message.usage`). |
| `usage:<kind>` | pi usage entries, such as `usage:cache_warm`. |
| `compaction`, `branch_summary` | The LLM call that wrote the summary. |
| `tool_result` | A tool's nested model calls reported as the result's top-level `usage` (code_review since clanker-stuff 6df6f15). |
| `review_legacy` | code_review receipts from before that fix: `details.usage` on a finished job's result (`details.mode` `review` or `status`, not still running), only before 2026-10-20 15:21 UTC and before the session's first top-level-usage code_review result. The old extension returned the same receipt on every await or status call, so a receipt identical to one already counted for that job id (same model, tokens and cost) is skipped and counted as repeated in coverage. A new `started` receipt resets its job id, because ids restart at `cr-1` after a reload. After the fix date, such a receipt for a job never delivered with top-level usage comes from an extension loaded before the fix: its spend is not counted, and coverage warns how many there were. |

- **Recorded vs corrected.** `cost_recorded` is what the log says.
  `cost_corrected` applies the price corrections in
  `assets/price-corrections.json` when the recorded cost matches the wrong rate
  table (one differing token bucket decides; for legacy receipts, which only
  have a total, the totals must differ by more than 2%). Matching on rates,
  not dates, handles a late `/reload` after a rate fix. Report corrected cost.
- **Provider attribution** (`provider_source`): `recorded` in the entry;
  `job` from the code_review "started" result of the same job; `args` from
  the call's `model` argument; `session` for summaries, which take the
  session's current model; `inferred` as the provider most often seen
  answering with that model across the corpus.
- **Spend buckets in `facts`:** main (assistant), reviews (code_review
  tools), tools (other tools reporting usage), other (summaries, cache
  warming).

## Active time

Entries of a session are sorted by time and split into stretches wherever
30 minutes or more pass without an entry. A stretch counts in full if it
contains work and not at all otherwise: opening a session, picking a model
and typing the first prompt all count; reopening an old session that only
re-injects memory, switches models or gets renamed does not.

- A gap is **your time** when the next work entry is yours (a prompt, a `!`
  command, or the result of an interactive tool) and **agent time** when it
  is an assistant turn or any other tool result. Interactive tools are the ones
  that wait for you in a UI, listed in `assets/interactive-tools.json`:
  `questionnaire`, `annotate_text`, `draft_mr_note`, `post_mr_review`.
  Looking ahead matters: extensions write settings markers, memory and system
  prompt updates the moment you submit, so your typing gap ends at one of
  those. Housekeeping after the last work of a stretch (renaming the session)
  goes by its own side.
- pi's `usage` entries are left off the timeline: a cache warming ping is not
  activity, and pings every few minutes would otherwise bridge a break into
  one long stretch.
- Gaps are bucketed by the UTC hour they end in, and a bucket counts in the
  window that contains the start of its hour, so a window's edges are exact to
  within an hour and adjacent windows (`--compare`) never share a bucket.
  Local days and weeks (Monday start) come from the machine's timezone at
  query time.
- It measures attention, not hours worked; parallel sessions both count.
- A gap of 30 minutes or more ends a stretch even inside a tool run, so a tool
  running that long adds no time. In practice that is an interactive UI left
  open (`annotate_text`, `questionnaire`), where the break is real.

## Repos, prompts, skills, tickets

- **Repo:** the main checkout of the session's working directory
  (`git rev-parse --git-common-dir`, so worktrees group together); directories
  that are gone or not in git stand for themselves.
- **Template prompts:** matched against every committed version of each prompt
  template pi loads from user configuration (not project-local `.pi/prompts`),
  including templates since deleted from those dirs, recovered from git history.
  `template_match` is `full` when the template text was recovered and `args`
  holds exactly what the user added, `prefix` when only the first line matched
  (an uncommitted template version; `args` unknown), and `pattern` for prompts
  an extension composes, listed in `assets/prompt-patterns.json`.
- **Skill invocations** (`/skill:name`) are parsed with pi's own skill-block
  parser. **Skills loaded** in `facts` counts the agent's reads of a
  `SKILL.md`, which is how most skills get used.
- **Ticket mentions:** keys of the configured Jira projects (the jira CLI's
  default project unless `build --jira-project` says otherwise) in what the
  user wrote, in tool-call arguments, and in session names, one row per entry
  with that entry's time. Template and skill bodies are skipped; for a prompt
  sent with an uncommitted template version, the lines found in no committed
  version are scanned.
- **Tags** label whole sessions. A session that spans weeks keeps one label,
  and `facts` puts all of its in-window activity under it.

## Outcomes

- **Commits:** authored by the repo's `git config user.email` and committed
  in the window (committer date, so a squash merge counts when it landed and a
  rebased commit when it was rebased), from local refs only (piss never
  fetches). "Landed" means reachable from `origin/HEAD` (or main/master); the
  fetch age is printed. git's `--until` includes its end, so piss passes the
  last second before the window's end.
- **Merge requests:** glab, authored by you, merged in the window by
  `merged_at`, plus every currently open one. GitHub remotes are skipped.
- **Not checked is not zero:** a repo whose commits or MRs could not be read
  (git or glab failing, no default branch, a GitHub remote, no git email)
  carries a note instead of counts. Repos past `--max-repos` and worked-in
  directories that no longer exist count in `repos_not_checked`; directories
  outside git are named in the notes. Reports show all of them as not
  checked, never as zero.
- **Jira windows** go to Jira at minute precision in this machine's timezone,
  and JQL reads them in the Jira profile's timezone: a profile in another zone
  shifts the edges by the difference.
- **Jira:** current status of every ticket mentioned in the window, renames
  included (a long session's old mentions do not carry into later windows).
  Each ticket shows the in-window time and cost of the sessions that mentioned
  it there; a session mentioning several tickets counts toward each. Keys Jira
  does not return are listed in the notes. Three more lists cover the
  configured projects:

  | List | Query | Blind spot |
  |------|-------|------------|
  | Your tickets resolved | Assigned to you now, resolved in the window by anyone | Goes by the current assignee, so reassigning a resolved ticket moves it |
  | Tickets you closed | The resolution changed from empty to set by you in the window, any assignee | Counts closing teammates' tickets; misses resolutions an automation account makes (an integration closing on merge) |
  | Tickets you created | `creator` is you (not the editable reporter), created in the window | |

  The gap between the first two is a finding in itself: closing others' work
  is not delivering your own.

## Not covered

- code_review reviewer transcripts: reviewers run with `--no-session`; only
  their spend is visible.
- Background reviews never collected and killed at session shutdown: their
  spend is lost.
- Sessions in a custom session directory (`--session-dir`,
  `PI_CODING_AGENT_SESSION_DIR`), and work done outside pi.
- Sessions in the oldest log format (v1) get fresh entry ids from pi's
  migration on every read: their `entry_id`s do not survive a rebuild, and an
  imported copy of one counts twice.
