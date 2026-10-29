// Shared test data. Not a test file itself, so importing it from several
// suites does not run any test twice.

// The shape `piss facts --json` prints, reduced to what the charts read.
export const FACTS = {
  window: { since: "2026-10-03T00:00:00.000Z", until: "2026-10-10T00:00:00.000Z", days: 7 },
  overview: {
    sessions: 12,
    sessions_started: 9,
    repos: 2,
    prompts: 80,
    template_prompts: 10,
    user_s: 7200,
    agent_s: 10800,
    cost: { main: 40, reviews: 8, tools: 0, other: 2, total: 50, recorded: 55 },
  },
  models: [
    { model: "keystone/claude-opus-5-5", turns: 300, main: 30, reviews: 5, tools: 0, other: 1, total: 36 },
    { model: "openai-codex/gpt-6-astra", turns: 20, main: 10, reviews: 3, tools: 0, other: 1, total: 14 },
  ],
  repos: [
    { repo: "/work/nba2", sessions: 8, prompts: 50, user_s: 5000, agent_s: 7000, cost: 30 },
    { repo: "/work/<odd>", sessions: 4, prompts: 30, user_s: 2200, agent_s: 3800, cost: 20 },
  ],
  weeks: [
    { week: "2026-09-28", sessions: 5, prompts: 30, user_s: 3000, agent_s: 4000, cost: 20 },
    { week: "2026-10-05", sessions: 9, prompts: 50, user_s: 4200, agent_s: 6800, cost: 30 },
  ],
  days: [
    { day: "2026-10-05", sessions: 3, prompts: 20, user_s: 3600, agent_s: 3600, cost: 12 },
    { day: "2026-10-07", sessions: 2, prompts: 10, user_s: 1800, agent_s: 5400, cost: 9 },
  ],
  heatmap: [
    { weekday: 1, hour: 9, user_s: 3600, agent_s: 3600 },
    { weekday: 3, hour: 14, user_s: 900, agent_s: 900 },
  ],
};

// Earlier reports as loadHistory returns them: the 13 Oct report holding
// exactly the three recommendations assets/example-findings.json follows up.
export const HISTORY = [
  {
    name: "pi-session-report-2026-10-13.html",
    key: "2026-10-13",
    date: "2026-10-13",
    variant: null,
    sidecar: {
      date: "2026-10-13",
      backfilled: true,
      recommendations: [
        {
          id: "give-investigations-an-exit",
          kind: "quick",
          title: "Give investigations an exit",
          summary: "Every investigation ends with its follow-ups (fix, ticket, note, or none).",
        },
        {
          id: "quick-short-squash",
          kind: "quick",
          title: "Make squash messages short by default",
          summary: "Cap the squash body at 6 lines.",
        },
        {
          id: "decisions-captured-as-you-make-them",
          kind: "big",
          title: "Decisions captured as you make them",
          summary: "Propose memory lines or ADR amendments from your rulings at the end of a design session.",
        },
      ],
    },
  },
];
