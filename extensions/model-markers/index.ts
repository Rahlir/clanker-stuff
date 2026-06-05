/**
 * model-markers
 *
 * Persists model and thinking-level changes as inline custom messages so they
 * remain visible after session reload, /resume, /tree branch navigation, /fork.
 *
 * Design notes:
 * - Uses pi.sendMessage with default options (no triggerTurn). The injected
 *   message is appended to the session and does not trigger an agent response.
 * - A single "settings-marker" customType holds both model and thinking-level
 *   changes. When both change between turns, they collapse into one marker.
 * - Cycling spam is squashed by deferring persistence of "set"/"cycle" model
 *   changes (and all thinking-level changes) until the next before_agent_start.
 *   Rapid cycling between two prompts produces exactly one marker. The actual
 *   triggering source (set vs cycle) is preserved in the persisted marker.
 * - "restore" model changes persist immediately, gated by per-branch dedupe.
 * - /tree navigation does NOT fire session_start, so a session_tree handler
 *   re-syncs cached state from the new branch and emits a marker for the
 *   newly active settings if needed. A `branchSwitched` flag (set in
 *   session_before_tree, cleared on the first reinit afterwards) lets
 *   model_select "restore" perform a full reinit if it happens to fire after
 *   a tree switch in some future pi version. Today pi only emits session_tree
 *   for /tree, so the flag path is defensive, not load-bearing.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

const SETTINGS_MARKER = "settings-marker";

const ROBOT = "\u{F167A}";
const BRAIN = "\u{F09D1}";

type ChangeSource = "set" | "cycle" | "restore";

interface FieldChange {
  to: string;
  from?: string;
}

interface SettingsMarkerDetails {
  model?: FieldChange;
  thinking?: FieldChange;
  source: ChangeSource;
}

function modelKey(provider: string, id: string): string {
  return `${provider}/${id}`;
}

/** Label used for both the rendered line and the persisted plain-text content. */
function modelLabel(source: ChangeSource, hasFrom: boolean): string {
  return source === "restore" || !hasFrom ? "Active model" : "Switched to";
}

/** Walk branch (leaf → root), return the latest persisted model id from a settings marker. */
function latestPersistedModel(ctx: ExtensionContext): string | undefined {
  const branch = ctx.sessionManager.getBranch(); // [root, ..., leaf]
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== "custom_message" || entry.customType !== SETTINGS_MARKER) continue;
    const d = entry.details as SettingsMarkerDetails | undefined;
    if (d?.model?.to) return d.model.to;
  }
  return undefined;
}

/** Walk branch (leaf → root), return the latest persisted thinking level from a settings marker. */
function latestPersistedThinking(ctx: ExtensionContext): string | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== "custom_message" || entry.customType !== SETTINGS_MARKER) continue;
    const d = entry.details as SettingsMarkerDetails | undefined;
    if (d?.thinking?.to) return d.thinking.to;
  }
  return undefined;
}

/**
 * Latest pi-built-in thinking_level_change entry on the branch (for state init).
 *
 * Intentionally reads built-in entries rather than our marker entries: if a user
 * changes the thinking level and exits without ever sending a prompt, no marker
 * was ever persisted (deferred persist never ran). On resume we still want to
 * know the active thinking level, which pi records in thinking_level_change
 * regardless of whether before_agent_start ever fired.
 */
function latestSessionThinking(ctx: ExtensionContext): string | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === "thinking_level_change") return entry.thinkingLevel;
  }
  return undefined;
}

function modelLine(theme: Theme, change: FieldChange, source: ChangeSource): string {
  const label = modelLabel(source, !!change.from);
  return change.from
    ? `${ROBOT} ${label}: ${theme.fg("accent", change.to)} ${theme.fg("dim", `(was ${change.from})`)}`
    : `${ROBOT} ${label}: ${theme.fg("accent", change.to)}`;
}

function thinkingLine(theme: Theme, change: FieldChange): string {
  return change.from
    ? `${BRAIN} Thinking: ${theme.fg("accent", change.to)} ${theme.fg("dim", `(was ${change.from})`)}`
    : `${BRAIN} Thinking: ${theme.fg("accent", change.to)}`;
}

