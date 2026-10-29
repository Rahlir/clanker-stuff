// Fill the report shell: number the sections and build the rail, draw the
// chart placeholders from facts, turn [[S...]] markers into session refs, and
// add the colophon. Pure, so tests can render bodies without a corpus.

import { createHash } from "node:crypto";
import { CHARTS, contours } from "./charts.mjs";
import { EARLIER, htmlToText, SESSION_REF } from "./publish.mjs";

/**
 * The page's Content-Security-Policy: only the shell's own scripts run (by
 * hash), nothing loads from outside, and links cannot become code. It holds
 * whatever slips past lintBody's checks, which no regex makes airtight.
 */
export function contentSecurityPolicy(shell) {
  const hashes = [...shell.matchAll(/<script\b(?![^>]*\btype="application\/json")[^>]*>([\s\S]*?)<\/script>/g)].map(
    (m) => `'sha256-${createHash("sha256").update(m[1]).digest("base64")}'`,
  );
  return [
    "default-src 'none'",
    `script-src ${hashes.join(" ") || "'none'"}`,
    "style-src 'unsafe-inline'",
    "img-src data:",
    "font-src data:",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

const emDashes = (html) => (htmlToText(html).match(/\u2014/g) ?? []).length;

const esc = (s) =>
  String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const attr = (attrs, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1];

/**
 * Render a report. Returns the page and everything a caller must check before
 * publishing it: `errors` (malformed body, unknown charts or refs) and the refs
 * and charts that were used.
 *
 * `refInfo` maps refs to their hover-card data; a ref missing from it is an
 * error, because every cited session must exist in the corpus.
 * `requiredSections` lists section ids the body must contain (see spec.mjs).
 */
export function renderReport({
  shell,
  body,
  facts,
  outcomes,
  refInfo = {},
  reportInfo = {},
  carried = [],
  title,
  colophon = "",
  seed,
  requiredSections = [],
}) {
  const errors = [];
  let html = body.trim();

  if (!html.startsWith('<header class="hero">')) errors.push('the body must start with <header class="hero">');
  html = html.replace(
    '<header class="hero">',
    () =>
      `<header class="hero"><div class="topo-wrap" aria-hidden="true">${contours(seed ?? facts.window.until)}</div>` +
      `<p class="kicker">${CHARTS.kicker(facts)}</p>`,
  );

  const nav = [];
  const ids = new Set();
  html = html.replace(/<section\b([^>]*)>/g, (tag, attrs) => {
    const id = attr(attrs, "id");
    const label = attr(attrs, "data-label");
    if (!id || !label) {
      errors.push(`every <section> needs id and data-label: ${tag}`);
      return tag;
    }
    if (ids.has(id)) errors.push(`duplicate section id "${id}"`);
    ids.add(id);
    const num = String(nav.length + 1).padStart(2, "0");
    nav.push(`<a href="#${esc(id)}"><span class="n">${num}</span><span class="t">${esc(label)}</span></a>`);
    return `${tag}<p class="eyebrow"><span class="num">${num}</span><span>${esc(label)}</span></p>`;
  });
  if (!nav.length) errors.push("the body has no <section> elements");
  for (const id of requiredSections) {
    if (!ids.has(id)) errors.push(`missing required section "${id}"`);
  }

  const charts = [];
  html = html.replace(/<!--\s*chart:([a-z-]+)\s*-->/g, (_, name) => {
    const draw = CHARTS[name];
    if (!draw || name === "kicker") {
      errors.push(`unknown chart "${name}" (known: ${Object.keys(CHARTS).filter((k) => k !== "kicker").join(", ")})`);
      return "";
    }
    charts.push(name);
    return draw(facts, { outcomes, carried });
  });

  const refs = new Set();
  const reportRefs = new Set();
  html = html.replace(/\[\[([^\]\n]*)\]\]/g, (marker, ref) => {
    if (ref.startsWith("R:")) {
      const id = ref.slice(2);
      if (!EARLIER.test(id)) {
        errors.push(`malformed report ref ${marker}`);
        return esc(id);
      }
      const info = reportInfo[id];
      if (!info) {
        errors.push(`report ref ${marker} is not followed up in findings.carried`);
        return esc(id);
      }
      reportRefs.add(id);
      return `<span class="ref report" tabindex="0" role="button" data-ref="R:${esc(id)}" data-anchor="${esc(info.anchor)}">${esc(info.label)}</span>`;
    }
    if (!SESSION_REF.test(ref)) {
      errors.push(`malformed session ref ${marker}`);
      return esc(ref);
    }
    refs.add(ref);
    if (!refInfo[ref]) errors.push(`unknown session ref ${ref}`);
    return `<span class="ref" tabindex="0" role="button" data-ref="${ref}">${ref}</span>`;
  });

  const refData = Object.fromEntries([...refs].filter((r) => refInfo[r]).map((r) => [r, refInfo[r]]));
  for (const id of reportRefs) {
    const { name, meta, prompt, label } = reportInfo[id];
    refData[`R:${id}`] = { name, meta, prompt, ref: label, hint: "click to read it in Since the last report" };
  }
  // The body goes in last, so a slot marker in its text cannot pull in the
  // footer or the ref data.
  const page = shell
    .replace("<!--slot:csp-->", () => contentSecurityPolicy(shell))
    .replace("<!--slot:title-->", () => esc(title))
    .replace("<!--slot:nav-->", () => nav.join(""))
    .replace("<!--slot:footer-->", () => colophon)
    .replace("<!--slot:refs-->", () => JSON.stringify(refData).replaceAll("<", "\\u003c"))
    .replace("<!--slot:body-->", () => html);
  // The body's own em dashes are lintBody's to report; these came from data
  // drawn into the page (quoted earlier reports, chart labels).
  const drawn = emDashes(page) - emDashes(body);
  if (drawn > 0) errors.push(`${drawn} em dash${drawn === 1 ? "" : "es"} in text drawn into the page (an earlier report's sidecar or a label)`);

  return { html: page, errors, refs: [...refs], reportRefs: [...reportRefs], charts, sections: nav.length };
}

/** The footer line: who generated the report, when, and from which corpus. */
export function colophon({ generatedAt, model, thinking, corpus }) {
  const parts = [
    `<span>generated <strong>${esc(generatedAt)}</strong></span>`,
    `<span>by <strong>${esc(model ?? "unknown model")}</strong>${thinking ? `, thinking <strong>${esc(thinking)}</strong>` : ""}</span>`,
  ];
  if (corpus) {
    const status = corpus.warnings?.length ? `coverage WARN: ${corpus.warnings.join("; ")}` : "coverage ok";
    parts.push(`<span>corpus built ${esc(corpus.built_at_local ?? corpus.built_at)} with pi ${esc(corpus.pi_version)}, ${esc(status)}</span>`);
  }
  parts.push("<span>numbers: piss facts; definitions: pi-sessions references/metrics.md</span>");
  return parts.join("");
}
