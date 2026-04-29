---
description: Implement a feature, then review-fix loop until clean
argument-hint: "<task>"
---
Implement:

$@

After implementation is complete, use the `code_review` tool to review your
changes. If the review finds any **critical** or **major** issues, fix them
and run `code_review` again. Repeat until no critical or major issues remain
and the `code_review` tool approves the changes.

Use your own discretion when dealing with _Minor_ issues. Generally, when a
minor fix is very easy to fix or negatively affects the overall code quality,
fix it.
