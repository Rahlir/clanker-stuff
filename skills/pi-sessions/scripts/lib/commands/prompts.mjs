import { parseArgs } from "node:util";
import { indent, localStamp, short } from "../format.mjs";
import { PissError } from "../load.mjs";
import { all, findSession, headerLines, openCorpus, prepareScope, resolveWindow } from "../query.mjs";

export const summary = "Every user prompt in a window, grouped by session, template text collapsed.";

export const usage = `piss prompts [options]

User prompts in full, grouped by session. Prompts sent through a template or
skill show as /name: <arguments>, since the template body is boilerplate.
Output is paged; the last line says how to get the next page.

  --since <time>      start of the window (default 30d; whole corpus with --session)
  --until <time>      end of the window (default now; built: the corpus's end)
  --repo TEXT         only sessions whose repo or cwd contains TEXT
  --session REF       only this session (ref, session id prefix, or file path)
  --grep REGEX        only prompts matching REGEX (case-insensitive)
  --free-text         drop template and skill invocations that carry no arguments
  --offset N          skip the first N prompts (default 0)
  --limit N           at most N prompts per page (default 100)
  --max-chars N       stop the page before N characters (default 40000)
  --max-prompt N      cut a single prompt after N characters (default 6000, 0 = never)`;

const exactTemplate = (p) => p.template && (p.template_match === "full" || p.template_match === "pattern");

/** What the user wrote: template and skill boilerplate collapsed to its name. */
export function displayText(p) {
  if (p.skill) return `/skill:${p.skill}${p.args ? `: ${p.args}` : ""}`;
  if (exactTemplate(p)) return `/${p.template}${p.args ? `: ${p.args}` : ""}`;
  if (p.template) return `/${p.template} (sent with an older template text; full prompt follows)\n${p.text}`;
  return p.text;
}

const isBareInvocation = (p) => (p.skill || exactTemplate(p)) && !p.args;

const num = (value, name) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new PissError(`--${name} must be a whole number`);
  return n;
};

export async function run(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      since: { type: "string" },
      until: { type: "string" },
      repo: { type: "string" },
      session: { type: "string" },
      grep: { type: "string" },
      "free-text": { type: "boolean", default: false },
      offset: { type: "string", default: "0" },
      limit: { type: "string", default: "100" },
      "max-chars": { type: "string", default: "40000" },
      "max-prompt": { type: "string", default: "6000" },
    },
    strict: true,
  });
  const offset = num(values.offset, "offset");
  const limit = num(values.limit, "limit");
  const maxChars = num(values["max-chars"], "max-chars");
  const maxPrompt = num(values["max-prompt"], "max-prompt");
  let grep = null;
  if (values.grep) {
    try {
      grep = new RegExp(values.grep, "i");
    } catch (err) {
      throw new PissError(`--grep: ${err.message}`);
    }
  }

  const corpus = openCorpus();
  const session = values.session ? findSession(corpus.db, values.session) : null;
  if (values.session && !session) throw new PissError(`no session "${values.session}" in the corpus`);
  const w = resolveWindow(corpus, values, { defaultSince: session ? null : "30d" });
  prepareScope(corpus.db, w, values.repo);

  const rows = all(
    corpus.db,
    `SELECT p.*, s.repo, s.name, s.created FROM prompts p JOIN sessions s USING (ref)
     WHERE p.ts >= $S AND p.ts < $U AND p.ref IN (SELECT ref FROM scope) AND ($ref IS NULL OR p.ref = $ref)
     ORDER BY min(p.ts) OVER (PARTITION BY p.ref), p.ref, p.ts`,
    { S: w.S, U: w.U, ref: session?.ref ?? null },
  ).filter((p) => !(values["free-text"] && isBareInvocation(p)) && (!grep || grep.test(displayText(p))));

  const out = headerLines(corpus, w);
  let used = out.join("\n").length;
  let lastRef = null;
  let shown = 0;
  for (const p of rows.slice(offset, offset + limit)) {
    const block = [];
    if (p.ref !== lastRef) {
      block.push(
        "",
        `== ${p.ref} · ${short(p.repo)} · started ${localStamp(p.created)}${p.name ? ` · "${p.name}"` : ""}`,
      );
    }
    let text = displayText(p);
    if (maxPrompt && text.length > maxPrompt) {
      text = `${text.slice(0, maxPrompt)}\n… (+${text.length - maxPrompt} chars: piss show ${p.ref} --entry ${p.entry_id})`;
    }
    const flags = [p.on_active_branch ? null : "abandoned branch", p.has_images ? "with images" : null].filter(Boolean);
    const stamp = `[${localStamp(p.ts).slice(5)}]${flags.length ? ` (${flags.join(", ")})` : ""}`;
    block.push(!text.includes("\n") && text.length <= 200 ? `${stamp} ${text}` : `${stamp}\n${indent(text)}`);
    const chunk = block.join("\n");
    if (shown > 0 && used + chunk.length > maxChars) break;
    out.push(chunk);
    used += chunk.length + 1;
    lastRef = p.ref;
    shown++;
  }
  const end = offset + shown;
  let footer = `prompts ${offset + 1}-${end} of ${rows.length}${end < rows.length ? `; next page: --offset ${end}` : ""}`;
  if (rows.length === 0) footer = "no prompts match";
  else if (shown === 0) footer = `no prompts at offset ${offset}; there are ${rows.length}`;
  out.push("", footer);
  console.log(out.join("\n"));
  return 0;
}
