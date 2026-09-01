#!/usr/bin/env node
// confluence - read-only Confluence Server/DC REST helper for the `confluence` pi skill.
//
// Subcommands: me, page, search, children, spaces, comments, attachments, attachment.
// Page references may be a bare numeric id or any DC page URL form
// (?pageId=, /display/SPACE/Title, /x/ tiny link, /pages/<id> new-UI form).

import { writeFile, mkdir, unlink, stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { join } from "node:path";

const BASE = (process.env.CONFLUENCE_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.CONFLUENCE_TOKEN;
const TMP_DIR = "/tmp/pi-confluence-skill";
const MAX_LINES = 200;

const BOOL_FLAGS = new Set(["json"]);

function die(msg, code = 1) {
	process.stderr.write(`error: ${msg}\n`);
	process.exit(code);
}

function help() {
	process.stdout.write(`confluence - Confluence Server/DC REST helper (read-only)

Commands:
  me                                Authenticated user / token check
  page        <url|id>              Page metadata + body as markdown
  search      <text> [--space KEY] [--type page|blogpost] [--label X] [--limit N]
  search      --cql 'CQL'           Raw CQL escape hatch
  children    <url|id>              Child pages
  spaces      [--query X]           List spaces (optionally filtered by name/key)
  comments    <url|id>              Page comments, threads flattened
  attachments <url|id>              List attachments on a page
  attachment  <url|id> <filename>   Download attachment into ${TMP_DIR}/

Flags:
  --json      Raw API response instead of markdown

Env:
  CONFLUENCE_URL    Base URL, e.g. https://wiki.example.com
  CONFLUENCE_TOKEN  Personal access token (bearer)

Large page bodies are written in full to ${TMP_DIR}/<id>.md;
only the first ${MAX_LINES} lines are printed inline.
`);
}

function parseArgs(argv) {
	const positional = [];
	const flags = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith("--")) {
			const eq = a.indexOf("=");
			let key;
			let value;
			if (eq > 0) {
				key = a.slice(2, eq);
				value = a.slice(eq + 1);
			} else {
				key = a.slice(2);
				if (BOOL_FLAGS.has(key)) value = true;
				else if (i + 1 < argv.length && !argv[i + 1].startsWith("--"))
					value = argv[++i];
				else value = true;
			}
			flags[key] = value;
		} else {
			positional.push(a);
		}
	}
	return { positional, flags };
}

// ---- http -----------------------------------------------------------------

const TLS_CODES = new Set([
	"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
	"SELF_SIGNED_CERT_IN_CHAIN",
	"DEPTH_ZERO_SELF_SIGNED_CERT",
	"UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
	"CERT_HAS_EXPIRED",
	"ERR_TLS_CERT_ALTNAME_INVALID",
]);

function checkEnv() {
	if (!BASE) die("CONFLUENCE_URL env var not set. See skill SKILL.md setup.");
	if (!TOKEN)
		die("CONFLUENCE_TOKEN env var not set. See skill SKILL.md setup.");
}

async function rawFetch(url, opts = {}) {
	checkEnv();
	try {
		return await fetch(url, {
			...opts,
			headers: { Authorization: `Bearer ${TOKEN}`, ...opts.headers },
		});
	} catch (e) {
		const code = e.cause?.code ?? e.code;
		if (TLS_CODES.has(code)) {
			die(
				`TLS certificate error (${code}). If the instance uses a corporate CA, ` +
					`point Node at the CA bundle: export NODE_EXTRA_CA_CERTS=/path/to/ca.pem`,
			);
		}
		die(`request failed: ${e.cause?.message ?? e.message}`);
	}
}

