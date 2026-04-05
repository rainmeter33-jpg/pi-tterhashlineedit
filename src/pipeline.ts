/**
 * pipeline.ts — Reliable 7-stage hashline edit pipeline.
 *
 * Stages: read → anchor → validate → simulate → revalidate → write → verify
 *
 * Supports dual context anchors (anchor1, anchor2) for sandwich validation
 * around edit zones, simulation-only mode, and post-write verification.
 */

import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile } from "fs/promises";
import { generateDiffString, normalizeToLF, stripBom } from "./edit-diff";
import { writeFileAtomically } from "./fs-write";
import {
	applyHashlineEdits,
	computeLineHash,
	detectIndentation,
	parseLineRef,
	resolveEditAnchors,
	type Anchor,
	type HashlineEdit,
	type HashlineToolEdit,
	validateIndentationConsistency,
} from "./hashline";
import { throwIfAborted } from "./runtime";

// ─── Types ──────────────────────────────────────────────────────────────

/** Edit item extended with optional dual context anchors. */
export interface DualAnchorToolEdit extends HashlineToolEdit {
	/** First context anchor (LINE#HASH) — typically before the edit zone. */
	anchor1?: string;
	/** Second context anchor (LINE#HASH) — typically after the edit zone. */
	anchor2?: string;
}

export type PipelineStage =
	| "read"
	| "anchor"
	| "validate"
	| "simulate"
	| "revalidate"
	| "write"
	| "verify";

export interface StageResult {
	stage: PipelineStage;
	passed: boolean;
	durationMs: number;
	message: string;
}

export interface PipelineResult {
	success: boolean;
	stages: StageResult[];
	/** Original file content (LF-normalized, BOM-stripped). */
	originalContent: string;
	/** Content after simulation (null if simulation was not reached). */
	simulatedContent: string | null;
	/** Content re-read after write (null if not written or not verified). */
	writtenContent: string | null;
	/** Unified diff between original and simulated content. */
	diff: string | null;
	warnings: string[];
	errors: string[];
	wrote: boolean;
	verified: boolean;
	firstChangedLine: number | undefined;
}

export interface PipelineOptions {
	/** Absolute path to the file (required for write and verify stages). */
	absolutePath?: string;
	/** If true, stop after simulate stage — no write. */
	simulateOnly?: boolean;
	/** If true, re-read the file after writing and compare. Default: true. */
	verifyAfterWrite?: boolean;
	/** Original BOM to restore before write. */
	bom?: string;
	/** Original line ending to restore. */
	lineEnding?: "\r\n" | "\n";
	/** AbortSignal for cancellation. */
	signal?: AbortSignal;
}

interface ResolvedContextAnchor {
	line: number;
	hash: string;
	content: string;
}

