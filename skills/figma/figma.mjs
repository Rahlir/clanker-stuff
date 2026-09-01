#!/usr/bin/env node
// figma - read-only Figma REST helper for the `figma` pi skill.
//
// Subcommands: me, info, node, vars, styles, components, image.
// All commands accept a Figma URL or bare file key. URL ?node-id= is
// auto-extracted and translated from hyphen to colon form for the API.

import { writeFile, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";

const API = "https://api.figma.com/v1";
const TOKEN = process.env.FIGMA_TOKEN;
const IMG_DIR = "/tmp/pi-figma-skill";
const MAX_LINES = 200;
const CHILDREN_PER_LEVEL = 30;

const BOOL_FLAGS = new Set(["json"]);

function die(msg, code = 1) {
	process.stderr.write(`error: ${msg}\n`);
	process.exit(code);
}

function help() {
	process.stdout.write(`figma - Figma REST helper

Commands:
  me                                       Authenticated user / token check
  info       <url|key>                     File metadata + page list
  node       <url> [--depth N]             Node subtree (default depth 2)
  node       <key> <id[,id,...]> [--depth N]
  vars       <url|key> [--collection NAME] Variables by collection x mode (Enterprise)
  styles     <url|key>                     File styles (color/text/effect/grid)
  components <url|key>                     Components + component sets
  image      <url> [--format png|svg|pdf] [--scale 1|2|3]
  image      <key> <id[,id,...]> [--format ...] [--scale ...]
                                           Renders into ${IMG_DIR}/

Flags:
  --json     Raw Figma API response instead of markdown

Env:       FIGMA_TOKEN must be set (personal access token).
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

function parseFigmaRef(input) {
	if (!input) die("missing Figma URL or key");
	// Bare key: alphanumeric only, no slashes or query. Validate to catch typos
	// (e.g. partial-paste of a URL) before round-tripping to the API.
	if (!input.includes("/") && !input.includes("?")) {
		if (!/^[A-Za-z0-9]+$/.test(input)) {
			die(`invalid file key: ${input} (expected alphanumeric)`);
		}
		return { key: input };
	}
	const m = input.match(
		/figma\.com\/(?:file|design|proto|board|community\/file)\/([A-Za-z0-9]+)/,
	);
	if (!m) die(`could not parse Figma URL: ${input}`);
	const key = m[1];
	let nodeId;
	const q = input.match(/[?&]node-id=([^&]+)/);
	if (q) {
		// URL form uses hyphen (12-345); API form uses colon (12:345).
		nodeId = decodeURIComponent(q[1]).replace(/-/g, ":");
	}
	return { key, nodeId };
}

async function apiGet(path) {
	if (!TOKEN) die("FIGMA_TOKEN env var not set. See skill SKILL.md setup.");
	const res = await fetch(`${API}${path}`, {
		headers: { "X-Figma-Token": TOKEN },
	});
	if (!res.ok) {
		let body = "";
		try {
			body = await res.text();
		} catch {}
		if (res.status === 401)
			die("401 Unauthorized: token invalid or expired");
		if (res.status === 403) {
			if (path.includes("/variables/local")) {
				die(
					"403 Forbidden: variables endpoint requires Enterprise plan + file_variables:read scope",
				);
			}
			die(`403 Forbidden: ${body.slice(0, 200)}`);
		}
		if (res.status === 404) die(`404 Not Found: ${path}`);
		if (res.status === 429) die("429 Rate Limited: retry later");
		die(`${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
	}
	return res.json();
}

// ---- formatters -----------------------------------------------------------

function toHex(c) {
	const f = (x) =>
		Math.round(Math.max(0, Math.min(1, x)) * 255)
			.toString(16)
			.padStart(2, "0");
	const hex = `#${f(c.r)}${f(c.g)}${f(c.b)}`;
	if (c.a !== undefined && c.a < 1) return `${hex}@${c.a.toFixed(2)}`;
	return hex;
}

function fmtFill(fill) {
	if (!fill) return "?";
	if (fill.type === "SOLID" && fill.color) return toHex(fill.color);
	if (fill.type?.startsWith("GRADIENT"))
		return `gradient(${fill.type.replace("GRADIENT_", "").toLowerCase()})`;
	if (fill.type === "IMAGE")
		return `image(${(fill.imageRef ?? "?").slice(0, 8)})`;
	return fill.type ?? "?";
}

function fmtVarValue(value, type, varsById) {
	if (value && typeof value === "object" && value.type === "VARIABLE_ALIAS") {
		const target = varsById?.[value.id];
		return target ? `→ ${target.name}` : `→ ${value.id}`;
	}
	switch (type) {
		case "COLOR":
			return toHex(value);
		case "FLOAT":
			return String(value);
		case "STRING":
			return JSON.stringify(value);
		case "BOOLEAN":
			return String(value);
		default:
			return JSON.stringify(value);
	}
}

function truncate(s) {
	const lines = s.split("\n");
	if (lines.length <= MAX_LINES) return s;
	const kept = lines.slice(0, MAX_LINES).join("\n");
	return `${kept}\n... ${lines.length - MAX_LINES} more lines, use --json for full output`;
}

// ---- commands -------------------------------------------------------------

async function cmdMe(_args, flags) {
	const data = await apiGet("/me");
	if (flags.json) return JSON.stringify(data, null, 2);
	return `Authenticated as ${data.handle} <${data.email}> (id ${data.id})`;
}

async function cmdInfo(args, flags) {
	const ref = parseFigmaRef(args[0]);
	// depth=2 returns pages + their immediate children, enough for child counts
	// without pulling the whole document tree.
	const data = await apiGet(`/files/${ref.key}?depth=2`);
	if (flags.json) return JSON.stringify(data, null, 2);
	const out = [];
	out.push(`File: ${data.name} (key ${ref.key})`);
	out.push(`Last modified: ${data.lastModified}`);
	if (data.editorType) out.push(`Editor: ${data.editorType}`);
	if (data.version) out.push(`Version: ${data.version}`);
	out.push("");
	out.push("Pages:");
	for (const page of data.document?.children ?? []) {
		const n = (page.children ?? []).length;
		out.push(`- ${page.id}  ${page.name}  (${n} children)`);
	}
	return truncate(out.join("\n"));
}

async function cmdNode(args, flags) {
	let key;
	let ids;
	const depth = flags.depth ?? 2;
	if (args.length === 0) {
		die(
			"usage: figma node <url> [--depth N]  OR  figma node <key> <id[,id,...]> [--depth N]",
		);
	}
	if (args.length === 1) {
		const ref = parseFigmaRef(args[0]);
		if (!ref.nodeId)
			die(
				"node command needs a node id (URL must include ?node-id=, or pass it as second arg)",
			);
		key = ref.key;
		ids = ref.nodeId;
	} else {
		key = parseFigmaRef(args[0]).key;
		ids = args[1];
	}
	const data = await apiGet(
		`/files/${key}/nodes?ids=${encodeURIComponent(ids)}&depth=${depth}`,
	);
	if (flags.json) return JSON.stringify(data, null, 2);
	const out = [];
	for (const id of Object.keys(data.nodes ?? {})) {
		const entry = data.nodes[id];
		if (!entry?.document) {
			out.push(`Node ${id}: not found`);
			continue;
		}
		formatNode(entry.document, out, 0);
		out.push("");
	}
	return truncate(out.join("\n").trim());
}

function formatNode(node, out, indent) {
	const pad = "  ".repeat(indent);
	const prefix = indent === 0 ? "" : "- ";
	const parts = [node.type];
	if (node.absoluteBoundingBox) {
		const { width, height } = node.absoluteBoundingBox;
		parts.push(`${Math.round(width)}×${Math.round(height)}`);
	}
	if (node.layoutMode) {
		let p = node.layoutMode;
		if (node.itemSpacing !== undefined) p += ` gap=${node.itemSpacing}`;
		parts.push(p);
	}
	if (node.fills?.length) {
		const visible = node.fills.filter((x) => x.visible !== false);
		if (visible.length) parts.push(`fill=${visible.map(fmtFill).join(",")}`);
	}
	if (node.strokes?.length) {
		const visible = node.strokes.filter((x) => x.visible !== false);
		if (visible.length)
			parts.push(`stroke=${visible.map(fmtFill).join(",")}`);
	}
	if (node.characters) {
		const t =
			node.characters.length > 40
				? `${node.characters.slice(0, 40)}...`
				: node.characters;
		parts.push(`"${t.replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`);
	}
	if (node.componentId) parts.push(`→ ${node.componentId}`);
	out.push(`${pad}${prefix}${node.id}  ${node.name}  (${parts.join(", ")})`);
	if (node.children?.length) {
		const shown = node.children.slice(0, CHILDREN_PER_LEVEL);
		for (const child of shown) formatNode(child, out, indent + 1);
		if (node.children.length > CHILDREN_PER_LEVEL) {
			out.push(
				`${pad}  ... ${node.children.length - CHILDREN_PER_LEVEL} more children`,
			);
		}
	}
}

async function cmdVars(args, flags) {
	const { key } = parseFigmaRef(args[0]);
	const data = await apiGet(`/files/${key}/variables/local`);
	if (flags.json) return JSON.stringify(data, null, 2);
	const collections = Object.values(data.meta?.variableCollections ?? {});
	const variables = data.meta?.variables ?? {};
	if (!collections.length) return "No local variables in this file.";
	const filter = flags.collection?.toLowerCase();
	const out = [];
	for (const coll of collections) {
		if (filter && !coll.name.toLowerCase().includes(filter)) continue;
		const modes = coll.modes.map((m) => m.name);
		const hidden = coll.hiddenFromPublishing ? " (hidden)" : "";
		out.push(
			`Collection: ${coll.name}${hidden} (modes: ${modes.join(", ")})`,
		);
		const varsInColl = coll.variableIds
			.map((id) => variables[id])
			.filter(Boolean);
		const nameW = Math.max(
			0,
			...varsInColl.map(
				(v) => v.name.length + (v.hiddenFromPublishing ? 9 : 0),
			),
		);
		for (const v of varsInColl) {
			const nameDisplay = v.hiddenFromPublishing
				? `${v.name} (hidden)`
				: v.name;
			const cells = coll.modes.map((m) => {
				const val = v.valuesByMode[m.modeId];
				const formatted =
					val === undefined
						? "-"
						: fmtVarValue(val, v.resolvedType, variables);
				return `${m.name} ${formatted}`;
			});
			out.push(`  ${nameDisplay.padEnd(nameW)}  ${cells.join("    ")}`);
		}
		out.push("");
	}
	return truncate(out.join("\n").trim());
}

async function cmdStyles(args, flags) {
	const { key } = parseFigmaRef(args[0]);
	const data = await apiGet(`/files/${key}/styles`);
	if (flags.json) return JSON.stringify(data, null, 2);
	const styles = data.meta?.styles ?? [];
	if (!styles.length) return "No styles defined in this file.";
	const byType = {};
	for (const s of styles) (byType[s.style_type] ??= []).push(s);
	const out = [];
	for (const [type, list] of Object.entries(byType)) {
		out.push(`${type} (${list.length}):`);
		for (const s of list) {
			const desc = s.description
				? `  - ${s.description.slice(0, 60)}`
				: "";
			out.push(`  ${s.node_id}  ${s.name}${desc}`);
		}
		out.push("");
	}
	return truncate(out.join("\n").trim());
}

async function cmdComponents(args, flags) {
	const { key } = parseFigmaRef(args[0]);
	const [comps, sets] = await Promise.all([
		apiGet(`/files/${key}/components`),
		apiGet(`/files/${key}/component_sets`),
	]);
	if (flags.json)
		return JSON.stringify(
			{ components: comps, component_sets: sets },
			null,
			2,
		);
	const out = [];
	const setList = sets.meta?.component_sets ?? [];
	if (setList.length) {
		out.push(`Component sets (${setList.length}):`);
		for (const s of setList) {
			const desc = s.description
				? `  - ${s.description.slice(0, 60)}`
				: "";
			out.push(`  ${s.node_id}  ${s.name}${desc}`);
		}
		out.push("");
	}
	const compList = comps.meta?.components ?? [];
	if (compList.length) {
		out.push(`Components (${compList.length}):`);
		for (const c of compList) {
			const inSet =
				c.containing_frame?.containingStateGroup?.name ||
				c.containing_frame?.containingComponentSet?.name;
			const setNote = inSet ? `  [in set: ${inSet}]` : "";
			out.push(`  ${c.node_id}  ${c.name}${setNote}`);
		}
	}
	if (!out.length) return "No components in this file.";
	return truncate(out.join("\n").trim());
}

async function cmdImage(args, flags) {
	const ref = parseFigmaRef(args[0]);
	let ids;
	if (args.length >= 2) ids = args[1];
	else if (ref.nodeId) ids = ref.nodeId;
	else
		die(
			"image command needs a node id (URL must include ?node-id=, or pass it as second arg)",
		);
	const format = flags.format ?? "png";
	const scale = flags.scale ?? "1";
	const data = await apiGet(
		`/images/${ref.key}?ids=${encodeURIComponent(ids)}&format=${format}&scale=${scale}`,
	);
	if (flags.json) return JSON.stringify(data, null, 2);
	if (data.err) die(`Figma image error: ${data.err}`);
	await mkdir(IMG_DIR, { recursive: true });
	const out = [];
	for (const [id, url] of Object.entries(data.images ?? {})) {
		if (!url) {
			out.push(`${id}: no render available`);
			continue;
		}
		const safeId = id.replace(/[^A-Za-z0-9]/g, "-");
		const dest = join(IMG_DIR, `${safeId}.${format}`);
		const res = await fetch(url);
		if (!res.ok) {
			out.push(`${id}: download failed (${res.status})`);
			continue;
		}
		const buf = Buffer.from(await res.arrayBuffer());
		// Defense against symlink attacks in shared /tmp: unlink any existing
		// entry (does not follow symlinks), then create exclusively so a racing
		// symlink placement after unlink fails the write rather than overwriting
		// an attacker-chosen target.
		try {
			await unlink(dest);
		} catch (e) {
			if (e.code !== "ENOENT") throw e;
		}
		try {
			await writeFile(dest, buf, { flag: "wx" });
		} catch (e) {
			if (e.code === "EEXIST") {
				out.push(`${id}: refused (path raced after unlink)`);
				continue;
			}
			throw e;
		}
		out.push(`${id} → ${dest} (${(buf.length / 1024).toFixed(1)} KB)`);
	}
	return out.join("\n");
}

// ---- dispatch -------------------------------------------------------------

const COMMANDS = {
	me: cmdMe,
	info: cmdInfo,
	node: cmdNode,
	vars: cmdVars,
	styles: cmdStyles,
	components: cmdComponents,
	image: cmdImage,
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

main();
