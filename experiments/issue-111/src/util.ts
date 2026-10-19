/** Small shared helpers: one definition each, so a copy cannot drift. */

export const sleep = (ms: number): Promise<void> =>
	ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

/** Render a boolean for the report. */
export const yesNo = (value: boolean): string => (value ? "sim" : "não");

/** A `--name value` argument, with a fallback. */
export function cliArgument(name: string, fallback: string): string {
	const index = process.argv.indexOf(`--${name}`);
	return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}
