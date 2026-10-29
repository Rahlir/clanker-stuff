/**
 * Session naming policy for MR reviews. It only decides the name; the caller
 * applies it with `pi.setSessionName`.
 *
 * Call `setSessionName` only when `nextSessionName` returns a name. Every call
 * adds an entry to the session file, even if the name did not change.
 */

// Only names matching this are ours to overwrite; anything else the user chose.
const OWN_NAME = /^mr-\d+-review$/;

/**
 * `mr-123-review`, or undefined when the ref is not a plain MR number.
 *
 * `/mr-review` takes whatever `glab mr` accepts (id, branch, URL). Only a number
 * gives a stable, readable name, so everything else leaves the session unnamed.
 */
export function reviewSessionName(mr: string): string | undefined {
	const n = mr.trim().replace(/^[!#]/, "");
	return /^\d+$/.test(n) ? `mr-${n}-review` : undefined;
}

/**
 * The name to apply, or undefined to leave the session alone.
 *
 * Overwrites only an unset name or one this function generated, so a name the
 * user picked (`/name`, session picker) is never clobbered.
 */
export function nextSessionName(current: string | undefined, mr: string): string | undefined {
	const wanted = reviewSessionName(mr);
	if (!wanted || wanted === current) return undefined;
	if (current && !OWN_NAME.test(current)) return undefined;
	return wanted;
}
