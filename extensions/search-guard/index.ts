/**
 * search-guard
 *
 * Deterministically blocks two search-command mistakes that prose in AGENTS.md
 * fails to prevent (they are reflexive, model-specific `grep` muscle memory):
 *
 *   1. `rg -r` / `rg -rn` / `rg -rln` ...  In ripgrep `-r` is `--replace`, not
 *      "recursive" (rg already recurses). `rg -rn "pat" path` parses as
 *      `--replace=n`: it silently rewrites every match to the literal "n" and
 *      still prints file paths, so the corrupted output looks plausible and the
 *      agent reasons over garbage. This is the dangerous one.
 *   2. `grep -r` / `grep -R` recursive tree search, where `rg` is preferred
 *      (recurses by default, honors .gitignore). Trivially toggled below.
 *
 * Why a hook instead of an AGENTS.md rule: the mistake happens at the instant
 * the model types the flag, on autopilot, regardless of how far back the rule
 * sits in context. Blocking (not silently rewriting) is safe: command semantics
 * never change under the agent, and the block reason teaches the correct form,
 * so the agent immediately re-issues it right. Models that never make the
 * mistake (e.g. GPT) never trigger it, so the hook is free for them.
 *
 * Escape hatch: genuine substitution still works via the long form
 * `rg --replace ...`; the guard only rejects the short `-r`/`-R` clusters.
 *
 * Detection uses the shared shell-approximate tokenizer in
 * `lib/shell-tokens.ts` (quotes, line continuations, command boundaries,
 * redirections, heredoc bodies), plus local handling of env-assignment and
 * wrapper prefixes (sudo/env/xargs/... with their own flags), the `--`
 * end-of-options marker, and short-flag clusters with attached values.
 */

import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { basename, segmentize, tokenize, type Tok } from "../../lib/shell-tokens.ts";

// Toggle the two checks independently. Flip either to false to disable.
const CHECK_RG_REPLACE = true;
const CHECK_GREP_RECURSIVE = true;

// Short flags that consume a value (attached in the same cluster or as the next
// token). Once one is hit, the rest of the cluster is its value, not more flags.
// `r` is intentionally omitted for rg: it is a trigger (see R_TRIGGERS), and we
// must flag it before it can be treated as a value-consuming option.
const RG_VALUE_FLAGS = new Set(["A", "B", "C", "M", "m", "e", "f", "g", "t", "T"]);
const GREP_VALUE_FLAGS = new Set(["A", "B", "C", "m", "e", "f", "d", "D"]);
const R_TRIGGERS = new Set(["r", "R"]);
const WRAPPERS = new Set([
  "env",
  "command",
  "builtin",
  "sudo",
  "doas",
  "time",
  "nice",
  "ionice",
  "stdbuf",
  "xargs",
]);

function isSearchProgram(t: Tok): boolean {
  if (t.quoted || t.redir) return false;
  const b = basename(t.text);
  return b === "rg" || b === "grep";
}

/**
 * Inspect one short-flag cluster (the chars after a single leading '-').
 * `trigger` is set if an r/R appears as an actual flag letter. `skipNext` is
 * set when the last flag consumes the following token as its value, so the
 * caller can skip it (e.g. `-e -r` means `-r` is a pattern, not a flag).
 */
function scanCluster(chars: string, valueFlags: Set<string>): { trigger: boolean; skipNext: boolean } {
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (R_TRIGGERS.has(c)) return { trigger: true, skipNext: false };
    if (valueFlags.has(c)) {
      const hasAttached = i < chars.length - 1;
      return { trigger: false, skipNext: !hasAttached };
    }
  }
  return { trigger: false, skipNext: false };
}


/**
 * Index of the search program (`rg`/`grep`) in a segment, or -1 if none.
 *
 * Skips leading redirections, env assignments, and wrapper prefixes. Wrappers
 * (`sudo -u root`, `env -i`, `nice -n 10`, `xargs -0`, ...) carry their own
 * flags and values that we cannot parse precisely, so once a wrapper is seen we
 * anchor on the first rg/grep token in the segment instead of assuming a fixed
 * program position.
 */
