---
description: Run a review swarm on a design, implementation, or change
---
Your task is to manage a review swarm for:

$@

This means triggering four parallel `code_review` sessions for the work
described above. You should not do the review yourself, your task is to be the
_editor_ (in a journalistic sense) for the parallel code review sessions. That
means that your task is to pass the correct context to the reviewers and then
to verify their findings and synthesize their output. Your main focus should be
on giving me a clear, understandable, succinct and straight-to-the-point review
based on the findings of the external reviewers.

The four reviewer models you should launch and their focus are:
1. `keystone/claude-opus-5-5` with `medium` thinking. This is the "general
   reviewer". It should focus on correctness, identifying bugs, reviewing how
   the code handles edge cases, checking for dead code, reviewing quality of
   code and quality of comments and docstrings. 
2. `openai-codex/gpt-6.1-sol` with `high` thinking. Same focus as #1
3. `anthropic-vertex/claude-fable-5-1` with `medium` thinking. This is the
   "architect reviewer". It should focus on big picture things: reviewing
   structure of the code, identifying over-engineered and unnecessarily complex
   code, evaluating the maintainability and extensibility of the code, checking
   whether the implementation is consistent with the surrounding codebase, verifying
   whether the code adheres to the project's guidelines and conventions and
   ADRs (if applicable). This is the guy that should evaluate whether the
   implementation is over-engineered or poorly engineered.
4. `openai-codex/gpt-6-astra` with `medium` thinking. Same focus as #3.

To pass the context to the reviewers, use the `task` parameter. To pass them
the focus outlined above, use the `focus` parameter.

After the reviewers are done, verify all their claims and evaluate whether the
severity they assigned each issue is correct. You are allowed to reject or
extend a finding, but that should be based on careful reading of the reviewer's
finding and the code it relates to. In the end, you should synthesize the four
reviews into a cohesive and comprehensive review.

Before you write your review, read the `plain-prose` skill to learn the writing
style you should use. The overall structure of the final review should be:

- Short summary of the implementation reviewed. What was the goal and what part
  of the codebase was changed.
- Critical issues (if any). That means issues that will cause bugs, data loss,
  or crashes in normal usage.
- Major issues (if any). That means issues that will likely cause problems in
  realistic usage, major future maintenance pain points, or improperly
  engineered solutions (too much complexity, poor structure, confusing
  algorithms).
- Minor issues (if any). Essentially "nice to have" items. Style, naming,
  theoretical edge cases.
- Overall verdict. Few sentences with overall assessment. Also state whether
  the changes should be "approved" or "need changes".

Give each issue a number starting with 1, so that we can easily reference each
issue in the subsequent conversation.
