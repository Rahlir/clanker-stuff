---
description: Debug an issue within an application
---
Debug the following issue in this application:

$@

Follow these steps:
1. Explore the relevant source files to understand how to replicate the bug and
   what source code files might be involved in this issue.
2. Replicate the bug in the local environment. First determine which local
   service or services are actually required to reproduce the issue, and prefer
   the narrowest setup that satisfies the task. Always read and follow the
   repository-specific AGENTS.md / CLAUDE.md instructions before starting any
   runtime. For a backend application, this typically involves calling the
   local dev server and identifying errors or incorrect behavior. For a
   frontend application, this typically involves starting only the local
   frontend and using the `browser-tools` skill to replicate the workflow in a
   browser. If the project documents that the local frontend can use a remote
   or dev backend, do not start a local backend unless it is actually required
   to reproduce the issue. Do not infer that a local backend is required only
   from dev proxy configuration. When interacting with the local environment,
   try to be as un-invasive as possible. While this is a local environment,
   there might be important data that shouldn't be deleted or heavily
   modified.
3. Once you replicate the bug, explore the relevant code in detail and identify
   the source of the bug.
4. Once you identified what is wrong, provide a detailed explanation of why
   this bug happens and suggest the best way to fix it. If there are multiple
   valid ways to fix this, present more options, but don't suggest more than 3
   options.

If you have trouble understanding the bug the user is describing, ask! Do not
make assumptions.

## Constraints

- Do not edit any source code yet
- Always use the appropriate local application entrypoint to investigate the
  issue. Start or connect only to the local service or services actually needed
  for reproduction.
- When task instructions and repository instructions appear to conflict,
  prefer the most specific repository guidance that still satisfies the task.
- Don't install new dependencies to this project
