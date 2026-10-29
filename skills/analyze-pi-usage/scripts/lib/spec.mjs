// The sections every report must have, in their intended order. The renderer
// refuses a body that lacks one, so a report cannot ship without, say, the
// community research, however the agent's attention wandered. SKILL.md
// describes what each section must contain; `charts` are the placeholders the
// renderer requires in it.

export const HERO_CHARTS = ["kpis"];

export const REQUIRED_SECTIONS = [
  { id: "overview", label: "Overview", charts: ["daily", "repos", "models", "heatmap"] },
  { id: "verdict", label: "Verdict" },
  { id: "works", label: "What works" },
  { id: "friction", label: "What does not" },
  { id: "since-last", label: "Since the last report", charts: ["carried"] },
  { id: "quick-wins", label: "Quick wins" },
  { id: "go-big", label: "Go big" },
  { id: "community", label: "From the community" },
  { id: "method", label: "Method" },
];
