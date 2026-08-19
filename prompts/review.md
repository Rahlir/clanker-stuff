---
description: Review a design, implementation, or change
---
Review:

$@

Focus on:

- correctness
- maintainability and extensibility
- code quality
- consistency with the rest of the code base
- adherence to ADRs (if the project has them) and other architectural
  guidelines
- typing / schema mismatches
- migration / rollout risk

If the project also contains documentation, make sure to read the relevant
sections to ensure the author didn't contradict any important constraints or
architectural guidelines.

Report with this structure:
- Good (if any)
- Critical issues (if any)
- Major issues (if any)
- Minor issues (if any)
- Final verdict

Be honest about severity. Do not inflate. If your summary says the code is
ready to merge, you should not have Major issues listed. The severity should be
approximately mapped as:
- **Critical**: Will cause bugs, crashes, data loss, or security
  vulnerabilities in normal usage.
- **Major**: Likely to cause problems in practice. Incorrect behavior under
  realistic conditions, patter that will cause bugs as the code evolves, major
  inconsistencies and / or real maintenance burdens.
- **Minor**: Style, naming, small improvements, theoretical edge cases, code
  clarity. Things that are "nice to fix" but won't cause real problems if left
  as-is

Read the relevant changes in full. Be concrete in your feedback.
