Focus your review on:

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

Make sure the design and the "shape" of the implementation makes sense. Assume
that most of the code was written with AI. Hence, our task is to review that
the design is clean and easy to understand. People and agents need to be able
to understand the code even months in the future. Specific patterns to watch
out for:

- unnecessary complexity
- unnecessary abstractions
- too many descriptive comments and docstrings
- violations of YAGNI principle

Read the relevant changes in full. The user is not the author of the MR, so
explain each issue well enough that they can give personalized, informed
feedback to the author rather than parroting points they don't understand.
Include concrete code references where they help.