async function apiGet(path) {
	const res = await rawFetch(`${BASE}/rest/api${path}`);
	if (!res.ok) {
		let body = "";
		try {
			body = await res.text();
		} catch {}
		if (res.status === 401)
			die("401 Unauthorized: token invalid or expired");
		if (res.status === 403)
			die(`403 Forbidden: no permission for this resource`);
		if (res.status === 404)
			die(`404 Not Found: ${path} (wrong id, or no read permission)`);
		die(`${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
	}
	return res.json();
}

// ---- page reference resolution ----------------------------------------------

// Accepts a bare numeric id or any DC page URL form and returns the page id.
// Forms needing an API round-trip (display URLs, tiny links) resolve lazily here
// so commands can treat every input uniformly.
async function resolvePageId(input) {
	if (!input) die("missing page URL or id");
	if (/^\d+$/.test(input)) return input;
	if (!input.includes("/"))
		die(`invalid page reference: ${input} (expected numeric id or URL)`);

	let m = input.match(/[?&]pageId=(\d+)/);
	if (m) return m[1];

	// New-UI form: /spaces/KEY/pages/123456/Title
	m = input.match(/\/pages\/(\d+)(?:\/|$)/);
	if (m) return m[1];

	// Display form: /display/SPACE/Page+Title
	m = input.match(/\/display\/([^/]+)\/([^/?#]+)/);
	if (m) {
		const space = decodeURIComponent(m[1]);
		const title = decodeURIComponent(m[2].replace(/\+/g, " "));
		const data = await apiGet(
			`/content?spaceKey=${encodeURIComponent(space)}&title=${encodeURIComponent(title)}`,
		);
		const hit = data.results?.[0];
		if (!hit) die(`no page titled "${title}" in space ${space}`);
		return hit.id;
	}

	// Tiny link: /x/AbCd; follow the redirect and re-parse the target.
	m = input.match(/\/x\/([A-Za-z0-9_-]+)/);
	if (m) {
		const res = await rawFetch(`${BASE}/x/${m[1]}`, { redirect: "manual" });
		const loc = res.headers.get("location");
		if (!loc) die(`tiny link did not redirect: ${input}`);
		return resolvePageId(loc.startsWith("/") ? `${BASE}${loc}` : loc);
	}

	die(`could not parse Confluence URL: ${input}`);
}

// ---- storage-format → markdown ----------------------------------------------

// Confluence storage format is well-formed XML (XHTML + ac:/ri: namespaces),
// so a minimal tree parse beats regex substitution: macros nest arbitrarily
// (panels containing code blocks containing CDATA etc.).

const VOID_TAGS = new Set(["br", "hr", "img"]);

// Storage format may contain any named HTML entity; cover the ones that
// actually show up in wiki prose, fall back to leaving the entity as-is.
const NAMED_ENTITIES = {
	nbsp: " ",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	ndash: "\u2013",
	mdash: "\u2014",
	hellip: "\u2026",
	lsquo: "\u2018",
	rsquo: "\u2019",
	ldquo: "\u201c",
	rdquo: "\u201d",
	laquo: "\u00ab",
	raquo: "\u00bb",
	middot: "\u00b7",
	bull: "\u2022",
	times: "\u00d7",
	deg: "\u00b0",
	copy: "\u00a9",
	reg: "\u00ae",
	trade: "\u2122",
	rarr: "\u2192",
	larr: "\u2190",
	euro: "\u20ac",
	sect: "\u00a7",
	plusmn: "\u00b1",
	le: "\u2264",
	ge: "\u2265",
	ne: "\u2260",
};

function decodeEntities(s) {
	return s
		.replace(/&#x([0-9a-fA-F]+);/g, (_, h) =>
			String.fromCodePoint(parseInt(h, 16)),
		)
		.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
		.replace(/&([a-zA-Z]+);/g, (m, name) =>
			name === "amp" ? m : (NAMED_ENTITIES[name] ?? m),
		)
		.replace(/&amp;/g, "&");
}

function parseXml(input) {
	const root = { type: "el", name: "#root", attrs: {}, children: [] };
	const stack = [root];
	const tokens = input.matchAll(
		/<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<(\/)?([a-zA-Z0-9:_-]+)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/)?>|([^<]+)/g,
	);
	for (const t of tokens) {
		const [, cdata, closing, name, attrText, selfClose, text] = t;
		const top = stack[stack.length - 1];
		if (cdata !== undefined) {
			top.children.push({ type: "text", text: cdata, cdata: true });
		} else if (text !== undefined) {
			top.children.push({ type: "text", text: decodeEntities(text) });
		} else if (name) {
			if (closing) {
				// Pop to the matching open tag; tolerate stray closers.
				for (let i = stack.length - 1; i > 0; i--) {
					if (stack[i].name === name) {
						stack.length = i;
						break;
					}
				}
			} else {
				const attrs = {};
				for (const a of (attrText ?? "").matchAll(
					/([a-zA-Z0-9:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g,
				)) {
					attrs[a[1]] = decodeEntities(a[2] ?? a[3] ?? "");
				}
				const el = { type: "el", name, attrs, children: [] };
				top.children.push(el);
				if (!selfClose && !VOID_TAGS.has(name)) stack.push(el);
			}
		}
	}
	return root;
}

// -- render helpers --

function textContent(node) {
	if (node.type === "text") return node.text;
	return node.children.map(textContent).join("");
}

function findChild(node, name) {
	return node.children.find((c) => c.type === "el" && c.name === name);
}

function macroParams(node) {
	const params = {};
	for (const c of node.children) {
		if (c.type === "el" && c.name === "ac:parameter") {
			params[c.attrs["ac:name"] ?? ""] = textContent(c).trim();
		}
	}
	return params;
}

// Render children as inline text (for table cells, link bodies, headings).
function renderInline(node) {
	return node.children.map((c) => renderNode(c, { inline: true })).join("");
}

// Render children as block-level markdown.
function renderBlocks(node, ctx = {}) {
	const parts = [];
	for (const c of node.children) {
		const r = renderNode(c, ctx);
		if (r.trim() !== "") parts.push(r);
	}
	return parts
		.join("\n\n")
		.replace(/[ \t]+$/gm, "")
		.replace(/\n{3,}/g, "\n\n");
}

function quoteBlock(text, label) {
	const body = label ? `**${label}** ${text}` : text;
	return body
		.split("\n")
		.map((l) => `> ${l}`)
		.join("\n");
}

function renderList(node, ordered, depth = 0) {
	const pad = "  ".repeat(depth);
	const out = [];
	let n = 1;
	for (const li of node.children) {
		if (li.type !== "el" || li.name !== "li") continue;
		const marker = ordered ? `${n++}.` : "-";
		const inlineParts = [];
		const blockParts = [];
		for (const c of li.children) {
			if (
				c.type === "el" &&
				(c.name === "ul" || c.name === "ol")
			) {
				blockParts.push(renderList(c, c.name === "ol", depth + 1));
			} else if (c.type === "el" && c.name === "p") {
				inlineParts.push(renderInline(c));
			} else {
				inlineParts.push(renderNode(c, { inline: true }));
			}
		}
		const text = inlineParts.join("").trim();
		out.push(`${pad}${marker} ${text}`);
		for (const b of blockParts) out.push(b);
	}
	return out.join("\n");
}

function renderTable(node) {
	// Collect only this table's own rows (direct, or under its own
	// thead/tbody/tfoot) so nested tables are not flattened into the parent.
	const trs = [];
	for (const c of node.children) {
		if (c.type !== "el") continue;
		if (c.name === "tr") trs.push(c);
		else if (["thead", "tbody", "tfoot"].includes(c.name)) {
			for (const r of c.children) {
				if (r.type === "el" && r.name === "tr") trs.push(r);
			}
		}
	}
	const rows = [];
	for (const tr of trs) {
		const cells = [];
		for (const cell of tr.children) {
			if (cell.type !== "el") continue;
			if (cell.name === "th" || cell.name === "td") {
				cells.push(
					renderBlocks(cell)
						.replace(/\n+/g, " ")
						.replace(/\|/g, "\\|")
						.trim(),
				);
			}
		}
		if (cells.length) rows.push({ cells });
	}
	if (!rows.length) return "";
	const width = Math.max(...rows.map((r) => r.cells.length));
	const fmt = (cells) =>
		`| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`;
	const out = [];
	// Markdown requires a header row; synthesize one from the first row.
	out.push(fmt(rows[0].cells));
	out.push(`|${" --- |".repeat(width)}`);
	for (const r of rows.slice(1)) out.push(fmt(r.cells));
	return out.join("\n");
}

function renderMacro(node, ctx) {
	const name = node.attrs["ac:name"] ?? "?";
	const params = macroParams(node);
	const richBody = findChild(node, "ac:rich-text-body");
	const plainBody = findChild(node, "ac:plain-text-body");

	switch (name) {
		case "code": {
			const lang = params.language ?? "";
			const code = plainBody ? textContent(plainBody) : "";
			return `\`\`\`${lang}\n${code.replace(/\n$/, "")}\n\`\`\``;
		}
		case "noformat":
			return `\`\`\`\n${(plainBody ? textContent(plainBody) : "").replace(/\n$/, "")}\n\`\`\``;
		case "info":
		case "note":
		case "warning":
		case "tip":
		case "panel": {
			const label =
				params.title ??
				name.charAt(0).toUpperCase() + name.slice(1) + ":";
			return quoteBlock(richBody ? renderBlocks(richBody) : "", label);
		}
		case "expand": {
			const title = params.title ?? "Expand";
			const body = richBody ? renderBlocks(richBody) : "";
			return `**▸ ${title}**\n\n${body}`;
		}
		case "status":
			return `[STATUS: ${params.title ?? "?"}]`;
		case "jira":
			return params.key ? `[${params.key}]` : "[macro: jira]";
		case "toc":
			return "[macro: toc]";
		case "anchor":
			return "";
		case "excerpt":
			return richBody ? renderBlocks(richBody) : "";
		default: {
			const body = richBody ? renderBlocks(richBody) : "";
			const tag = `[macro: ${name}]`;
			return body ? `${tag}\n\n${body}` : tag;
		}
	}
}

