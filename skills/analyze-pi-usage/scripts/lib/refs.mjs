// Hover-card data for the sessions a report cites, from the pi-sessions corpus.

import { displayText } from "../../../pi-sessions/scripts/lib/commands/prompts.mjs";
import { hours, int, localStamp, money, oneLine } from "../../../pi-sessions/scripts/lib/format.mjs";
import { repoLabel } from "./charts.mjs";

/** `{ ref: { name, meta, prompt } }` for every ref found in the corpus; whole-session totals. */
export function refInfo(db, refs) {
  if (!refs.length) return {};
  const rows = db
    .prepare(
      `SELECT s.ref, s.name, s.created, s.last_activity, s.repo,
         (SELECT count(*) FROM turns t WHERE t.ref = s.ref) turns,
         (SELECT count(*) FROM prompts p WHERE p.ref = s.ref) prompts,
         (SELECT coalesce(sum(cost_corrected), 0) FROM usage_events u WHERE u.ref = s.ref) cost,
         (SELECT coalesce(sum(user_s), 0) FROM active_time a WHERE a.ref = s.ref) user_s,
         (SELECT coalesce(sum(agent_s), 0) FROM active_time a WHERE a.ref = s.ref) agent_s
       FROM sessions s WHERE s.ref IN (${refs.map(() => "?").join(",")})`,
    )
    .all(...refs);
  const first = db.prepare("SELECT text, template, skill, template_match, args FROM prompts WHERE ref = ? ORDER BY ts LIMIT 1");
  const out = {};
  for (const r of rows) {
    const p = first.get(r.ref);
    const prompt = p ? displayText(p) : "";
    out[r.ref] = {
      name: r.name ?? (p?.template ? `/${p.template}` : oneLine(prompt, 60)),
      meta:
        `${localStamp(r.created)} to ${localStamp(r.last_activity).slice(5)} · ${repoLabel(r.repo)} · ` +
        `${int(r.prompts)} prompts, ${int(r.turns)} turns · ${money(r.cost)} · you ${hours(r.user_s)}, agent ${hours(r.agent_s)}`,
      prompt: oneLine(prompt, 240),
    };
  }
  return out;
}
