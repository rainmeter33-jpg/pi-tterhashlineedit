/**
 * semantic-diff.ts — Semantic diff that ignores whitespace-only changes.
 *
 * Provides a diff that filters out changes where the only difference
 * is indentation or trailing whitespace. Shows only "real" content changes.
 */

import * as Diff from "diff";

export interface SemanticDiffLine {
	/** Line number in the old content (undefined for additions). */
	oldLineNum?: number;
	/** Line number in the new content (undefined for deletions). */
	newLineNum?: number;
	/** "add" | "remove" | "context" | "whitespace-only" */
	kind: "add" | "remove" | "context" | "whitespace-only";
	/** The line content (without prefix). */
	content: string;
	/** The original diff line with prefix. */
	prefixed: string;
}

export interface SemanticDiffResult {
	/** Full diff string (same as normal diff). */
	fullDiff: string;
	/** Semantic diff string — whitespace-only changes shown dimmed/separate. */
	semanticDiff: string;
	/** Total lines added (excluding whitespace-only). */
	realAddedLines: number;
	/** Total lines removed (excluding whitespace-only). */
	realRemovedLines: number;
	/** Lines that changed in content only (not just whitespace). */
	contentChanges: number;
	/** Lines that only had whitespace differences. */
	whitespaceOnlyChanges: number;
	/** Whether the diff contains only whitespace changes. */
	isWhitespaceOnly: boolean;
}

/**
 * Check if two strings differ only in whitespace.
 */
function isWhitespaceOnlyChange(a: string, b: string): boolean {
	const strippedA = a.replace(/\s/g, "");
	const strippedB = b.replace(/\s/g, "");
	return strippedA === strippedB && a !== b;
}

/**
 * Generate a semantic diff between two strings.
 * Whitespace-only changes are detected and reported separately.
 */
export function generateSemanticDiff(
	oldContent: string,
	newContent: string,
	contextLines: number = 3,
): SemanticDiffResult {
	const changes = Diff.diffLines(oldContent, newContent);

	const lines: SemanticDiffLine[] = [];
	let oldLineNum = 1;
	let newLineNum = 1;
	let realAdded = 0;
	let realRemoved = 0;
	let contentChanges = 0;
	let whitespaceChanges = 0;

	// Collect all changes into a flat list
	const hunks: Array<{
		type: "context" | "add" | "remove";
		lines: string[];
	}> = [];

	for (const change of changes) {
		const raw = change.value.replace(/\n$/, "").split("\n");
		if (raw.length === 1 && raw[0] === "") {
			if (change.value.endsWith("\n")) {
				// trailing newline
			}
			continue;
		}

		if (change.added) {
			hunks.push({ type: "add", lines: raw });
		} else if (change.removed) {
			hunks.push({ type: "remove", lines: raw });
		} else {
			hunks.push({ type: "context", lines: raw });
		}
	}

	// Detect paired remove+add that are whitespace-only
	for (let i = 0; i < hunks.length; i++) {
		const hunk = hunks[i]!;
		if (hunk.type === "context") {
			for (const line of hunk.lines) {
				lines.push({
					oldLineNum: oldLineNum++,
					newLineNum: newLineNum++,
					kind: "context",
					content: line,
					prefixed: ` ${line}`,
				});
			}
		} else if (hunk.type === "remove") {
			const nextHunk = hunks[i + 1];
			if (nextHunk && nextHunk.type === "add") {
				// Pair remove with add
				const maxLen = Math.max(hunk.lines.length, nextHunk.lines.length);
				let allWhitespaceOnly = true;

				for (let j = 0; j < maxLen; j++) {
					const oldLine = hunk.lines[j];
					const newLine = nextHunk.lines[j];

					if (oldLine && newLine) {
						const wsOnly = isWhitespaceOnlyChange(oldLine, newLine);
						if (!wsOnly) allWhitespaceOnly = false;

						if (wsOnly) {
							whitespaceChanges++;
							lines.push({
								oldLineNum: oldLineNum++,
								newLineNum: newLineNum++,
								kind: "whitespace-only",
								content: newLine,
								prefixed: `~${newLine}`,
							});
						} else {
							contentChanges++;
							realRemoved++;
							realAdded++;
							lines.push({
								oldLineNum: oldLineNum++,
								kind: "remove",
								content: oldLine,
								prefixed: `-${oldLine}`,
							});
							lines.push({
								newLineNum: newLineNum++,
								kind: "add",
								content: newLine,
								prefixed: `+${newLine}`,
							});
						}
					} else if (oldLine) {
						contentChanges++;
						realRemoved++;
						lines.push({
							oldLineNum: oldLineNum++,
							kind: "remove",
							content: oldLine,
							prefixed: `-${oldLine}`,
						});
					} else if (newLine) {
						contentChanges++;
						realAdded++;
						lines.push({
							newLineNum: newLineNum++,
							kind: "add",
							content: newLine,
							prefixed: `+${newLine}`,
						});
					}
				}
				i++; // skip the paired add hunk
			} else {
				// Unpaired remove
				for (const line of hunk.lines) {
					contentChanges++;
					realRemoved++;
					lines.push({
						oldLineNum: oldLineNum++,
						kind: "remove",
						content: line,
						prefixed: `-${line}`,
					});
				}
			}
		} else if (hunk.type === "add") {
			// Unpaired add (not preceded by remove)
			for (const line of hunk.lines) {
				contentChanges++;
				realAdded++;
				lines.push({
					newLineNum: newLineNum++,
					kind: "add",
					content: line,
					prefixed: `+${line}`,
				});
			}
		}
	}

	// Build semantic diff output
	const semanticLines: string[] = [];
	for (const line of lines) {
		semanticLines.push(line.prefixed);
	}

	// Build full diff
	const fullDiff = Diff.createPatch(
		"file",
		oldContent,
		newContent,
		"original",
		"modified",
	);

	return {
		fullDiff,
		semanticDiff: semanticLines.join("\n"),
		realAddedLines: realAdded,
		realRemovedLines: realRemoved,
		contentChanges,
		whitespaceOnlyChanges: whitespaceChanges,
		isWhitespaceOnly: contentChanges === 0 && whitespaceChanges > 0,
	};
}