function renderLink(node) {
	const body =
		findChild(node, "ac:plain-text-link-body") ??
		findChild(node, "ac:link-body");
	const label = body ? textContent(body).trim() : "";
	const page = findChild(node, "ri:page");
	if (page) {
		const title = page.attrs["ri:content-title"] ?? "?";
		const space = page.attrs["ri:space-key"];
		const target = space ? `${space}:${title}` : title;
		return label && label !== title
			? `[${label}](confluence:${target})`
			: `[${target}]`;
	}
	const user = findChild(node, "ri:user");
	if (user) return `@${user.attrs["ri:username"] ?? "user"}`;
	const att = findChild(node, "ri:attachment");
	if (att) return `[attachment: ${att.attrs["ri:filename"] ?? "?"}]`;
	return label || "[link]";
}

function renderNode(node, ctx = {}) {
	if (node.type === "text") {
		return node.cdata ? node.text : node.text.replace(/\s+/g, " ");
	}
	const name = node.name;
	switch (name) {
		case "#root":
			return renderBlocks(node, ctx);
		case "h1":
		case "h2":
		case "h3":
		case "h4":
		case "h5":
		case "h6":
			return `${"#".repeat(Number(name[1]))} ${renderInline(node).trim()}`;
		case "p": {
			const t = renderInline(node).trim();
			return ctx.inline ? t : t;
		}
		case "blockquote":
			return quoteBlock(renderBlocks(node));
		case "ul":
			return renderList(node, false);
		case "ol":
			return renderList(node, true);
		case "table":
			return renderTable(node);
		case "strong":
		case "b": {
			const t = renderInline(node).trim();
			return t ? `**${t}**` : "";
		}
		case "em":
		case "i": {
			const t = renderInline(node).trim();
			return t ? `*${t}*` : "";
		}
		case "s":
		case "del": {
			const t = renderInline(node).trim();
			return t ? `~~${t}~~` : "";
		}
		case "u":
		case "span":
		case "div":
		case "center":
		case "colgroup":
			return ctx.inline ? renderInline(node) : renderBlocks(node, ctx);
		case "code":
		case "pre": {
			const t = textContent(node).trim();
			return name === "pre" && t.includes("\n")
				? `\`\`\`\n${t}\n\`\`\``
				: `\`${t}\``;
		}
		case "a": {
			const href = node.attrs.href ?? "";
			const label = renderInline(node).trim() || href;
			return href ? `[${label}](${href})` : label;
		}
		case "br":
			return ctx.inline ? " " : "";
		case "hr":
			return "---";
		case "time":
			return node.attrs.datetime ?? "";
		case "img": {
			const src = node.attrs.src ?? "";
			return `![${node.attrs.alt ?? ""}](${src})`;
		}
		// Confluence-specific elements.
		case "ac:structured-macro":
		case "ac:macro":
			return renderMacro(node, ctx);
		case "ac:link":
			return renderLink(node);
		case "ac:image": {
			const att = findChild(node, "ri:attachment");
			if (att) return `[image: ${att.attrs["ri:filename"] ?? "?"}]`;
			const url = findChild(node, "ri:url");
			if (url) return `![](${url.attrs["ri:value"] ?? ""})`;
			return "[image]";
		}
		case "ac:emoticon":
			return `:${node.attrs["ac:name"] ?? "emoji"}:`;
		case "ac:task-list": {
			const out = [];
			for (const task of node.children) {
				if (task.type !== "el" || task.name !== "ac:task") continue;
				const status = findChild(task, "ac:task-status");
				const body = findChild(task, "ac:task-body");
				const done =
					status && textContent(status).trim() === "complete";
				out.push(
					`- [${done ? "x" : " "}] ${body ? renderInline(body).trim() : ""}`,
				);
			}
			return out.join("\n");
		}
		case "ac:layout":
		case "ac:layout-section":
		case "ac:layout-cell":
		case "ac:rich-text-body":
			return renderBlocks(node, ctx);
		case "ac:placeholder":
		case "ac:parameter":
			return "";
		default:
			// Unknown tag: render contents transparently rather than dropping them.
			return ctx.inline ? renderInline(node) : renderBlocks(node, ctx);
	}
}

