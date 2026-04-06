/**
 * batch-transaction.ts — Atomic batch editing across multiple files.
 *
 * All-or-nothing: if any file edit fails, ALL files are rolled back
 * to their original state.
 */

import { readFile as fsReadFile, writeFile as fsWriteFile } from "fs/promises";
import { existsSync } from "fs";
import { executeEditPipeline, type PipelineOptions, type PipelineResult } from "./pipeline";
import type { DualAnchorToolEdit } from "./pipeline";
import { normalizeToLF, stripBom, detectLineEnding } from "./edit-diff";
import { writeFileAtomically } from "./fs-write";

export interface BatchEdit {
	/** Path to the file to edit. */
	path: string;
	/** Edits to apply to this file. */
	edits: DualAnchorToolEdit[];
	/** Optional pipeline overrides for this file. */
	options?: Partial<PipelineOptions>;
}

export interface BatchResult {
	/** Whether ALL edits succeeded. */
	success: boolean;
	/** Per-file results, keyed by file path. */
	results: Map<string, PipelineResult>;
	/** Files that were rolled back. */
	rolledBack: string[];
	/** Error message if the batch failed. */
	error?: string;
}

interface FileBackup {
	path: string;
	content: string;
	bom: string;
	lineEnding: "\r\n" | "\n";
}

/**
 * Execute a batch of edits across multiple files atomically.
 *
 * Strategy:
 * 1. Read all files and store backups.
 * 2. Simulate all edits (dry-run).
 * 3. If all simulations succeed, write all files.
 * 4. If any write fails, roll back all files to their original state.
 *
 * @param edits - Array of {path, edits, options} for each file.
 * @param signal - Optional AbortSignal for cancellation.
 * @returns BatchResult with per-file outcomes.
 */
export async function executeBatchEdit(
	edits: BatchEdit[],
	signal?: AbortSignal,
): Promise<BatchResult> {
	const results = new Map<string, PipelineResult>();
	const backups: FileBackup[] = [];
	const rolledBack: string[] = [];

	if (edits.length === 0) {
		return { success: true, results, rolledBack };
	}

	// ── Phase 1: READ all files and backup ──────────────────────────
	for (const edit of edits) {
		if (signal?.aborted) {
			return {
				success: false,
				results,
				rolledBack,
				error: "Batch aborted before reading all files.",
			};
		}

		if (!existsSync(edit.path)) {
			return {
				success: false,
				results,
				rolledBack,
				error: `File not found: ${edit.path}`,
			};
		}

		try {
			const raw = (await fsReadFile(edit.path)).toString("utf-8");
			const { bom, text } = stripBom(raw);
			const lineEnding = detectLineEnding(text);
			const normalized = normalizeToLF(text);

			backups.push({
				path: edit.path,
				content: normalized,
				bom,
				lineEnding,
			});
		} catch (err) {
			return {
				success: false,
				results,
				rolledBack,
				error: `Failed to read ${edit.path}: ${(err as Error).message}`,
			};
		}
	}

	// ── Phase 2: SIMULATE all edits ─────────────────────────────────
	const simulations: Array<{
		backup: FileBackup;
		edit: BatchEdit;
		result: PipelineResult;
	}> = [];

	for (let i = 0; i < edits.length; i++) {
		if (signal?.aborted) {
			return {
				success: false,
				results,
				rolledBack,
				error: "Batch aborted during simulation.",
			};
		}

		const edit = edits[i]!;
		const backup = backups[i]!;

		const pipelineOptions: PipelineOptions = {
			absolutePath: edit.path,
			simulateOnly: true, // Don't write yet — just simulate
			bom: backup.bom,
			lineEnding: backup.lineEnding,
			signal,
			...edit.options,
		};

		const result = await executeEditPipeline(
			backup.content,
			edit.edits,
			pipelineOptions,
		);

		results.set(edit.path, result);

		if (!result.success) {
			// Simulation failed — no files were written, nothing to roll back
			return {
				success: false,
				results,
				rolledBack: [],
				error:
					`Simulation failed for ${edit.path}: ` +
					result.stages
						.filter((s) => !s.passed)
						.map((s) => `[${s.stage}] ${s.message}`)
						.join("; "),
			};
		}

		simulations.push({ backup, edit, result });
	}

	// ── Phase 3: WRITE all files ────────────────────────────────────
	const writtenPaths: string[] = [];

	for (const { backup, result } of simulations) {
		if (signal?.aborted) {
			// Roll back everything written so far
			await rollbackFiles(backups, writtenPaths);
			return {
				success: false,
				results,
				rolledBack: writtenPaths,
				error: "Batch aborted during write. Rolled back all changes.",
			};
		}

		try {
			const contentToWrite =
				backup.bom +
				result.simulatedContent!.replace(/\r?\n/g, backup.lineEnding);
			await writeFileAtomically(backup.path, contentToWrite);
			writtenPaths.push(backup.path);
		} catch (err) {
			// Write failed — roll back everything
			await rollbackFiles(backups, writtenPaths);
			return {
				success: false,
				results,
				rolledBack: writtenPaths,
				error: `Write failed for ${backup.path}: ${(err as Error).message}. Rolled back all changes.`,
			};
		}
	}

	// ── Phase 4: VERIFY all writes ──────────────────────────────────
	for (const { backup, edit } of simulations) {
		try {
			const raw = (await fsReadFile(backup.path)).toString("utf-8");
			const { text: actual } = stripBom(raw);
			const normalized = normalizeToLF(actual);
			const expected = results.get(backup.path)!.simulatedContent!;

			if (normalized !== expected) {
				// Verification failed — roll back everything
				await rollbackFiles(backups, backups.map((b) => b.path));
				return {
					success: false,
					results,
					rolledBack: backups.map((b) => b.path),
					error:
						`Post-write verification failed for ${backup.path}. ` +
						`Rolled back all changes.`,
				};
			}

			// Update the result to reflect successful write and verify
			const existingResult = results.get(backup.path)!;
			results.set(backup.path, {
				...existingResult,
				wrote: true,
				verified: true,
				writtenContent: existingResult.simulatedContent,
			});
		} catch (err) {
			await rollbackFiles(backups, backups.map((b) => b.path));
			return {
				success: false,
				results,
				rolledBack: backups.map((b) => b.path),
				error:
					`Verification read failed for ${backup.path}: ${(err as Error).message}. ` +
					`Rolled back all changes.`,
			};
		}
	}

	return { success: true, results, rolledBack: [] };
}

/**
 * Roll back files to their original content from backups.
 * Only rolls back files that were actually written (listed in writtenPaths).
 */
async function rollbackFiles(
	backups: FileBackup[],
	writtenPaths: string[],
): Promise<void> {
	const pathsToRollback = new Set(writtenPaths);

	for (const backup of backups) {
		if (!pathsToRollback.has(backup.path)) continue;

		try {
			const contentToWrite =
				backup.bom +
				backup.content.replace(/\r?\n/g, backup.lineEnding);
			await writeFileAtomically(backup.path, contentToWrite);
		} catch {
			// Rollback failed — this is a critical error but we can't do much
			// In production, this would trigger an alert
			console.error(
				`CRITICAL: Failed to rollback ${backup.path}. Manual intervention required.`,
			);
		}
	}
}
