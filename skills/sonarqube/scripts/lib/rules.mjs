// Rule metadata from api/rules/show, and its description rendered as
// markdown. Rules are instance-wide and immutable within one run, so
// lookups are cached per client.

import { SonarError } from "./client.mjs";

const cache = new WeakMap();

export function fetchRule(client, key) {
  let rules = cache.get(client);
  if (!rules) cache.set(client, (rules = new Map()));
  if (!rules.has(key))
    rules.set(
      key,
      client.get("/api/rules/show", { key }).then((r) => {
        if (!r?.rule?.key) throw new SonarError(`${client.instance.name}: api/rules/show returned an unexpected response for ${key}`);
        return r.rule;
      }),
    );
  return rules.get(key);
}

// ---- HTML -> markdown ------------------------------------------------------
// Sonar rule descriptions use a small, well-formed subset of HTML (p, h2-h4,
// ul/ol/li, pre, code, a, strong, em, br; tables are rare), so a small
// tolerant parser beats a dependency.

const VOID_TAGS = new Set(["br", "hr", "img"]);
const BLOCK_TAGS = new Set(["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "pre", "table", "blockquote", "hr"]);
const NAMED_ENTITIES = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s) {
  return s
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] !== "#") return NAMED_ENTITIES[e.toLowerCase()] ?? m;
      const cp = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    })
    .replace(/\u200b/g, "");
}

function parseAttrs(text) {
  const attrs = {};
  for (const m of text.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g))
    attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4]);
  return attrs;
}

// Unclosed tags close at their parent's end; stray end tags are ignored.
function parseHtml(html) {
  const root = { tag: "#root", children: [] };
  const stack = [root];
  for (const m of html.matchAll(/<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*?)(\/?)>|[^<]+|</g)) {
    const [token, closing, tag, attrText, selfClosing] = m;
    if (token.startsWith("<!--")) continue;
    if (!tag) {
      stack.at(-1).children.push({ text: token });
      continue;
    }
    const name = tag.toLowerCase();
    if (closing) {
      const i = stack.findLastIndex((n) => n.tag === name);
      if (i > 0) stack.length = i;
      continue;
    }
    const node = { tag: name, attrs: parseAttrs(attrText), children: [] };
    stack.at(-1).children.push(node);
    if (!VOID_TAGS.has(name) && !selfClosing) stack.push(node);
  }
  return root;
}

function rawText(node) {
  if (node.text !== undefined) return decodeEntities(node.text);
  if (node.tag === "br") return "\n";
  return node.children.map(rawText).join("");
}

const FENCE_LANGS = {
  py: "python",
  ts: "typescript",
  js: "javascript",
  web: "html",
  cs: "csharp",
  docker: "dockerfile",
  terraform: "hcl",
  cloudformation: "yaml",
  kubernetes: "yaml",
  plsql: "sql",
  tsql: "sql",
  secrets: "",
  text: "",
};

function renderInline(nodes, opts) {
  let s = "";
  for (const n of nodes) {
    if (n.text !== undefined) {
      s += decodeEntities(n.text).replace(/\s+/g, " ");
      continue;
    }
    const inner = () => renderInline(n.children, opts).trim();
    switch (n.tag) {
      case "code": {
        const code = rawText(n).replace(/\s+/g, " ").trim();
        s += code.includes("`") ? `\`\` ${code} \`\`` : `\`${code}\``;
        break;
      }
      case "strong":
      case "b":
        s += `**${inner()}**`;
        break;
      case "em":
      case "i":
        s += `*${inner()}*`;
        break;
      case "a": {
        const text = inner();
        let href = n.attrs.href;
        // Sonar links to its own pages relatively; make them usable outside the UI.
        if (href?.startsWith("/") && opts.baseUrl) href = opts.baseUrl + href;
        s += href && href !== text ? `[${text}](${href})` : text;
        break;
      }
      case "br":
        s += "\n";
        break;
      default:
        s += renderInline(n.children, opts);
    }
  }
  return s;
}

function renderList(node, ordered, opts) {
  const items = node.children.filter((c) => c.tag === "li");
  return items
    .map((li, i) => {
      const marker = ordered ? `${i + 1}. ` : "- ";
      const body = renderBlocks(li.children, opts);
      return marker + body.replace(/\n/g, `\n${" ".repeat(marker.length)}`);
    })
    .join("\n");
}

function renderTable(node, opts) {
  const rows = [];
  const walk = (n) => {
    if (n.tag === "tr") rows.push(n.children.filter((c) => c.tag === "td" || c.tag === "th").map((c) => renderInline(c.children, opts).trim().replace(/\|/g, "\\|")));
    else n.children?.forEach(walk);
  };
  walk(node);
  if (!rows.length) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const line = (r) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
  return [line(rows[0]), `|${" --- |".repeat(width)}`, ...rows.slice(1).map(line)].join("\n");
}

function renderBlock(n, opts) {
  switch (n.tag) {
    case "p":
    case "div":
      return renderBlocks(n.children, opts);
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return `${"#".repeat(opts.headingLevel)} ${renderInline(n.children, opts).trim()}`;
    case "ul":
    case "ol":
      return renderList(n, n.tag === "ol", opts);
    case "pre": {
      const code = rawText(n).replace(/^\n+|\s+$/g, "");
      const fence = code.includes("```") ? "````" : "```";
      // Sonar marks paired examples (noncompliant/compliant); the marker is
      // kept in the info string because the surrounding headings vary.
      const diff = n.attrs["data-diff-type"];
      const info = [opts.lang || (diff ? "text" : ""), diff].filter(Boolean).join(" ");
      return `${fence}${info}\n${code}\n${fence}`;
    }
    case "table":
      return renderTable(n, opts);
    case "blockquote":
      return renderBlocks(n.children, opts)
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
    case "hr":
      return "---";
    default:
      return renderBlocks(n.children, opts);
  }
}

