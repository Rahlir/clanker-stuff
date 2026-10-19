// Write policy for issue transitions and comments. Pure: decides from the
// issue as fetched, so the dry run and the real write apply the same rules.

// Only dispositions an agent may propose for a human to approve. Others are
// left out on purpose: `resolve` is reopened by the next analysis if the
// issue persists, `wontfix` is legacy, and `confirm`/`reopen` change nothing
// worth automating.
const TRANSITIONS = {
  accept: { name: "accept", status: "ACCEPTED" },
  falsepositive: { name: "falsepositive", status: "FALSE_POSITIVE" },
  "false-positive": { name: "falsepositive", status: "FALSE_POSITIVE" },
};

// Long enough that "ok" or "fp" cannot pass as the recorded reason.
export const MIN_REASON = 10;

export function resolveTransition(name) {
  return TRANSITIONS[String(name ?? "").toLowerCase()] ?? null;
}

// Security findings stay with humans: dismissing one is a security decision.
// Checked on impacts and type, because recent SonarQube releases report
// former hotspot rules as ordinary vulnerabilities.
export function isSecurityFinding(issue) {
  return (
    issue.impacts.some((i) => i.softwareQuality === "SECURITY") ||
    issue.type === "VULNERABILITY" ||
    issue.type === "SECURITY_HOTSPOT"
  );
}

export function commentProblems(text) {
  const t = String(text ?? "").trim();
  if (!t) return ["the comment is empty"];
  if (t.length < MIN_REASON) return [`the comment is too short to record a reason (at least ${MIN_REASON} characters)`];
  return [];
}

// Comments do not change an issue's status, so they are allowed on security
// findings too; only the text and Sonar's own permission are checked.
export function commentWriteProblems(issue, text) {
  const problems = commentProblems(text);
  if (!(issue.actions ?? []).includes("comment")) problems.push("Sonar does not let you comment on this issue");
  return problems;
}

// Returns every reason the transition must not happen (empty = allowed).
// `issue.transitions` is what Sonar offers this user for this issue, which
// already accounts for permissions and the current status.
export function transitionProblems(issue, transitionName, comment) {
  const problems = [];
  const t = resolveTransition(transitionName);
  if (!t) problems.push(`unsupported transition "${transitionName}"; use accept or falsepositive`);
  if (isSecurityFinding(issue))
    problems.push("this is a security finding; a human has to review and dismiss it in the Sonar UI");
  problems.push(...commentProblems(comment));
  if (t && !(issue.transitions ?? []).includes(t.name)) {
    const offered = issue.transitions?.length ? issue.transitions.join(", ") : "none";
    problems.push(`Sonar does not offer "${t.name}" for this issue (status ${issue.status}; offered: ${offered})`);
  }
  return problems;
}
