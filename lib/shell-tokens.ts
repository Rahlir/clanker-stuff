/**
 * Shell-approximate command tokenizer shared by the bash-inspecting guard
 * extensions (`search-guard`, `cd-guard`).
 *
 * A neutral module (not a pi extension): it registers nothing and holds no
 * state. It is deliberately NOT a full shell parser; it is just accurate
 * enough to locate program invocations and their option tokens without false
 * positives. It understands quotes (with bash-accurate escaping inside double
 * quotes), backslash line continuations, `|`/`;`/`&&`/`||`/`$(`/newlines as
 * command boundaries, redirections (including leading ones and `2>&1`-style
 * fd dups), the subshell nesting depth of each token, and skips heredoc
 * bodies so a command written *as data* into a script is not mistaken for one
 * being executed.
 *
 * Callers depend on:
 *   - `cmdPos`: token starts a pipeline segment (first word after a command
 *     boundary), i.e. it is a candidate program name.
 *   - `depth`: subshell nesting at the token. 0 means the token executes in
 *     the top-level shell; >0 means inside `(...)`, `$(...)`, or backticks.
 *     Brace groups `{ ...; }` intentionally do NOT increase depth (they run
 *     in the current shell).
 *   - `quoted`: any part of the token came from a quoted region, so it can
 *     never be a program name or an option flag.
 *   - `redir`: the token is a redirection operator; "file" redirects consume
 *     the following token as their target, "dup" redirects (`2>&1`, `>&-`)
 *     are self-contained.
 */

// A redirect either consumes a following filename ("file") or is self-contained
// ("dup", e.g. `2>&1`, `>&-`). Only `>&`/`<&` followed by a digit or `-` is a
// dup; bare `>&file` and `&>file` (ampersand first) take a filename target.
export type RedirKind = "file" | "dup";

export interface Tok {
  text: string;
  quoted: boolean;
  cmdPos: boolean;
  depth: number;
  redir?: RedirKind;
}

// Redirection at a token boundary: `<<<` here-string, optional-fd `>`/`>>`/`<`
// with optional fd-dup (`>&1`, `>&-`), or `&>`/`&>>`. Matched only when a fresh
// token is starting, so it never fires mid-word (e.g. `file>x`).
const REDIR_RE = /^(?:<<<|\d*(?:>>|>|<)(?:&\d+-?|&-|&)?|&>>?)/;

export function basename(s: string): string {
  const parts = s.split("/");
  return parts[parts.length - 1];
}

/**
 * Tokenize a shell command line. See the module docstring for the guarantees
 * callers may rely on.
 */
export function tokenize(cmd: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  let cur = "";
  let curQuoted = false;
  let started = false;
  let cmdPos = true;
  let depth = 0;
  let inBacktick = false;
  const pendingHeredocs: string[] = [];

  const push = () => {
    if (started) {
      toks.push({ text: cur, quoted: curQuoted, cmdPos, depth });
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
    toks.push({ text, quoted: false, cmdPos, depth, redir: kind });
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
    if (two === "&&" || two === "||") {
      markOperator();
      i += 2;
      continue;
    }
    if (two === "$(") {
      markOperator();
      depth++;
      i += 2;
      continue;
    }
    if (c === "(") {
      markOperator();
      depth++;
      i++;
      continue;
    }
    if (c === ")") {
      markOperator();
      if (depth > 0) depth--;
      i++;
      continue;
    }
    if (c === "`") {
      markOperator();
      // The tokenizer cannot tell an opening backtick from a closing one, so
      // it toggles: odd backticks enter a substitution, even ones leave it.
      if (inBacktick) {
        if (depth > 0) depth--;
      } else {
        depth++;
      }
      inBacktick = !inBacktick;
      i++;
      continue;
    }
    if ("|;&{}".includes(c)) {
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

/** Split tokens into pipeline segments (one program invocation each). */
export function segmentize(toks: Tok[]): Tok[][] {
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
