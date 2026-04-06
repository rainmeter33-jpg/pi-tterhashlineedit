/**
 * fuzzy-anchor.ts — Fuzzy anchor recovery.
 *
 * When an anchor hash fails to match, search nearby lines (±N) for one
 * that matches the expected hash. This recovers from small insertions
 * or deletions that shifted line numbers.
 */

import { computeLineHash, type Anchor } from "./hashline";

export interface FuzzyRecovery {
	/** The recovered anchor with the correct line number. */
	anchor: Anchor;
	/** How many lines the anchor shifted (positive = moved down). */
	offset: number;
	/** The content of the line at the recovered position. */
	content: string;
}

export interface FuzzyRecoveryResult {
	/** All anchors that were successfully recovered. */
	recovered: FuzzyRecovery[];
	/** Anchors that could not be recovered (no match found in window). */
	unrecovered: Array<{ anchor: Anchor; searchedRange: [number, number] }>;
}

/**
 * Default search window: look ±3 lines around the original position.
 */
const DEFAULT_WINDOW = 3;

/**
 * Try to recover a stale anchor by searching nearby lines.
 *
 * @param anchor - The original anchor with expected line and hash.
 * @param fileLines - The current file content split by newlines.
 * @param window - How many lines to search above and below (default: 3).
 * @returns A FuzzyRecovery if found, or null.
 */
export function tryFuzzyRecoverAnchor(
	anchor: Anchor,
	fileLines: string[],
	window: number = DEFAULT_WINDOW,
): FuzzyRecovery | null {
	const minLine = Math.max(1, anchor.line - window);
	const maxLine = Math.min(fileLines.length, anchor.line + window);

	for (let line = anchor.line; line <= maxLine; line++) {
		const actualHash = computeLineHash(line, fileLines[line - 1]!);
		if (actualHash === anchor.hash) {
			return {
				anchor: { line, hash: anchor.hash },
				offset: line - anchor.line,
				content: fileLines[line - 1]!,
			};
		}
	}

	for (let line = anchor.line - 1; line >= minLine; line--) {
		const actualHash = computeLineHash(line, fileLines[line - 1]!);
		if (actualHash === anchor.hash) {
			return {
				anchor: { line, hash: anchor.hash },
				offset: line - anchor.line,
				content: fileLines[line - 1]!,
			};
		}
	}

	return null;
}

/**
 * Attempt fuzzy recovery on an array of anchors.
 *
 * Returns recovery results for each anchor.
 */
export function fuzzyRecoverAnchors(
	anchors: Anchor[],
	fileLines: string[],
	window: number = DEFAULT_WINDOW,
): FuzzyRecoveryResult {
	const recovered: FuzzyRecovery[] = [];
	const unrecovered: FuzzyRecoveryResult["unrecovered"] = [];

	for (const anchor of anchors) {
		const result = tryFuzzyRecoverAnchor(anchor, fileLines, window);
		if (result) {
			recovered.push(result);
		} else {
			const minLine = Math.max(1, anchor.line - window);
			const maxLine = Math.min(fileLines.length, anchor.line + window);
			unrecovered.push({
				anchor,
				searchedRange: [minLine, maxLine],
			});
		}
	}

	return { recovered, unrecovered };
}

/**
 * Apply fuzzy recovery to a single anchor ref.
 * Returns the original line#hash if recovery succeeds, or null.
 */
export function recoverAnchorRef(
	ref: string,
	expectedHash: string,
	expectedLine: number,
	fileLines: string[],
	window: number = DEFAULT_WINDOW,
): FuzzyRecovery | null {
	return tryFuzzyRecoverAnchor(
		{ line: expectedLine, hash: expectedHash },
		fileLines,
		window,
	);
}