export function storageToMarkdown(storage) {
	return renderNode(parseXml(storage)).trim();
}

// ---- output helpers ---------------------------------------------------------

// Defense against symlink attacks in shared /tmp: unlink any existing entry
// (does not follow symlinks), then create exclusively so a racing symlink
// placement after unlink fails the write rather than overwriting a target.
async function prepTmpDest(filename) {
	await mkdir(TMP_DIR, { recursive: true });
	const dest = join(TMP_DIR, filename);
	try {
		await unlink(dest);
	} catch (e) {
		if (e.code !== "ENOENT") throw e;
	}
	return dest;
}

async function writeTmp(filename, content) {
	const dest = await prepTmpDest(filename);
	await writeFile(dest, content, { flag: "wx" });
	return dest;
}

function truncate(s) {
	const lines = s.split("\n");
	if (lines.length <= MAX_LINES) return s;
	return (
		lines.slice(0, MAX_LINES).join("\n") +
		`\n... ${lines.length - MAX_LINES} more lines, use --json or narrow the query`
	);
}

function webUrl(content) {
	const webui = content._links?.webui;
	return webui ? `${BASE}${webui}` : `${BASE}/pages/viewpage.action?pageId=${content.id}`;
}

// ---- commands ----------------------------------------------------------------

async function cmdMe(_args, flags) {
	const data = await apiGet("/user/current");
	if (flags.json) return JSON.stringify(data, null, 2);
	return `Authenticated as ${data.displayName} (${data.username})`;
}

