---
name: pi-sessions
description: Query the user's pi session logs (~/.pi/agent/sessions) through a prebuilt corpus - what was worked on when, time and spend by model, repo or provider, transcripts of past sessions, finding a session by what was said in it, outcomes (commits, merge requests, Jira tickets), and tool-call forensics. Use when the user asks about their pi history, usage, costs, time spent, or a past session, or when designing pi tooling from real session evidence.
compatibility: Requires Node.js 22.19+ (node:sqlite), git, and pi installed globally (the pi on PATH reads the logs). glab and the jira CLI are optional, for outcomes.
---

# pi sessions

Everything goes through `scripts/piss.mjs`. Run it by its absolute path from
any directory; the examples below shorten it to `piss`. It reads session logs
through the installed pi, never writes to them, and answers from a corpus at
`~/.cache/pi-clanker/pi-sessions/corpus.db`.

## Build when needed

The corpus persists between runs, and a build re-reads every session in its
range from scratch, so build only when:

- a command says there is no corpus, or that a different piss version built it;
- the question is about recent activity (today, the last hours) and the header
  says the corpus is stale or that activity after the build is missing;
- a command refuses a window older than the corpus (it prints the build command).

A skill whose workflow builds first (analyze-pi-usage does) overrides this
list: build before any other command.

```bash
scripts/piss.mjs build              # sessions active in the last 90 days, ~5 s
scripts/piss.mjs build --since all  # all history, for older questions (~10 s)
```

A build replaces the corpus: a shorter range drops the older sessions, and
another session's build changes the numbers under you. For a long analysis,
build your own with `--corpus <file>` and pass the same `--corpus` to every
later command (it works on all of them; `PISS_CORPUS` does the same).

To keep numbers consistent across commands run minutes apart, end windows at
the build: `--since 30d --until built` is the 30 days the corpus ends with, for
every command. A relative `--since` always counts back from `--until`.

Every command starts with the corpus age, its coverage, and the window.
`coverage WARN` means sessions or entries were skipped: say so whenever you
report numbers from that corpus.

## Commands

| Need | Command |
|------|---------|
| Standard numbers for a window | `piss facts --since 30d [--compare] [--repo nba2]` |
| What the user asked, in their words | `piss prompts --since 7d [--free-text] [--session REF] [--grep RE]` |
| One session's transcript | `piss show REF [--level full] [--from N] [--entry ID] [--context]` |
| Find a session by what was said | `piss find WORDS... [--since all]` |
| Commits, merge requests, Jira tickets | `piss outcomes --since 30d` |
| Label sessions by kind of work | `piss tag REF LABEL ...`, `piss tag --untagged`, `piss tag --list` |
| Anything else | `piss sql "SELECT ..."` |

`piss <command> --help` lists every option. Outputs are paged and capped; the
last line says how to get the next page. `--json` on `facts` and `outcomes`
is for scripts and charts, not for reading.

Refs such as `S261013-1258` are the session's local creation time
(YYMMDD-HHMM, then b, c, ... within one minute). They survive rebuilds (see
references/data-model.md for the rare exceptions); cite them so every claim
can be traced back to its session.

## Fidelity rules

1. **Numbers come from piss.** Do not re-derive counts, costs or time from raw
   logs: piss applies price corrections, reviewer spend and abandoned branches
   that ad-hoc parsing misses, and it applies them the same way every time.
2. **Claims about what happened need a transcript.** Aggregates say where to
   look; `piss show` says what happened. Read a session before you
   characterize it, and cite its ref.
3. **piss gives facts, you give judgment.** It never classifies work or judges
   outcomes. Decide what kind of work a session was by reading it, then record
   it with `piss tag` so `facts` can group by it.
4. **Report coverage.** Quote the corpus line when numbers leave the
   conversation, and mention any WARN.
5. **The corpus is an index, not a gate.** When a question needs something piss
   does not expose, read the raw JSONL (the session path is in `piss show`
   output), then name the gap in your answer so piss can grow a command for it.

## Task patterns

```bash
# What did I do on 14 October? (also the base for daily notes and timesheets)
piss facts --since 2026-10-14 --until 2026-10-15
piss prompts --since 2026-10-14 --until 2026-10-15

# How much did I spend on anthropic-vertex in May?
piss build --since 2026-05-01
piss sql "SELECT model, round(sum(cost_corrected), 2) usd FROM usage_events
          WHERE provider = 'anthropic-vertex' AND date(ts, 'localtime') BETWEEN '2026-05-01' AND '2026-05-31' GROUP BY model"

# Where is the session in which we discussed X?
piss find ProductStore voucherpro-engine --since all   # needs a corpus built --since all

# Which bash failures repeat? (guard blocks show up here with their reason)
piss sql "SELECT substr(result_text, 1, 80) error, count(*) n FROM tool_calls
          WHERE name = 'bash' AND is_error = 1 GROUP BY 1 ORDER BY n DESC" --limit 10
```

## References

- Before quoting numbers in anything durable (a report, ticket, or timesheet),
  read [references/metrics.md](references/metrics.md): how windows, cost,
  active time, attribution and outcomes are defined, and what is not covered.
- Before writing SQL for `piss sql`, read
  [references/data-model.md](references/data-model.md) for the tables and
  columns.
