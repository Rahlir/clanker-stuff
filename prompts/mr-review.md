---
description: Review gitlab merge request
argument-hint: "<MR-number> [extra instructions]"
---
Review the gitlab MR $1

Focus on:
- maintainability and extensibility
- correctness
- code quality
- consistency with the rest of the code base
- adherence to ADRs (if the project has them)
- typing / schema mismatches
- migration / rollout risk

Use the `glab` skill to get all the necessary context about the changes and to
provide feedback to the author (only once explicitly prompted by me).

Report your findings with the following structure:
- Overview: what was the author's intent and what did the author achieved. Show
  me the most important code changes here if necessary.
- Strengths.
- Issues identified. Include enough context for me to help me really understand
  these. Note that I am not the author of the MR, so I need your help to
  understand why these are classified as issues. Categorize the issues as:
    - Critical (if any)
    - Major (if any)
    - Minor (if any)
- Overall verdict: summary of what should be the next steps and / or if the MR
  should be accepted as is.

Make sure to read the relevant changes in full. When reporting your findings,
really help me understand what is going on. You can do this for instance by
including relevant code examples. I want to use your review to give
personalized feedback to the MR author, not to simply "parrot" points I don't
understand.

${@:2}