async function cmdPage(args, flags) {
	const id = await resolvePageId(args[0]);
	const data = await apiGet(
		`/content/${id}?expand=body.storage,version,space,metadata.labels,ancestors`,
	);
	if (flags.json) return JSON.stringify(data, null, 2);

	const out = [];
	out.push(`# ${data.title}  (id ${data.id}, ${data.type})`);
	out.push(`Space: ${data.space?.key} (${data.space?.name ?? "?"})`);
	const v = data.version;
	if (v)
		out.push(
			`Version: ${v.number} by ${v.by?.displayName ?? "?"}, ${v.when ?? ""}`,
		);
	const labels = (data.metadata?.labels?.results ?? []).map((l) => l.name);
	if (labels.length) out.push(`Labels: ${labels.join(", ")}`);
	const ancestors = (data.ancestors ?? []).map((a) => a.title);
	if (ancestors.length) out.push(`Path: ${ancestors.join(" > ")}`);
	out.push(`URL: ${webUrl(data)}`);
	out.push("");
	out.push("---");
	out.push("");

	const body = storageToMarkdown(data.body?.storage?.value ?? "");
	const header = out.join("\n");
	const full = `${header}\n${body}\n`;
	const lines = full.split("\n");
	if (lines.length <= MAX_LINES) return full.trimEnd();

	const dest = await writeTmp(`${data.id}.md`, full);
	return (
		lines.slice(0, MAX_LINES).join("\n") +
		`\n... ${lines.length - MAX_LINES} more lines. Full page: ${dest} (use read with offset)`
	);
}

