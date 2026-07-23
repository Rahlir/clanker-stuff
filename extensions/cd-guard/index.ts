/**
 * cd-guard
 *
 * Deterministically blocks a `cd` that lands back in the working directory the
 * bash call already started in - a pure no-op. Every pi bash call runs in a
 * fresh subprocess that starts in the session's cwd, so `cd <cwd> && cmd`
 * (also `cd .`, `cd "$PWD"`) changes nothing; it only gets recorded in the
 * transcript forever and re-sent on every later turn.
 *
 * Scope: only the no-op is blocked. A top-level `cd <other-dir> && cmd` is left
 * alone - inside pi's isolated subprocess it is functionally identical to the
 * subshell form `(cd <other-dir> && cmd)` (neither persists to the next call),
 * so forcing the subshell would cost retries without preventing anything.
 *
 * Why a hook instead of a prompt rule: the redundant prefix is reflexive muscle
 * memory that fires regardless of how prominently a rule sits in context.
 * Blocking with an instructive reason costs one retry and teaches the correct
 * form.
 *
 * Detection uses the shared shell-approximate tokenizer in
 * `lib/shell-tokens.ts`, so `cd` inside quotes, heredoc bodies, `$(...)`, or
 * `(...)` never triggers. When the target cannot be resolved statically
 * (variables, `cd -`), the guard cannot prove a no-op and lets it through.
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { segmentize, tokenize, type Tok } from "../../lib/shell-tokens.ts";

// Single on/off switch for the guard. Flip to false to disable.
const CHECK_CD_NOOP = true; // cd that resolves back to the cwd (pure no-op)

/** Canonicalize a path for comparison; falls back when it does not exist. */
function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * The target token of a `cd` in this segment, or null when the segment is not
 * a top-level `cd`. A wrapped `target` of null is a bare `cd` (goes to $HOME),
 * distinct from the outer null that means "not a cd".
 */
function cdTarget(seg: Tok[]): { target: Tok | null } | null {
  const first = seg[0];
  if (first.quoted || first.redir || first.depth > 0) return null;
  // Skip env-assignment prefixes (`FOO=bar cd ...`).
  let p = 0;
  while (p < seg.length && !seg[p].quoted && !seg[p].redir && /^\w+=/.test(seg[p].text)) p++;
  if (p >= seg.length || seg[p].quoted || seg[p].redir || seg[p].text !== "cd") return null;
  for (let k = p + 1; k < seg.length; k++) {
    const t = seg[k];
    if (t.redir) {
      if (t.redir === "file") k++;
      continue;
    }
    // cd's own flags (-L, -P, -e, -@); a lone `-` means $OLDPWD, not a flag.
    if (!t.quoted && /^-[LPe@]+$/.test(t.text)) continue;
    return { target: t };
  }
  return { target: null };
}

/**
 * Whether a top-level `cd` lands back in `cwd`, making it a pure no-op. When
 * the target is not statically resolvable, returns false: the guard cannot
 * prove a no-op, so it leaves the command alone.
 */
function isNoop(target: Tok | null, cwd: string): boolean {
  let text: string;
  if (target === null) {
    text = homedir(); // bare `cd`
  } else {
    text = target.text;
    // The tokenizer does not preserve quote style, so `cd "$PWD"` (expands,
    // no-op) and the pathological `cd '$PWD'` (literal dirname) look the same
    // here. Treat both as the common expanding form.
    if (text === "$PWD" || text === "${PWD}") return true;
    // Unexpanded variables, command substitution remnants, or `-` ($OLDPWD)
    // are not statically resolvable, so a no-op cannot be proven.
    if (text === "-" || text.includes("$") || text.includes("`")) return false;
    if (text === "~") text = homedir();
    else if (text.startsWith("~/")) text = homedir() + text.slice(1);
  }
  return canonical(resolve(cwd, text)) === canonical(resolve(cwd));
}

function noopReason(cwd: string): string {
  return (
    `Every bash call already starts in the working directory (${cwd}), ` +
    "so this `cd` is a no-op that only adds permanent transcript noise. " +
    "Re-run the command without the cd prefix."
  );
}

export type CdGuardVerdict = { block: true; reason: string } | { block: false };

/** Pure analysis, exported for testing. Returns the first offending verdict. */
export function analyzeCommand(command: string, cwd: string): CdGuardVerdict {
  const segments = segmentize(tokenize(command));
  for (const seg of segments) {
    const cd = cdTarget(seg);
    if (!cd) continue;
    if (CHECK_CD_NOOP && isNoop(cd.target, cwd)) return { block: true, reason: noopReason(cwd) };
  }
  return { block: false };
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return undefined;
    const command = event.input.command;
    if (!command) return undefined;

    const verdict = analyzeCommand(command, ctx.cwd);
    if (!verdict.block) return undefined;

    if (ctx.hasUI) {
      ctx.ui.notify("cd-guard blocked a no-op cd (see tool result)", "warning");
    }
    return { block: true, reason: verdict.reason };
  });
}