// Runs of inline content become paragraphs; block elements render alone.
function renderBlocks(nodes, opts) {
  const out = [];
  let run = [];
  const flush = () => {
    const text = renderInline(run, opts)
      .split("\n")
      .map((l) => l.trim())
      .join("\n")
      .trim();
    if (text) out.push(text);
    run = [];
  };
  for (const n of nodes) {
    if (n.tag && BLOCK_TAGS.has(n.tag)) {
      flush();
      const block = renderBlock(n, opts);
      if (block.trim()) out.push(block);
    } else run.push(n);
  }
  flush();
  return out.join("\n\n");
}

// Inside a code fence blank lines are content (e.g. a triple-quoted string),
// so runs of them are collapsed only outside fences.
function collapseBlankLines(md) {
  let out = "";
  let last = 0;
  for (const m of md.matchAll(/^( *)(`{3,})[^\n]*\n[\s\S]*?\n\1\2$/gm)) {
    out += md.slice(last, m.index).replace(/\n{3,}/g, "\n\n") + m[0];
    last = m.index + m[0].length;
  }
  return out + md.slice(last).replace(/\n{3,}/g, "\n\n");
}

// `lang`: Sonar language code of the rule, used for code fences.
// `headingLevel`: level for headings inside the description.
export function htmlToMarkdown(html, { lang, baseUrl, headingLevel = 4 } = {}) {
  const fenceLang = lang ? (FENCE_LANGS[lang] ?? lang) : "";
  return collapseBlankLines(renderBlocks(parseHtml(html ?? "").children, { lang: fenceLang, baseUrl, headingLevel })).trim();
}

// ---- guidance ----------------------------------------------------------------

const SECTION_ORDER = ["introduction", "root_cause", "assess_the_problem", "how_to_fix", "resources"];
const SECTION_TITLES = {
  root_cause: "Why is this an issue?",
  assess_the_problem: "Assess the risk",
  how_to_fix: "How to fix it",
  resources: "More info",
};
export const FIX_SECTIONS = ["introduction", "root_cause", "assess_the_problem", "how_to_fix"];

// Framework variants of "how to fix" (e.g. FastAPI, Django), in rule order.
export function ruleContexts(rule) {
  const seen = new Map();
  for (const s of rule.descriptionSections ?? []) if (s.context) seen.set(s.context.key, s.context.displayName);
  return [...seen].map(([key, displayName]) => ({ key, displayName }));
}

const IMPORT_LINE = /^\s*(import|from|using|require)\b|\brequire\(|\bimport\(/;
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Which contexts apply to one issue. Sonar's ruleDescriptionContextKey is
// authoritative but in practice always null, and issue tags list every
// framework of the rule, so the fallback is the file's import lines
// (`import asyncio`). Returns the keys to show, or null for a rule without
// contexts. Several keys mean "could not tell": show them all.
export function selectContexts(rule, { contextKey = null, fileText = null } = {}) {
  const all = ruleContexts(rule);
  if (all.length === 0) return null;
  if (contextKey && all.some((c) => c.key === contextKey)) return [contextKey];
  if (all.length === 1) return [all[0].key];
  if (fileText) {
    const imports = fileText
      .split("\n")
      .filter((l) => IMPORT_LINE.test(l))
      .join("\n");
    const hits = all.filter((c) => new RegExp(`\\b${escapeRegExp(c.key)}\\b`, "i").test(imports));
    if (hits.length === 1) return [hits[0].key];
  }
  return all.map((c) => c.key);
}

// The rule's description as markdown, sections in Sonar's UI order under
// `###` headings. `contexts` limits "how to fix" to those framework keys
// (null: all). Rules without sections fall back to the legacy description.
export function ruleGuidance(rule, { sections = FIX_SECTIONS, contexts = null, baseUrl } = {}) {
  const md = (html) => htmlToMarkdown(html, { lang: rule.lang, baseUrl });
  const parts = rule.descriptionSections ?? [];
  if (parts.length === 0) {
    const legacy = rule.htmlDesc ? md(rule.htmlDesc) : (rule.mdDesc ?? "");
    return legacy || "(this rule has no description)";
  }
  const names = new Map(ruleContexts(rule).map((c) => [c.key, c.displayName]));
  const out = [];
  for (const key of SECTION_ORDER) {
    if (!sections.includes(key)) continue;
    let list = parts.filter((s) => s.key === key);
    if (contexts) list = list.filter((s) => !s.context || contexts.includes(s.context.key));
    for (const s of list) {
      const body = md(s.content);
      if (!body) continue;
      const title = SECTION_TITLES[key];
      if (title) {
        const ctx = s.context ? names.get(s.context.key) : null;
        const suffix = !ctx ? "" : list.length > 1 ? `: ${ctx}` : ` (${ctx})`;
        out.push(`### ${title}${suffix}`);
      }
      out.push(body);
    }
  }
  return out.join("\n\n");
}