export default function (pi: ExtensionAPI) {
  let currentModel: string | undefined;
  let lastPersistedModel: string | undefined;
  let currentThinking: string | undefined;
  let lastPersistedThinking: string | undefined;
  // Source of the next deferred persist. Updated by model_select for
  // non-restore changes so cycle vs set is preserved in stored history.
  let pendingSource: ChangeSource = "set";
  // Set in session_before_tree, cleared on the next reinit. Lets model_select
  // "restore" detect that a branch switch is in progress and do a full reinit
  // (rather than relying on session_start, which doesn't fire for /tree).
  let branchSwitched = false;

  // --- renderers ---------------------------------------------------------

  pi.registerMessageRenderer<SettingsMarkerDetails>(SETTINGS_MARKER, (msg, _opts, theme) => {
    const d = msg.details;
    if (!d) return undefined;
    const lines: string[] = [];
    if (d.model) lines.push(modelLine(theme, d.model, d.source));
    if (d.thinking) lines.push(thinkingLine(theme, d.thinking));
    if (lines.length === 0) return undefined;
    const box = new Box(0, 1, (t) => theme.bg("customMessageBg", t));
    box.addChild(new Text(lines.join("\n"), 0, 0));
    return box;
  });

  // --- persistence -------------------------------------------------------

  function buildContentLine(prefix: string, label: string, to: string, from: string | undefined): string {
    return from ? `${prefix} ${label}: ${to} (was ${from})` : `${prefix} ${label}: ${to}`;
  }

  function persistPending(source: ChangeSource) {
    const modelChanged = !!currentModel && currentModel !== lastPersistedModel;
    const thinkingChanged = !!currentThinking && currentThinking !== lastPersistedThinking;
    if (!modelChanged && !thinkingChanged) return;

    const details: SettingsMarkerDetails = { source };
    const contentLines: string[] = [];

    if (modelChanged) {
      const change: FieldChange = { to: currentModel!, from: lastPersistedModel };
      details.model = change;
      contentLines.push(buildContentLine(ROBOT, modelLabel(source, !!change.from), change.to, change.from));
    }
    if (thinkingChanged) {
      const change: FieldChange = { to: currentThinking!, from: lastPersistedThinking };
      details.thinking = change;
      contentLines.push(buildContentLine(BRAIN, "Thinking", change.to, change.from));
    }

    pi.sendMessage<SettingsMarkerDetails>({
      customType: SETTINGS_MARKER,
      content: contentLines.join("\n"),
      display: true,
      details,
    });

    if (modelChanged) lastPersistedModel = currentModel;
    if (thinkingChanged) lastPersistedThinking = currentThinking;
  }

  /**
   * Re-derive all cached state from the current branch. Called after any
   * event that may have switched the active leaf (session_start, session_tree,
   * or model_select "restore" while a tree switch is in flight).
   *
   * Resets `pendingSource` to "set" because any deferred cycle/set on the
   * previous branch is intentionally discarded: the user navigated away
   * before sending a prompt with that change, so it never took effect.
   */
  function reinitFromBranch(ctx: ExtensionContext) {
    currentModel = ctx.model ? modelKey(ctx.model.provider, ctx.model.id) : undefined;
    currentThinking = latestSessionThinking(ctx);
    lastPersistedModel = latestPersistedModel(ctx);
    lastPersistedThinking = latestPersistedThinking(ctx);
    pendingSource = "set";
    branchSwitched = false;
  }

  // --- events ------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    reinitFromBranch(ctx);
  });

  pi.on("session_before_tree", async (_event, _ctx) => {
    // Mark that a branch switch is starting. Whichever handler fires first
    // after this (session_tree or a hypothetical post-tree model_select)
    // will perform a full reinit and clear the flag.
    branchSwitched = true;
  });

  pi.on("session_tree", async (_event, ctx) => {
    // /tree navigation doesn't fire session_start. Re-sync cached state
    // from the new branch and persist a marker if the active settings
    // have no marker yet on this branch. reinitFromBranch clears
    // branchSwitched so a subsequent model_select "restore" (if pi ever
    // starts emitting one for /tree) won't double-reinit.
    reinitFromBranch(ctx);
    persistPending("restore");
  });

  pi.on("model_select", async (event, ctx) => {
    if (event.source === "restore") {
      if (branchSwitched) {
        // A branch switch happened and our session_tree handler hasn't
        // run yet (current pi never produces this ordering, but it's
        // cheap insurance). Full reinit so currentThinking, dedupe, and
        // every other piece of cached state come from the new branch.
        reinitFromBranch(ctx);
      }
      currentModel = modelKey(event.model.provider, event.model.id);
      persistPending("restore");
    } else {
      currentModel = modelKey(event.model.provider, event.model.id);
      // "set" / "cycle" are deferred to before_agent_start. Track the
      // triggering source so the persisted marker reflects it accurately.
      pendingSource = event.source;
    }
  });

  pi.on("thinking_level_select", async (event, _ctx) => {
    currentThinking = event.level;
    // Always deferred; thinking_level_select has no "restore" source.
  });

  pi.on("before_agent_start", async (_event, _ctx) => {
    persistPending(pendingSource);
    pendingSource = "set"; // Reset after persisting.
  });
}
