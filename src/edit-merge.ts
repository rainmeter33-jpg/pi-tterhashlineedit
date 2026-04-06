/**
 * edit-merge.ts — Intelligent merge of overlapping edits.
 *
 * When two edits target overlapping line ranges, instead of rejecting
 * them outright, merge them into a single combined edit.
 */

import type { Anchor, HashlineEdit } from "./hashline";

export interface MergeResult {
	/** Successfully merged edits (non-overlapping, ready to apply). */
	edits: HashlineEdit[];
	/** Warnings about what was merged. */
	warnings: string[];
}

interface EditSpan {
	edit: HashlineEdit;
	index: number;
	startLine: number;
	endLine: number;
}

/**
 * Get the span (start/end line) of an edit.
 */
function getEditSpan(edit: HashlineEdit): { startLine: number; endLine: number } {
	switch (edit.op) {
		case "replace":
			return {
				startLine: edit.pos.line,
				endLine: edit.end?.line ?? edit.pos.line,
			};
		case "append":
			return {
				startLine: edit.pos ? edit.pos.line + 1 : Infinity,
				endLine: edit.pos ? edit.pos.line + 1 : Infinity,
			};
		case "prepend":
			return {
				startLine: edit.pos ? edit.pos.line : 0,
				endLine: edit.pos ? edit.pos.line : 0,
			};
	}
}

/**
 * Check if two spans overlap.
 */
function spansOverlap(a: EditSpan, b: EditSpan): boolean {
	if (a.startLine === Infinity || b.startLine === Infinity) return false;
	if (a.startLine === 0 && a.endLine === 0) return false;
	if (b.startLine === 0 && b.endLine === 0) return false;
	return a.startLine <= b.endLine && b.startLine <= a.endLine;
}

/**
 * Merge overlapping replace edits into a single combined edit.
 * Takes the union of the line ranges and concatenates replacement lines
 * (deduplicating overlapping content).
 */
function mergeReplacePair(
	left: EditSpan,
	right: EditSpan,
): { edit: HashlineEdit; warning: string } {
	const leftEdit = left.edit as Extract<HashlineEdit, { op: "replace" }>;
	const rightEdit = right.edit as Extract<HashlineEdit, { op: "replace" }>;

	const startLine = Math.min(left.startLine, right.startLine);
	const endLine = Math.max(left.endLine, right.endLine);

	// Merge replacement lines: use left's lines for the left portion,
	// right's lines for the right portion, preferring later edits for overlap
	const mergedLines: string[] = [];

	// Simple strategy: concatenate both sets of replacement lines
	// If they overlap in target range, the right edit takes precedence
	// in the overlapping region
	const leftOffset = startLine - left.startLine;
	const rightOffset = startLine - right.startLine;

	for (let line = startLine; line <= endLine; line++) {
		const inLeftRange = line >= left.startLine && line <= left.endLine;
		const inRightRange = line >= right.startLine && line <= right.endLine;

		if (inLeftRange && inRightRange) {
			// Right edit takes precedence in overlap
			const rightIdx = line - right.startLine;
			if (rightIdx < rightEdit.lines.length) {
				mergedLines.push(rightEdit.lines[rightIdx]!);
			}
		} else if (inRightRange) {
			const rightIdx = line - right.startLine;
			if (rightIdx < rightEdit.lines.length) {
				mergedLines.push(rightEdit.lines[rightIdx]!);
			}
		} else if (inLeftRange) {
			const leftIdx = line - left.startLine;
			if (leftIdx < leftEdit.lines.length) {
				mergedLines.push(leftEdit.lines[leftIdx]!);
			}
		}
	}

	// Use the anchor from the start position (leftmost)
	const pos: Anchor = startLine === left.startLine ? leftEdit.pos : rightEdit.pos;
	const end: Anchor | undefined =
		endLine === left.endLine
			? leftEdit.end ?? leftEdit.pos
			: rightEdit.end ?? rightEdit.pos;

	return {
		edit: {
			op: "replace",
			pos,
			...(end && end.line !== pos.line ? { end } : {}),
			lines: mergedLines,
		},
		warning:
			`Auto-merged overlapping edits: ` +
			`edit ${left.index} (lines ${left.startLine}-${left.endLine}) + ` +
			`edit ${right.index} (lines ${right.startLine}-${right.endLine}) → ` +
			`lines ${startLine}-${endLine}`,
	};
}

/**
 * Merge overlapping edits intelligently.
 *
 * Non-overlapping edits are passed through unchanged.
 * Overlapping replace edits are merged into a single edit.
 * Insert edits that conflict are kept as-is (appends at the same position
 * are applied in order).
 *
 * @param edits - The original edits that may overlap.
 * @returns Merged non-overlapping edits and warnings.
 */
export function mergeOverlappingEdits(edits: HashlineEdit[]): MergeResult {
	if (edits.length <= 1) {
		return { edits: [...edits], warnings: [] };
	}

	// Build spans
	const spans: EditSpan[] = edits.map((edit, index) => {
		const { startLine, endLine } = getEditSpan(edit);
		return { edit, index, startLine, endLine };
	});

	// Sort by start line
	spans.sort((a, b) => a.startLine - b.startLine || a.index - b.index);

	const merged: HashlineEdit[] = [];
	const warnings: string[] = [];
	let i = 0;

	while (i < spans.length) {
		const current = spans[i]!;

		// Only replace edits can be merged
		if (current.edit.op !== "replace") {
			merged.push(current.edit);
			i++;
			continue;
		}

		// Look ahead for overlapping replace edits
		let accumulator = current;
		let j = i + 1;

		while (j < spans.length && spans[j]!.edit.op === "replace") {
			if (spansOverlap(accumulator, spans[j]!)) {
				const result = mergeReplacePair(accumulator, spans[j]!);
				const newSpan = getEditSpan(result.edit);
				accumulator = {
					edit: result.edit,
					index: accumulator.index,
					startLine: newSpan.startLine,
					endLine: newSpan.endLine,
				};
				warnings.push(result.warning);
				j++;
			} else {
				break;
			}
		}

		merged.push(accumulator.edit);
		i = j;
	}

	return { edits: merged, warnings };
}
