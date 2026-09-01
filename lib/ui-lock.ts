/**
 * Process-wide mutual exclusion for pi's interactive UI surfaces.
 *
 * pi provides none of its own: ctx.ui.custom, ctx.ui.editor, ctx.ui.confirm and
 * ctx.ui.select all clear and repopulate the same editor container, so opening a
 * second one while the first is up evicts the first from the component tree. The
 * evicted component can never receive the keystroke that resolves it, so its
 * promise stays pending for the rest of the session and whoever awaited it hangs.
 *
 * Tools that open UI avoid this by declaring `executionMode: "sequential"`, which
 * makes pi run their whole tool batch one call at a time. This lock is the
 * backstop for what that cannot cover: slash commands, and future callers that
 * forget the flag. It converts a silent permanent hang into a loud error.
 *
 * The state lives on globalThis rather than in module scope because pi loads each
 * extension through its own jiti instance with the module cache disabled, so every
 * extension gets a SEPARATE copy of this module.
 */

const LOCK_KEY = Symbol.for("clanker-stuff.ui-lock");

interface LockState {
	/** Label of the UI currently on screen, or null when nothing is open. */
	owner: string | null;
}

function lockState(): LockState {
	const g = globalThis as unknown as Record<symbol, LockState | undefined>;
	const existing = g[LOCK_KEY];
	if (existing) return existing;
	const created: LockState = { owner: null };
	g[LOCK_KEY] = created;
	return created;
}

/**
 * Run `open` with the interactive UI held exclusively.
 *
 * `owner` is a human-readable label for the UI being opened; it appears in the
 * error a blocked caller gets. It is display only, not an identity: callers pass
 * per-call titles (and `annotate_text` passes a model-supplied one), so two opens
 * of the same UI usually carry different labels. Throws instead of queueing: waiting
 * would just move the hang, and a concurrent open means the caller has a bug
 * (a UI tool missing `executionMode: "sequential"`) that should surface.
 */
export async function withUiLock<T>(owner: string, open: () => Promise<T>): Promise<T> {
	const state = lockState();
	if (state.owner !== null) {
		throw new Error(
			`Cannot open "${owner}": the interactive UI is already showing "${state.owner}". ` +
				`Only one can be open at a time; a tool that opens UI must declare executionMode: "sequential".`,
		);
	}
	state.owner = owner;
	try {
		return await open();
	} finally {
		state.owner = null;
	}
}

/** Label of the UI currently holding the lock, or null. Exposed for tests. */
export function currentUiLockOwner(): string | null {
	return lockState().owner;
}
