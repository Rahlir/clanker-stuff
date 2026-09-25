---
description: One code_review for fresh-eyes perspective on the MR
argument-hint: "[provider/model] [thinking]"
---
Please run one `code_review` as a fresh pair of eyes on the current state of
the work in this MR. Reviewer model: ${1:-keystone/claude-opus-5-5} with
${2:-medium} thinking. Pass it the information on the current state of the MR -
the review we already made and the changes the author did based on our
feedback. Keep this concise and on point - I don't want you to clutter the
reviewer's context.

When the review is ready, go through the findings the fresh eyes reviewer
found. Give me a one line assessment on each answering the following questions:
- Do you agree or disagree with this issue and why?
- Is it worth registering this and triggering another round of review for this?
