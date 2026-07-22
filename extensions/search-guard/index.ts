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
 * Detection is a small shell-approximate tokenizer, not a full parser. It
 * understands quotes (with bash-accurate escaping), backslash line
 * continuations, `|`/`;`/`&&`/`||`/`$(`/newlines as command boundaries,
 * redirections (including leading ones and `2>&1`-style fd dups), env-assignment
 * and wrapper prefixes (sudo/env/xargs/... with their own flags), the `--`
 * end-of-options marker, short-flag clusters with attached values, and skips
 * heredoc bodies so a search command written *as data* into a script is not
 * mistaken for one being executed.
 */

import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

// Redirection at a token boundary: `<<<` here-string, optional-fd `>`/`>>`/`<`
// with optional fd-dup (`>&1`, `>&-`), or `&>`/`&>>`. Matched only when a fresh
// token is starting, so it never fires mid-word (e.g. `file>x`).
const REDIR_RE = /^(?:<<<|\d*(?:>>|>|<)(?:&\d+-?|&-|&)?|&>>?)/;

// A redirect either consumes a following filename ("file") or is self-contained
// ("dup", e.g. `2>&1`, `>&-`). Only `>&`/`<&` followed by a digit or `-` is a
// dup; bare `>&file` and `&>file` (ampersand first) take a filename target.
type RedirKind = "file" | "dup";
interface Tok {
  text: string;
  quoted: boolean;
  cmdPos: boolean;
  redir?: RedirKind;
}

function basename(s: string): string {
  const parts = s.split("/");
  return parts[parts.length - 1];
}

function isSearchProgram(t: Tok): boolean {
  if (t.quoted || t.redir) return false;
  const b = basename(t.text);
  return b === "rg" || b === "grep";
}

/**
 * Tokenize a shell command line, tracking whether each token was quoted, whether
 * it sits in "command position" (first word of a pipeline/segment), and whether
 * it is a redirection. Shell-approximate on purpose: enough to locate rg/grep
 * invocations and their option tokens without a real shell parser.
 */
function tokenize(cmd: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  let cur = "";
  let curQuoted = false;
  let started = false;
  let cmdPos = true;
  const pendingHeredocs: string[] = [];

  const push = () => {
    if (started) {
      toks.push({ text: cur, quoted: curQuoted, cmdPos });
      cmdPos = false;
      cur = "";
      curQuoted = false;
      started = false;
    }
  };
  const markOperator = () => {
    push();
    cmdPos = true;
  };
  const pushRedir = (text: string, kind: RedirKind) => {
    push();
    toks.push({ text, quoted: false, cmdPos, redir: kind });
    cmdPos = false;
  };

  while (i < cmd.length) {
    const c = cmd[i];
    if (c === "'") {
      started = true;
      curQuoted = true;
      i++;
      while (i < cmd.length && cmd[i] !== "'") {
        cur += cmd[i];
        i++;
      }
      i++;
      continue;
    }
    if (c === '"') {
      started = true;
      curQuoted = true;
      i++;
      while (i < cmd.length && cmd[i] !== '"') {
        // Inside double quotes bash only treats `\` as an escape before
        // $ ` " \ and newline; otherwise the backslash is literal.
        if (cmd[i] === "\\" && i + 1 < cmd.length) {
          const nx = cmd[i + 1];
          if (nx === "\n") {
            i += 2; // line continuation: both chars removed
            continue;
          }
          if (nx === '"' || nx === "\\" || nx === "$" || nx === "`") {
            cur += nx;
            i += 2;
            continue;
          }
          cur += "\\";
          i++;
          continue;
        }
        cur += cmd[i];
        i++;
      }
      i++;
      continue;
    }
    if (c === "\\") {
      const nx = cmd[i + 1];
      if (nx === "\n") {
        i += 2; // line continuation: token stays open, both chars removed
        continue;
      }
      if (nx === "\r") {
        i += cmd[i + 2] === "\n" ? 3 : 2;
        continue;
      }
      if (nx !== undefined) {
        started = true;
        cur += nx;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (c === "\n" || c === "\r") {
      markOperator();
      i++;
      // Skip heredoc bodies queued on this line (consecutive, in order).
      while (pendingHeredocs.length > 0) {
        const delim = pendingHeredocs.shift() as string;
        while (i < cmd.length) {
          const lineStart = i;
          while (i < cmd.length && cmd[i] !== "\n") i++;
          const line = cmd.slice(lineStart, i);
          if (i < cmd.length) i++;
          if (line.trim() === delim) break;
        }
      }
      continue;
    }
    // heredoc start: `<<WORD`, `<< 'WORD'`, `<<-WORD` (but not the `<<<` here-string)
    if (c === "<" && cmd[i + 1] === "<" && cmd[i + 2] !== "<") {
      push();
      let j = i + 2;
      if (cmd[j] === "-") j++;
      while (j < cmd.length && (cmd[j] === " " || cmd[j] === "\t")) j++;
      let quote = "";
      if (cmd[j] === "'" || cmd[j] === '"') {
        quote = cmd[j];
        j++;
      }
      let delim = "";
      while (j < cmd.length && /[A-Za-z0-9_]/.test(cmd[j])) {
        delim += cmd[j];
        j++;
      }
      if (quote && cmd[j] === quote) j++;
      if (delim) pendingHeredocs.push(delim);
      i = j;
      continue;
    }
    // redirection, only at the start of a fresh token
    if (!started) {
      const m = REDIR_RE.exec(cmd.slice(i));
      if (m) {
        const text = m[0];
        pushRedir(text, /[<>]&[\d-]/.test(text) ? "dup" : "file");
        i += text.length;
        continue;
      }
    }
    if (/\s/.test(c)) {
      push();
      i++;
      continue;
    }
    const two = cmd.slice(i, i + 2);
    if (two === "&&" || two === "||" || two === "$(") {
      markOperator();
      i += 2;
      continue;
    }
    if ("|;&(){}`".includes(c)) {
      markOperator();
      i++;
      continue;
    }
    started = true;
    cur += c;
    i++;
  }
  push();
  return toks;
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

function segmentize(toks: Tok[]): Tok[][] {
  const segments: Tok[][] = [];
  let cur: Tok[] = [];
  for (const t of toks) {
    if (t.cmdPos && cur.length) {
      segments.push(cur);
      cur = [];
    }
    cur.push(t);
  }
  if (cur.length) segments.push(cur);
  return segments;
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
