import { parseArgs } from "node:util";
import { oneLine, table } from "../format.mjs";
import { PissError } from "../load.mjs";
import { headerLines, openCorpus } from "../query.mjs";

export const summary = "Read-only SQL over the corpus, session tags attached (schema: references/data-model.md).";

export const usage = `piss sql "<query>" [options]

Runs one read-only statement (SELECT, WITH, EXPLAIN, PRAGMA or VALUES). The
tables are described in references/data-model.md; timestamps are UTC ISO
strings, so use date(ts, 'localtime') for local days. text REGEXP 'pattern'
takes JavaScript regex syntax, with a leading (?i) for case-insensitive matching.
Output is paged; the last line says how to get the next page.

  --limit N       print at most N rows (default 200); the total is still counted
  --offset N      skip the first N rows (for the next page)
  --max-cell N    cut each value after N characters (default 2000; 80 in the
                  table unless --wide)
  --max-chars N   stop the page before N characters (default 50000)
  --wide          do not cut table cells at 80 characters
  --json          print the rows as JSON`;

const COUNT_CAP = 1_000_000;
const READ_ONLY = new Set(["SELECT", "WITH", "EXPLAIN", "PRAGMA", "VALUES"]);

/**
 * Why `text` is not one read-only statement, or null when it is. The
 * connection is read-only already, but SQLite still lets VACUUM INTO write a
 * new file through it, and prepare() silently ignores everything after the
 * first statement. Quoted text and comments are skipped, so a ";" or a keyword
 * inside them does not count.
 */
export function statementProblem(text) {
  let first = null;
  let ended = false;
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === "-" && text[i + 1] === "-") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? text.length : nl + 1;
    } else if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close < 0 ? text.length : close + 2;
    } else if (ended) {
      return "run one statement at a time";
    } else if (c === ";") {
      ended = true;
      i++;
    } else if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      let j = i + 1;
      // A doubled quote inside a quoted string is an escaped quote.
      while (j < text.length && !(text[j] === close && text[j + 1] !== close)) j += text[j] === close ? 2 : 1;
      i = j + 1;
    } else {
      const word = /^[A-Za-z_]+/.exec(text.slice(i))?.[0];
      if (first === null) first = (word ?? c).toUpperCase();
      i += word ? word.length : 1;
    }
  }
  if (first === null) return "the query is empty";
  if (!READ_ONLY.has(first)) return `piss sql runs read-only queries: start with ${[...READ_ONLY].join(", ")}, not ${first}`;
  return null;
}

const cut = (v, max) => {
  if (v instanceof Uint8Array) return `(blob, ${v.length} bytes)`;
  return typeof v === "string" && v.length > max ? `${v.slice(0, max)}… (+${v.length - max} chars; --max-cell for more)` : v;
};

/**
 * Column names made unique: rows as objects keep only the last of two columns
 * named alike (`SELECT p.model, u.model`), so later ones get " (2)", " (3)".
 */
export function uniqueNames(names) {
  const seen = new Map();
  return names.map((name) => {
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    return n === 1 ? name : `${name} (${n})`;
  });
}

function* asObjects(stmt) {
  stmt.setReturnArrays(true);
  const names = uniqueNames(stmt.columns().map((c) => c.name));
  for (const row of stmt.iterate()) yield Object.fromEntries(names.map((name, i) => [name, row[i]]));
}

/**
 * One page of rows: skips `offset`, keeps up to `limit` rows with every value
 * cut at `maxCell`, and stops before the page passes `maxChars` (one row is
 * always kept, so a page cannot be empty). Rows are still counted to report
 * the total, up to COUNT_CAP.
 */
export function pageRows(rows, { offset = 0, limit = 200, maxCell = 2000, maxChars = 50_000 } = {}) {
  const page = [];
  let total = 0;
  let chars = 0;
  let full = false;
  for (const row of rows) {
    total++;
    if (total > offset && page.length < limit && !full) {
      const kept = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, cut(v, maxCell)]));
      const size = JSON.stringify(kept).length;
      if (page.length && chars + size > maxChars) full = true;
      else {
        page.push(kept);
        chars += size;
      }
    }
    if (total >= COUNT_CAP) break;
  }
  return { page, total, capped: total >= COUNT_CAP, full };
}

const display = (v) => {
  if (v == null) return "";
  if (typeof v === "number" && !Number.isInteger(v)) return String(Number(v.toFixed(6)));
  return String(v);
};

const whole = (value, flag, min) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) throw new PissError(`${flag} must be a whole number${min ? ` of at least ${min}` : ""}`);
  return n;
};

export async function run(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      limit: { type: "string", default: "200" },
      offset: { type: "string", default: "0" },
      "max-cell": { type: "string", default: "2000" },
      "max-chars": { type: "string", default: "50000" },
      wide: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (positionals.length !== 1) throw new PissError('sql needs one query in quotes: piss sql "SELECT ..."');
  const opts = {
    limit: whole(values.limit, "--limit", 0),
    offset: whole(values.offset, "--offset", 0),
    maxCell: whole(values["max-cell"], "--max-cell", 1),
    maxChars: whole(values["max-chars"], "--max-chars", 1),
  };
  const problem = statementProblem(positionals[0]);
  if (problem) throw new PissError(problem);

  const corpus = openCorpus();
  const { db } = corpus;
  // A second guard behind the statement check: no write of any kind.
  db.exec("PRAGMA query_only = ON");
  // Freshness and coverage go with every answer; on stderr for JSON so the
  // output stays parseable.
  const header = headerLines(corpus).join("\n");
  if (values.json) console.error(header);
  else console.log(`${header}\n`);
  let result;
  try {
    result = pageRows(asObjects(db.prepare(positionals[0])), opts);
  } catch (err) {
    throw new PissError(err.message);
  }
  const { page, total, capped, full } = result;
  const shownTotal = capped ? `${COUNT_CAP}+` : String(total);
  const last = opts.offset + page.length;
  const footer =
    last < total
      ? `rows ${page.length ? `${opts.offset + 1}-${last}` : "none"} of ${shownTotal}` +
        (full ? ` (page stopped at --max-chars ${opts.maxChars})` : "") +
        (page.length || opts.limit ? `; next page: --offset ${last}` : "")
      : `${total} rows`;

  if (values.json) {
    console.log(JSON.stringify(page, null, 2));
    if (last < total) console.error(`piss: ${footer}`);
    return 0;
  }
  if (!page.length) {
    console.log(total ? footer : "no rows");
    return 0;
  }
  const keys = Object.keys(page[0]);
  const numeric = keys.map((k) => page.every((r) => r[k] == null || typeof r[k] === "number"));
  const max = values.wide ? opts.maxCell : 80;
  console.log(
    table(
      page,
      keys.map((k, i) => ({ label: k, get: (r) => oneLine(display(r[k]), max), right: numeric[i], max })),
    ),
  );
  console.log(`\n${footer}`);
  return 0;
}
