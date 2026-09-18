---
description: Implement a Jira ticket end to end and deliver a merge request
argument-hint: "<TICKET-KEY> [extra instructions]"
---
Please implement the Jira ticket $1 end to end. You are explicitly allowed to
create branches, commit, push, and open a merge request. The deliverable is a
merge request for $1 with a green pipeline.

Before writing code: load the `jira` and `glab` skills, read the ticket and
the code it touches, and ask me anything unclear about scope. Make sure you
understand the ticket fully. It's better to ask me than to make assumptions.

Ground rules:
- Branch from `main`. Commits and the MR title follow Conventional Commits
  in the house style you see in `git log`: one-line subject, a body of one
  or two short paragraphs or a short list, never more.
- Comments and docstrings follow AGENTS.md: sparse, why not what. Before the
  review loop, audit every comment you added and delete anything a reader
  can infer from the code.
- Write all prose (MR description, commit bodies) yourself using the
  `plain-prose` skill. Do not route it through `annotate_text`.
- Verify per AGENTS.md (pyright, ruff, type-check, tests). If the local
  test harness is unavailable, say so once and rely on CI instead of
  fighting the environment.
- When done, run `code_review` with model `keystone/claude-sonnet-5` and
  high thinking. Fix critical and major issues, use your own judgment on
  minor ones, repeat until the reviewer approves and there are no more
  critical or major issues.
- After opening the MR, watch the pipeline and fix failures until it is
  green. Report the MR URL, what landed, and anything you deferred.
- Once you open the MR, don't overwrite existing commits with force push. Since
  we are always using squash commits for merging the MR to `main` anyway, it is
  better to leave honest commit history as part of the MR.

Extra instructions: ${@:2}
