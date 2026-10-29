#!/usr/bin/env node
// piss - build and query a corpus of pi session logs (the pi-sessions skill).

import { takeCorpusFlag } from "./lib/config.mjs";
import { PissError } from "./lib/load.mjs";

const COMMANDS = ["build", "facts", "prompts", "show", "find", "outcomes", "tag", "sql"];

const load = (name) => import(`./lib/commands/${name}.mjs`);

async function usage() {
  const lines = ["piss - build and query a corpus of pi session logs", "", "Usage: piss <command> [options]", "", "Commands:"];
  for (const name of COMMANDS) lines.push(`  ${name.padEnd(9)}${(await load(name)).summary}`);
  lines.push(
    "",
    "Run piss <command> --help for options.",
    "Times: 90d, 2w, 3m, 12h, YYYY-MM-DD (local midnight), an ISO timestamp, now, all;",
    "  --until built means the end of the corpus's range, and a relative --since counts",
    "  back from --until (--since 30d --until built: the 30 days the corpus ends with).",
    "Every command takes --corpus PATH (or PISS_CORPUS) to use a corpus other than the shared one.",
  );
  return lines.join("\n");
}

async function main(argv) {
  const [command, ...rest] = takeCorpusFlag(argv);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(await usage());
    return 0;
  }
  if (!COMMANDS.includes(command)) {
    console.error(`piss: unknown command "${command}"\n\n${await usage()}`);
    return 2;
  }
  const cmd = await load(command);
  // Only right after the command, so a query or search term may contain "--help".
  if (rest[0] === "--help" || rest[0] === "-h") {
    console.log(cmd.usage);
    return 0;
  }
  return cmd.run(rest);
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  if (err instanceof PissError || String(err?.code).startsWith("ERR_PARSE_ARGS")) {
    console.error(`piss: ${err.message}`);
  } else {
    console.error(String(err?.stack ?? err).slice(0, 4000));
  }
  process.exitCode = 1;
}