function searchProgramIndex(seg: Tok[]): number {
  let p = 0;
  let sawWrapper = false;
  while (p < seg.length) {
    const t = seg[p];
    if (t.redir) {
      p += t.redir === "file" ? 2 : 1; // skip redirect (+ its target for file redirects)
      continue;
    }
    if (!t.quoted && /^\w+=/.test(t.text)) {
      p++;
      continue;
    }
    if (!t.quoted && WRAPPERS.has(basename(t.text))) {
      p++;
      sawWrapper = true;
      continue;
    }
    break;
  }
  if (!sawWrapper) {
    return p < seg.length && isSearchProgram(seg[p]) ? p : -1;
  }
  for (let k = p; k < seg.length; k++) {
    if (isSearchProgram(seg[k])) return k;
  }
  return -1;
}

/** True if the segment passes a short `-r`/`-R` flag to its program. */
function hasRFlag(seg: Tok[], progIndex: number, valueFlags: Set<string>): boolean {
  for (let k = progIndex + 1; k < seg.length; k++) {
    const t = seg[k];
    if (t.redir) {
      if (t.redir === "file") k++; // skip the redirect target too
      continue;
    }
    if (t.quoted) continue;
    if (t.text === "--") break;
    if (t.text.startsWith("--")) continue;
    if (!/^-[A-Za-z0-9]/.test(t.text)) continue;
    const res = scanCluster(t.text.slice(1), valueFlags);
    if (res.trigger) return true;
    if (res.skipNext) k++;
  }
  return false;
}

/** True if the segment passes long-form recursive flags to grep. */
function hasLongRecursive(seg: Tok[], progIndex: number): boolean {
  for (let k = progIndex + 1; k < seg.length; k++) {
    const t = seg[k];
    if (t.quoted || t.redir) continue;
    if (t.text === "--") break;
    if (t.text === "--recursive" || t.text === "--dereference-recursive") return true;
  }
  return false;
}

const RG_REASON =
  "In ripgrep, -r/-R is --replace (it rewrites matched text), not recursive; " +
  "rg already recurses. Re-run without the r (e.g. `rg -n` / `rg -l`). " +
  "If you truly want substitution, pass --replace explicitly.";

const GREP_REASON =
  "Prefer ripgrep for recursive search: replace `grep -r/-R ...` with `rg ...` " +
  "(rg recurses by default and honors .gitignore). Use grep only to filter " +
  "piped input or scan a single named file.";

export type SearchGuardVerdict = { block: true; reason: string } | { block: false };

/** Pure analysis, exported for testing. Returns the first offending verdict. */
export function analyzeCommand(command: string): SearchGuardVerdict {
  const segments = segmentize(tokenize(command));
  for (const seg of segments) {
    const p = searchProgramIndex(seg);
    if (p < 0) continue;
    const prog = basename(seg[p].text);
    if (prog === "rg" && CHECK_RG_REPLACE) {
      if (hasRFlag(seg, p, RG_VALUE_FLAGS)) return { block: true, reason: RG_REASON };
    } else if (prog === "grep" && CHECK_GREP_RECURSIVE) {
      if (hasRFlag(seg, p, GREP_VALUE_FLAGS) || hasLongRecursive(seg, p)) {
        return { block: true, reason: GREP_REASON };
      }
    }
  }
  return { block: false };
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return undefined;
    const command = event.input.command;
    if (!command) return undefined;

    const verdict = analyzeCommand(command);
    if (!verdict.block) return undefined;

    if (ctx.hasUI) {
      ctx.ui.notify("search-guard blocked a bad search flag (see tool result)", "warning");
    }
    return { block: true, reason: verdict.reason };
  });
}
