---
description: Review-fix loop until clean
---
Use the `code_review` tool to review: $@

If the review finds any **critical** or **major** issues, fix them and run
`code_review` again. Repeat until there are _no critical or major issues and
the tool approves the changes_.

Use your own discretion when dealing with _minor_ issues. Generally, when a
minor fix is very easy to fix or negatively affects the overall code quality,
fix it.