interface EditZone {
	startLine: number;
	endLine: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function stage(
	name: PipelineStage,
	fn: () => string,
): StageResult {
	const start = performance.now();
	const message = fn();
	const durationMs = Math.round((performance.now() - start) * 100) / 100;
	return { stage: name, passed: !message.startsWith("FAIL:"), durationMs, message };
}

function fail(msg: string): string {
	return `FAIL: ${msg}`;
}

function ok(msg: string): string {
	return msg;
}

/**
 * Parse optional context anchors from edit items.
 * Returns validated {line, hash, content} triples.
 */
function parseContextAnchors(
	edits: DualAnchorToolEdit[],
	fileLines: string[],
): {
	anchors: ResolvedContextAnchor[];
	errors: string[];
} {
	const anchors: ResolvedContextAnchor[] = [];
	const errors: string[] = [];

	for (const edit of edits) {
		for (const [key, ref] of [
			["anchor1", edit.anchor1],
			["anchor2", edit.anchor2],
		] as const) {
			if (!ref) continue;
			try {
				const parsed = parseLineRef(ref);
				if (parsed.line < 1 || parsed.line > fileLines.length) {
					errors.push(
						`${key} "${ref}": line ${parsed.line} is out of range (file has ${fileLines.length} lines).`,
					);
					continue;
				}
				anchors.push({
					line: parsed.line,
					hash: parsed.hash,
					content: fileLines[parsed.line - 1]!,
				});
			} catch (e) {
				errors.push(
					`${key} "${ref}": ${(e as Error).message}`,
				);
			}
		}
	}

	return { anchors, errors };
}

/**
 * Compute the set of edit zones (inclusive line ranges that will be modified).
 */
function computeEditZones(edits: HashlineEdit[]): EditZone[] {
	const zones: EditZone[] = [];
	for (const edit of edits) {
		switch (edit.op) {
			case "replace": {
				const start = edit.pos.line;
				const end = edit.end?.line ?? edit.pos.line;
				zones.push({ startLine: start, endLine: end });
				break;
			}
			case "append": {
				if (edit.pos) {
					// Append inserts AFTER pos.line — pos itself is not modified
					// No zone to mark
				}
				break;
			}
			case "prepend": {
				if (edit.pos) {
					// Prepend inserts BEFORE pos.line — pos itself is not modified
					// No zone to mark
				}
				break;
			}
		}
	}
	return zones;
}

/**
 * Check whether a line number falls inside any edit zone.
 */
function isLineInEditZone(line: number, zones: EditZone[]): boolean {
	return zones.some((z) => line >= z.startLine && line <= z.endLine);
}

/**
 * Validate that context anchors exist, match the current file content,
 * and are NOT inside any edit zone.
 */
function validateContextAnchors(
	anchors: ResolvedContextAnchor[],
	zones: EditZone[],
	fileLines: string[],
): string[] {
	const errors: string[] = [];

	for (const anchor of anchors) {
		const actualHash = computeLineHash(anchor.line, fileLines[anchor.line - 1]!);

		if (actualHash !== anchor.hash) {
			errors.push(
				`Context anchor ${anchor.line}#${anchor.hash}: stale hash ` +
					`(actual: ${actualHash}). File has changed since last read. ` +
					`Re-read the file and retry.`,
			);
			continue;
		}

		if (isLineInEditZone(anchor.line, zones)) {
			errors.push(
				`Context anchor ${anchor.line}#${anchor.hash}: this line is inside ` +
					`an edit zone and will be modified. Context anchors must reference ` +
					`lines OUTSIDE the edited range to provide reliable verification.`,
			);
		}
	}

	return errors;
}

/**
 * Revalidate context anchors in the simulated result.
 * The content of each anchor line should still exist in the simulated output.
 */
function revalidateContext(
	anchors: ResolvedContextAnchor[],
	simulatedLines: string[],
): string[] {
	const errors: string[] = [];

	for (const anchor of anchors) {
		const originalTrimmed = anchor.content.trimEnd();

		// Search the simulated content for this exact line
		const found = simulatedLines.some(
			(l) => l.trimEnd() === originalTrimmed,
		);

		if (!found) {
			errors.push(
				`Context anchor ${anchor.line}#${anchor.hash}: content ` +
					`"${originalTrimmed}" was lost during the edit. ` +
					`The edit may have unintentionally removed or modified surrounding context.`,
			);
		}
	}

	return errors;
}

/**
 * Re-read the file and compare with the expected content.
 */
async function verifyWrittenContent(
	filePath: string,
	expectedContent: string,
	signal?: AbortSignal,
): Promise<{ passed: boolean; errors: string[] }> {
	throwIfAborted(signal);

	try {
		await fsAccess(filePath, constants.R_OK);
	} catch {
		return {
			passed: false,
			errors: [`Post-write verification: file not readable at ${filePath}.`],
		};
	}

	throwIfAborted(signal);

	try {
		const raw = (await fsReadFile(filePath)).toString("utf-8");
		const { text: actual } = stripBom(raw);
		const normalized = normalizeToLF(actual);

		if (normalized === expectedContent) {
			return { passed: true, errors: [] };
		}

		// Compute which part differs
		const actualLines = normalized.split("\n");
		const expectedLines = expectedContent.split("\n");
		const maxLen = Math.max(actualLines.length, expectedLines.length);
		const diffs: string[] = [];

		for (let i = 0; i < maxLen; i++) {
			const a = actualLines[i];
			const e = expectedLines[i];
			if (a !== e) {
				diffs.push(
					`line ${i + 1}: expected ${e === undefined ? "(EOF)" : `"${e}"`}, ` +
						`got ${a === undefined ? "(EOF)" : `"${a}"`}`,
				);
				if (diffs.length >= 5) {
					diffs.push("... (more differences)");
					break;
				}
			}
		}

		return {
			passed: false,
			errors: [
				`Post-write verification failed: file content differs from simulation. ` +
					`Another process likely modified the file during the edit.\n${diffs.join("\n")}`,
			],
		};
	} catch (error) {
		return {
			passed: false,
			errors: [
				`Post-write verification: could not re-read file: ${(error as Error).message}`,
			],
		};
	}
}

// ─── Main pipeline ──────────────────────────────────────────────────────

/**
 * Execute the 7-stage hashline edit pipeline.
 *
 * Stages:
 *   1. read      — Normalize and split original content.
 *   2. anchor    — Parse all anchors (pos, end, anchor1, anchor2).
 *   3. validate  — Verify all anchors match the current file.
 *   4. simulate  — Apply edits in memory, compute diff.
 *   5. revalidate — Verify context anchors in simulated result.
 *   6. write     — Atomic write to disk.
 *   7. verify    — Re-read and compare with simulated content.
 *
 * Returns detailed results for each stage.
 */
export async function executeEditPipeline(
	content: string,
	toolEdits: DualAnchorToolEdit[],
	options: PipelineOptions = {},
): Promise<PipelineResult> {
	const {
		absolutePath,
		simulateOnly = false,
		verifyAfterWrite = true,
		bom = "",
		lineEnding = "\n",
		signal,
	} = options;

	const stages: StageResult[] = [];
	const warnings: string[] = [];
	const errors: string[] = [];
	let simulatedContent: string | null = null;
	let writtenContent: string | null = null;
	let diff: string | null = null;
	let wrote = false;
	let verified = false;
	let firstChangedLine: number | undefined;

	// ── Stage 1: READ ──────────────────────────────────────────────────
	const readStage = stage("read", () => {
		throwIfAborted(signal);
		const lines = content.split("\n");
		return ok(`Read ${lines.length} lines from file content.`);
	});
	stages.push(readStage);
	if (!readStage.passed) {
		errors.push(readStage.message);
		return buildResult(false);
	}

	// ── Stage 2: ANCHOR ────────────────────────────────────────────────
	let resolvedEdits: HashlineEdit[];
	const fileLines = content.split("\n");

	const anchorStage = stage("anchor", () => {
		throwIfAborted(signal);

		// Parse main edit anchors (pos, end)
		try {
			resolvedEdits = resolveEditAnchors(toolEdits);
		} catch (e) {
			return fail(`Anchor parsing failed: ${(e as Error).message}`);
		}

		// Parse context anchors (anchor1, anchor2)
		const { anchors: ctxAnchors, errors: ctxErrors } = parseContextAnchors(
			toolEdits,
			fileLines,
		);
		if (ctxErrors.length > 0) {
			return fail(
				`Context anchor errors: ${ctxErrors.join("; ")}`,
			);
		}

		const totalAnchors =
			resolvedEdits.reduce(
				(count, e) =>
					count +
					1 +
					(e.op === "replace" && e.end ? 1 : 0),
				0,
			) + ctxAnchors.length;

		return ok(
			`Resolved ${totalAnchors} anchors ` +
				`(${resolvedEdits.length} edits, ${ctxAnchors.length} context).`,
		);
	});
	stages.push(anchorStage);
	if (!anchorStage.passed) {
		errors.push(anchorStage.message);
		return buildResult(false);
	}

	// ── Stage 3: VALIDATE ──────────────────────────────────────────────
	const validateStage = stage("validate", () => {
		throwIfAborted(signal);

		// Validate main anchors via applyHashlineEdits (dry validation)
		// We call applyHashlineEdits which validates all pos/end anchors
		// but catch the error to report it as a validation stage failure.
		try {
			// This validates hashes internally before applying
			const dryResult = applyHashlineEdits(content, resolvedEdits!, signal);
			// Collect any warnings from the dry run
			if (dryResult.warnings) {
				warnings.push(...dryResult.warnings);
			}
		} catch (e) {
			return fail((e as Error).message);
		}

		// Validate context anchors
		const ctxResult = parseContextAnchors(toolEdits, fileLines);
		const zones = computeEditZones(resolvedEdits!);
		const ctxErrors = validateContextAnchors(
			ctxResult.anchors,
			zones,
			fileLines,
		);
		if (ctxErrors.length > 0) {
			return fail(ctxErrors.join("; "));
		}

		// Validate indentation consistency
		const indentWarnings = validateIndentationConsistency(resolvedEdits!, fileLines);
		if (indentWarnings.length > 0) {
			warnings.push(...indentWarnings);
		}

		return ok(
			`All anchors valid (${resolvedEdits!.length} edits, ` +
				`${ctxResult.anchors.length} context anchors verified).`,
		);
	});
	stages.push(validateStage);
	if (!validateStage.passed) {
		errors.push(validateStage.message);
		return buildResult(false);
	}

	// ── Stage 4: SIMULATE ──────────────────────────────────────────────
	const simulateStage = stage("simulate", () => {
		throwIfAborted(signal);

		try {
			const result = applyHashlineEdits(content, resolvedEdits!, signal);
			simulatedContent = result.content;
			firstChangedLine = result.firstChangedLine;

			if (result.warnings) {
				warnings.push(...result.warnings);
			}

			// Generate diff
			const diffResult = generateDiffString(content, result.content);
			diff = diffResult.diff;

			if (content === result.content) {
				return fail(
					"Simulation produced identical content — no changes would be made.",
				);
			}

			const simLines = result.content.split("\n").length;
			const origLines = content.split("\n").length;
			return ok(
				`Simulated: ${origLines} → ${simLines} lines, ` +
					`first change at line ${result.firstChangedLine ?? "?"}.`,
			);
		} catch (e) {
			return fail(`Simulation failed: ${(e as Error).message}`);
		}
	});
	stages.push(simulateStage);
	if (!simulateStage.passed) {
		errors.push(simulateStage.message);
		return buildResult(false);
	}

	// ── Stage 5: REVALIDATE ────────────────────────────────────────────
	const revalidateStage = stage("revalidate", () => {
		throwIfAborted(signal);

		// Revalidate context anchors in simulated content
		const ctxResult = parseContextAnchors(toolEdits, fileLines);
		const simulatedLines = simulatedContent!.split("\n");
		const ctxErrors = revalidateContext(ctxResult.anchors, simulatedLines);

		if (ctxErrors.length > 0) {
			return fail(
				`Context anchor revalidation failed: ${ctxErrors.join("; ")}`,
			);
		}

		return ok(
			`${ctxResult.anchors.length} context anchor(s) preserved in simulated result.`,
		);
	});
	stages.push(revalidateStage);
	if (!revalidateStage.passed) {
		errors.push(revalidateStage.message);
		return buildResult(false);
	}

	// Stop here if simulate-only
	if (simulateOnly) {
		warnings.push("Simulate-only mode: file was not written.");
		return buildResult(true);
	}

	// ── Stage 6: WRITE ─────────────────────────────────────────────────
	if (!absolutePath) {
		errors.push("Cannot write: no absolute path provided.");
		stages.push({
			stage: "write",
			passed: false,
			durationMs: 0,
			message: fail("No absolute path provided for write stage."),
		});
		return buildResult(false);
	}

	// stage() is sync but writeStage needs async — handle specially
	const writeStart = performance.now();
	try {
		throwIfAborted(signal);
		const contentToWrite =
			bom +
			simulatedContent!.replace(/\r?\n/g, lineEnding);
		await writeFileAtomically(absolutePath!, contentToWrite);
		wrote = true;
		const writeDurationMs =
			Math.round((performance.now() - writeStart) * 100) / 100;
		stages.push({
			stage: "write",
			passed: true,
			durationMs: writeDurationMs,
			message: ok(`Written atomically to ${absolutePath!}.`),
		});
	} catch (e) {
		const writeDurationMs =
			Math.round((performance.now() - writeStart) * 100) / 100;
		const msg = fail(`Write failed: ${(e as Error).message}`);
		stages.push({
			stage: "write",
			passed: false,
			durationMs: writeDurationMs,
			message: msg,
		});
		errors.push(msg);
		return buildResult(false);
	}

	// ── Stage 7: VERIFY ──────────────────────────────────────────────
	if (verifyAfterWrite && absolutePath) {
		const verifyStart = performance.now();
		const verifyResult = await verifyWrittenContent(
			absolutePath!,
			simulatedContent!,
			signal,
		);
		const verifyDurationMs =
			Math.round((performance.now() - verifyStart) * 100) / 100;

		if (verifyResult.passed) {
			verified = true;
			writtenContent = simulatedContent;
			stages.push({
				stage: "verify",
				passed: true,
				durationMs: verifyDurationMs,
				message: ok("Post-write verification passed: content matches simulation."),
			});
		} else {
			verified = false;
			stages.push({
				stage: "verify",
				passed: false,
				durationMs: verifyDurationMs,
				message: fail(verifyResult.errors.join("; ")),
			});
			errors.push(...verifyResult.errors);
			return buildResult(false);
		}
	} else {
		verified = true; // skipped = considered OK
		writtenContent = simulatedContent;
		stages.push({
			stage: "verify",
			passed: true,
			durationMs: 0,
			message: "Skipped (verifyAfterWrite disabled).",
		});
	}

	return buildResult(true);

	// ── Helper ─────────────────────────────────────────────────────────
	function buildResult(success: boolean): PipelineResult {
		return {
			success,
			stages,
			originalContent: content,
			simulatedContent,
			writtenContent,
			diff,
			warnings,
			errors,
			wrote,
			verified,
			firstChangedLine,
		};
	}
}