function fmtResult(c) {
	const space = c.space?.key ?? c.resultGlobalContainer?.displayUrl ?? "";
	const when = c.version?.when?.slice(0, 10) ?? "";
	const parts = [c.id, c.type, space && `[${space}]`, c.title, when]
		.filter(Boolean)
		.join("  ");
	return `${parts}\n    ${webUrl(c)}`;
}

function cqlQuote(s) {
	return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

async function cmdSearch(args, flags) {
	let cql;
	if (flags.cql) {
		cql = flags.cql;
	} else {
		if (!args[0]) die('usage: confluence search <text> [--space KEY] [--type T] [--label X] OR search --cql \'...\'');
		const clauses = [`text ~ ${cqlQuote(args[0])}`];
		if (flags.space) clauses.push(`space = ${cqlQuote(flags.space)}`);
		if (flags.type) clauses.push(`type = ${flags.type}`);
		if (flags.label) clauses.push(`label = ${cqlQuote(flags.label)}`);
		cql = `${clauses.join(" AND ")} order by lastmodified desc`;
	}
	const limit = Math.min(
		Math.max(Number.parseInt(flags.limit, 10) || 25, 1),
		200,
	);
	const data = await apiGet(
		`/content/search?cql=${encodeURIComponent(cql)}&limit=${limit}&expand=space,version`,
	);
	if (flags.json) return JSON.stringify(data, null, 2);
	const results = data.results ?? [];
	if (!results.length) return `No results for: ${cql}`;
	const out = [`${results.length} result(s) for: ${cql}`, ""];
	for (const c of results) out.push(fmtResult(c));
	if (data.size === limit && data._links?.next)
		out.push("", `(more results exist; raise --limit or narrow the query)`);
	return truncate(out.join("\n"));
}

async function cmdChildren(args, flags) {
	const id = await resolvePageId(args[0]);
	const data = await apiGet(
		`/content/${id}/child/page?limit=200&expand=version`,
	);
	if (flags.json) return JSON.stringify(data, null, 2);
	const results = data.results ?? [];
	if (!results.length) return `Page ${id} has no child pages.`;
	const out = [`${results.length} child page(s) of ${id}:`, ""];
	for (const c of results) {
		const when = c.version?.when?.slice(0, 10) ?? "";
		out.push(`${c.id}  ${c.title}  ${when}`);
	}
	return truncate(out.join("\n"));
}

async function cmdSpaces(_args, flags) {
	const data = await apiGet(`/space?limit=500&type=global`);
	if (flags.json) return JSON.stringify(data, null, 2);
	let results = data.results ?? [];
	const q = flags.query?.toLowerCase();
	if (q)
		results = results.filter(
			(s) =>
				s.key.toLowerCase().includes(q) ||
				s.name.toLowerCase().includes(q),
		);
	if (!results.length) return "No matching spaces.";
	const keyW = Math.max(...results.map((s) => s.key.length));
	const out = [`${results.length} space(s):`, ""];
	for (const s of results) out.push(`${s.key.padEnd(keyW)}  ${s.name}`);
	return truncate(out.join("\n"));
}

async function cmdComments(args, flags) {
	const id = await resolvePageId(args[0]);
	const data = await apiGet(
		`/content/${id}/child/comment?limit=100&expand=body.storage,version&depth=all`,
	);
	if (flags.json) return JSON.stringify(data, null, 2);
	const results = data.results ?? [];
	if (!results.length) return `Page ${id} has no comments.`;
	const out = [`${results.length} comment(s) on page ${id}:`];
	for (const c of results) {
		const v = c.version;
		out.push(
			"",
			`--- ${v?.by?.displayName ?? "?"}, ${v?.when ?? "?"} (id ${c.id})`,
			storageToMarkdown(c.body?.storage?.value ?? ""),
		);
	}
	return truncate(out.join("\n"));
}

async function cmdAttachments(args, flags) {
	const id = await resolvePageId(args[0]);
	const data = await apiGet(
		`/content/${id}/child/attachment?limit=200&expand=version`,
	);
	if (flags.json) return JSON.stringify(data, null, 2);
	const results = data.results ?? [];
	if (!results.length) return `Page ${id} has no attachments.`;
	const out = [`${results.length} attachment(s) on page ${id}:`, ""];
	for (const a of results) {
		const kb = a.extensions?.fileSize
			? `${(a.extensions.fileSize / 1024).toFixed(1)} KB`
			: "?";
		const type = a.extensions?.mediaType ?? "?";
		const when = a.version?.when?.slice(0, 10) ?? "";
		out.push(`${a.title}  (${type}, ${kb}, ${when})`);
	}
	return truncate(out.join("\n"));
}

async function cmdAttachment(args, _flags) {
	if (!args[1])
		die("usage: confluence attachment <url|id> <filename>");
	const id = await resolvePageId(args[0]);
	const filename = args[1];
	const data = await apiGet(
		`/content/${id}/child/attachment?filename=${encodeURIComponent(filename)}`,
	);
	const att = data.results?.[0];
	if (!att)
		die(
			`no attachment named "${filename}" on page ${id} (run: confluence attachments ${id})`,
		);
	const download = att._links?.download;
	if (!download) die(`attachment has no download link`);
	const url = /^https?:\/\//.test(download) ? download : `${BASE}${download}`;
	const res = await rawFetch(url);
	if (!res.ok) die(`download failed: ${res.status} ${res.statusText}`);
	if (!res.body) die("download failed: empty response body");
	// Sanitize: attachment titles can contain path separators.
	const safe =
		filename.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[.-]+$/, "") ||
		"attachment";
	// Stream to disk; attachments can be large (exports, PDFs).
	const dest = await prepTmpDest(safe);
	await pipeline(
		Readable.fromWeb(res.body),
		createWriteStream(dest, { flags: "wx" }),
	);
	const { size } = await stat(dest);
	return `${filename} → ${dest} (${(size / 1024).toFixed(1)} KB)`;
}

// ---- dispatch -----------------------------------------------------------------

const COMMANDS = {
	me: cmdMe,
	page: cmdPage,
	search: cmdSearch,
	children: cmdChildren,
	spaces: cmdSpaces,
	comments: cmdComments,
	attachments: cmdAttachments,
	attachment: cmdAttachment,
};

async function main() {
	const argv = process.argv.slice(2);
	if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
		help();
		process.exit(0);
	}
	const cmd = argv[0];
	if (!COMMANDS[cmd]) die(`unknown command: ${cmd}. Try --help.`);
	const { positional, flags } = parseArgs(argv.slice(1));
	let out;
	try {
		out = await COMMANDS[cmd](positional, flags);
	} catch (e) {
		die(e.message || String(e));
	}
	process.stdout.write(`${out}\n`);
}

// Only run the CLI when executed directly, so the converter stays importable
// for fixture tests.
if (import.meta.url === `file://${process.argv[1]}`) main();
