/**
 * tests for v0.6.0 features:
 * - Fuzzy anchor recovery
 * - Semantic diff
 * - Edit conflict merge
 * - Batch transaction
 * - PROTECTION 1: Duplicate adjacent line detection
 * - PROTECTION 3: Context hash drift guard
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";

// --- Fuzzy anchor recovery ---
import {
	tryFuzzyRecoverAnchor,
	fuzzyRecoverAnchors,
} from "../src/fuzzy-anchor";
import { computeLineHash } from "../src/hashline";

// --- Semantic diff ---
import { generateSemanticDiff } from "../src/semantic-diff";

// --- Edit merge ---
import { mergeOverlappingEdits } from "../src/edit-merge";
import type { HashlineEdit } from "../src/hashline";

// --- Batch transaction ---
import { executeBatchEdit } from "../src/batch-transaction";
import type { DualAnchorToolEdit } from "../src/pipeline";

// --- Post-edit integrity protections ---
import { detectDuplicateAdjacentLines, detectContextHashDrift } from "../src/hashline";
import { executeBatchEdit } from "../src/batch-transaction";
import type { DualAnchorToolEdit } from "../src/pipeline";

const TMP_DIR = join(import.meta.dir, "__tmp_v6_test__");

// ─── Helper: sample file content (tab-indented) ────────────────────────
const SAMPLE_FILE = [
	"import express from 'express';",
	"import cors from 'cors';",
	"",
	"const app = express();",
	"\tconst PORT = 3000;",
	"",
	"\tapp.use(cors());",
	"\tapp.get('/', (req, res) => {",
	"\t\tres.json({ status: 'ok' });",
	"\t});",
	"",
	"\tapp.listen(PORT, () => {",
	"\t\tconsole.log(`Server running on port ${PORT}`);",
	"\t});",
	"",
].join("\n");

// ═══════════════════════════════════════════════════════════════════════
// 1. FUZZY ANCHOR RECOVERY
// ═══════════════════════════════════════════════════════════════════════
describe("Fuzzy anchor recovery", () => {
	it("recovers anchor shifted by +1 (line inserted above)", () => {
		const originalLines = ["aaa", "bbb", "ccc", "ddd"];
		// Simulate: a line was inserted before line 2 → content shifted
		const modifiedLines = ["aaa", "INSERTED", "bbb", "ccc", "ddd"];
		const hash = computeLineHash(2, originalLines[1]!); // hash of "bbb" at line 2

		const result = tryFuzzyRecoverAnchor(
			{ line: 2, hash },
			modifiedLines,
			3,
		);

		expect(result).not.toBeNull();
		expect(result!.anchor.line).toBe(3); // "bbb" is now at line 3
		expect(result!.offset).toBe(1);
		expect(result!.content).toBe("bbb");
	});

	it("recovers anchor shifted by -1 (line deleted above)", () => {
		const originalLines = ["aaa", "bbb", "ccc", "ddd"];
		// Simulate: line 2 was deleted → content shifted up
		const modifiedLines = ["aaa", "ccc", "ddd"];
		const hash = computeLineHash(3, originalLines[2]!); // hash of "ccc" at line 3

		const result = tryFuzzyRecoverAnchor(
			{ line: 3, hash },
			modifiedLines,
			3,
		);

		expect(result).not.toBeNull();
		expect(result!.anchor.line).toBe(2); // "ccc" is now at line 2
		expect(result!.offset).toBe(-1);
	});

	it("returns null when anchor not found in window", () => {
		const lines = ["aaa", "bbb", "ccc"];
		const result = tryFuzzyRecoverAnchor(
			{ line: 1, hash: "XX" }, // invalid hash
			lines,
			3,
		);
		expect(result).toBeNull();
	});

	it("recovers multiple anchors in batch", () => {
		const originalLines = ["aaa", "bbb", "ccc", "ddd", "eee"];
		// Line inserted at position 2 → everything shifted +1
		const modifiedLines = ["aaa", "INSERTED", "bbb", "ccc", "ddd", "eee"];
		const hash1 = computeLineHash(3, originalLines[2]!); // "ccc" was at 3
		const hash2 = computeLineHash(5, originalLines[4]!); // "eee" was at 5

		const result = fuzzyRecoverAnchors(
			[
				{ line: 3, hash: hash1 },
				{ line: 5, hash: hash2 },
			],
			modifiedLines,
			3,
		);

		expect(result.recovered.length).toBe(2);
		expect(result.recovered[0]!.anchor.line).toBe(4); // "ccc" shifted to 4
		expect(result.recovered[1]!.anchor.line).toBe(6); // "eee" shifted to 6
		expect(result.unrecovered.length).toBe(0);
	});

	it("does not recover when offset exceeds window", () => {
		const originalLines = ["aaa", "bbb", "ccc", "ddd", "eee", "fff", "ggg", "hhh"];
		// 5 lines inserted → offset of +5, window is only ±2
		const modifiedLines = ["aaa", "x1", "x2", "x3", "x4", "x5", "bbb", "ccc", "ddd", "eee", "fff", "ggg", "hhh"];
		const hash = computeLineHash(2, originalLines[1]!); // "bbb" was at line 2

		const result = tryFuzzyRecoverAnchor(
			{ line: 2, hash },
			modifiedLines,
			2, // window ±2 → max offset 2
		);

		expect(result).toBeNull(); // offset is +5, exceeds window
	});
});

// ═══════════════════════════════════════════════════════════════════════
// 2. SEMANTIC DIFF
// ═══════════════════════════════════════════════════════════════════════
describe("Semantic diff", () => {
	it("detects real content changes", () => {
		const oldContent = "hello world\nfoo bar\n";
		const newContent = "hello world\nfoo baz\n";

		const result = generateSemanticDiff(oldContent, newContent);

		expect(result.isWhitespaceOnly).toBe(false);
		expect(result.contentChanges).toBeGreaterThan(0);
		expect(result.realAddedLines).toBeGreaterThan(0);
		expect(result.realRemovedLines).toBeGreaterThan(0);
	});

	it("detects whitespace-only changes", () => {
		const oldContent = "hello world\n  foo bar\n";
		const newContent = "hello world\n\tfoo bar\n";

		const result = generateSemanticDiff(oldContent, newContent);

		expect(result.isWhitespaceOnly).toBe(true);
		expect(result.whitespaceOnlyChanges).toBeGreaterThan(0);
	});

	it("reports no changes for identical content", () => {
		const content = "hello world\nfoo bar\n";
		const result = generateSemanticDiff(content, content);

		expect(result.contentChanges).toBe(0);
		expect(result.whitespaceOnlyChanges).toBe(0);
		expect(result.realAddedLines).toBe(0);
		expect(result.realRemovedLines).toBe(0);
	});

	it("handles multi-line mixed changes", () => {
		const oldContent = "line1\nline2\nline3\nline4\n";
		const newContent = "line1\n  line2\nLINE3\nline4\n";

		const result = generateSemanticDiff(oldContent, newContent);

		expect(result.isWhitespaceOnly).toBe(false);
		expect(result.contentChanges).toBeGreaterThan(0);
		expect(result.whitespaceOnlyChanges).toBeGreaterThan(0);
	});

	it("produces semantic diff output with ~ prefix for whitespace changes", () => {
		const oldContent = "hello\n  world\n";
		const newContent = "hello\n\tworld\n";

		const result = generateSemanticDiff(oldContent, newContent);

		expect(result.semanticDiff).toContain("~");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// 3. EDIT CONFLICT MERGE
// ═══════════════════════════════════════════════════════════════════════
describe("Edit conflict merge", () => {
	it("passes through non-overlapping edits unchanged", () => {
		const edits: HashlineEdit[] = [
			{
				op: "replace",
				pos: { line: 1, hash: "AB" },
				lines: ["new1"],
			},
			{
				op: "replace",
				pos: { line: 5, hash: "CD" },
				lines: ["new5"],
			},
		];

		const result = mergeOverlappingEdits(edits);

		expect(result.edits.length).toBe(2);
		expect(result.warnings.length).toBe(0);
	});

	it("merges two overlapping replace edits", () => {
		const edits: HashlineEdit[] = [
			{
				op: "replace",
				pos: { line: 2, hash: "AB" },
				end: { line: 4, hash: "CD" },
				lines: ["new2", "new3", "new4"],
			},
			{
				op: "replace",
				pos: { line: 3, hash: "EF" },
				end: { line: 5, hash: "GH" },
				lines: ["merged3", "merged4", "merged5"],
			},
		];

		const result = mergeOverlappingEdits(edits);

		expect(result.edits.length).toBe(1);
		expect(result.warnings.length).toBe(1);
		expect(result.warnings[0]).toContain("Auto-merged");
	});

	it("handles single edit without merging", () => {
		const edits: HashlineEdit[] = [
			{
				op: "replace",
				pos: { line: 1, hash: "AB" },
				lines: ["new1"],
			},
		];

		const result = mergeOverlappingEdits(edits);

		expect(result.edits.length).toBe(1);
		expect(result.warnings.length).toBe(0);
	});

	it("handles empty edits array", () => {
		const result = mergeOverlappingEdits([]);
		expect(result.edits.length).toBe(0);
		expect(result.warnings.length).toBe(0);
	});

	it("passes through append/prepend edits unchanged", () => {
		const edits: HashlineEdit[] = [
			{
				op: "append",
				pos: { line: 3, hash: "AB" },
				lines: ["appended"],
			},
			{
				op: "prepend",
				pos: { line: 1, hash: "CD" },
				lines: ["prepended"],
			},
		];

		const result = mergeOverlappingEdits(edits);
		expect(result.edits.length).toBe(2);
		expect(result.warnings.length).toBe(0);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// 4. BATCH TRANSACTION
// ═══════════════════════════════════════════════════════════════════════
describe("Batch transaction", () => {
	beforeEach(() => {
		if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
		mkdirSync(TMP_DIR, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
	});

	it("applies edits to multiple files atomically", async () => {
		const file1 = join(TMP_DIR, "file1.ts");
		const file2 = join(TMP_DIR, "file2.ts");

		writeFileSync(file1, "line1\nline2\nline3\n");
		writeFileSync(file2, "alpha\nbeta\ngamma\n");

		// Get hashes
		const lines1 = "line1\nline2\nline3".split("\n");
		const lines2 = "alpha\nbeta\ngamma".split("\n");
		const hash1_2 = computeLineHash(2, lines1[1]!);
		const hash2_2 = computeLineHash(2, lines2[1]!);

		const result = await executeBatchEdit([
			{
				path: file1,
				edits: [
					{
						op: "replace",
						pos: `2#${hash1_2}`,
						lines: ["REPLACED_LINE2"],
						anchor1: `1#${computeLineHash(1, lines1[0]!)}`,
						anchor2: `3#${computeLineHash(3, lines1[2]!)}`,
					},
				],
			},
			{
				path: file2,
				edits: [
					{
						op: "replace",
						pos: `2#${hash2_2}`,
						lines: ["REPLACED_BETA"],
						anchor1: `1#${computeLineHash(1, lines2[0]!)}`,
						anchor2: `3#${computeLineHash(3, lines2[2]!)}`,
					},
				],
			},
		]);

		expect(result.success).toBe(true);
		expect(result.rolledBack.length).toBe(0);
		expect(result.results.get(file1)!.success).toBe(true);
		expect(result.results.get(file2)!.success).toBe(true);

		// Verify file1 content
		const content1 = Bun.file(file1).text();
		expect((await content1).split("\n")).toContain("REPLACED_LINE2");

		// Verify file2 content
		const content2 = Bun.file(file2).text();
		expect((await content2).split("\n")).toContain("REPLACED_BETA");
	});

	it("rolls back all files if one edit fails", async () => {
		const file1 = join(TMP_DIR, "file1.ts");
		const file2 = join(TMP_DIR, "file2.ts");

		writeFileSync(file1, "line1\nline2\nline3\n");
		writeFileSync(file2, "alpha\nbeta\ngamma\n");

		const lines1 = "line1\nline2\nline3".split("\n");
		const hash1_2 = computeLineHash(2, lines1[1]!);

		const result = await executeBatchEdit([
			{
				path: file1,
				edits: [
					{
						op: "replace",
						pos: `2#${hash1_2}`,
						lines: ["NEW_LINE2"],
						anchor1: `1#${computeLineHash(1, lines1[0]!)}`,
						anchor2: `3#${computeLineHash(3, lines1[2]!)}`,
					},
				],
			},
			{
				path: file2,
				edits: [
					{
						op: "replace",
						pos: "99#XX", // Invalid: line 99 doesn't exist
						lines: ["SHOULD_NOT_APPEAR"],
					},
				],
			},
		]);

		expect(result.success).toBe(false);
		expect(result.error).toContain("Simulation failed");

		// file1 should NOT have been modified (rolled back)
		const content1 = await Bun.file(file1).text();
		expect(content1).toBe("line1\nline2\nline3\n");
	});

	it("handles empty batch", async () => {
		const result = await executeBatchEdit([]);
		expect(result.success).toBe(true);
		expect(result.results.size).toBe(0);
	});

	it("fails gracefully for missing file", async () => {
		const result = await executeBatchEdit([
			{
				path: join(TMP_DIR, "nonexistent.ts"),
				edits: [
					{
						op: "replace",
						pos: "1#XX",
						lines: ["new"],
					},
				],
			},
		]);

		expect(result.success).toBe(false);
		expect(result.error).toContain("File not found");
	});
});
// ═══════════════════════════════════════════════════════════════════════
// 5. POST-EDIT INTEGRITY PROTECTIONS
// ═══════════════════════════════════════════════════════════════════════
describe("Post-edit integrity protections", () => {
	it("detects duplicate adjacent lines in result", () => {
		const original = ["line1", "line2", "line3"];
		const result = ["line1", "line2", "line2", "line3"]; // duplicate at line 3
		const zones = [{ startLine: 3, endLine: 3 }];
		const warnings = detectDuplicateAdjacentLines(original, result, zones);
		expect(warnings.length).toBeGreaterThan(0);
		expect(warnings[0]).toContain("Duplicate adjacent lines");
	});

	it("does not warn when no duplicates", () => {
		const original = ["line1", "line2", "line3"];
		const result = ["line1", "modified2", "line3"];
		const zones = [{ startLine: 2, endLine: 2 }];
		const warnings = detectDuplicateAdjacentLines(original, result, zones);
		expect(warnings.length).toBe(0);
	});

	it("detects content drift when line after edit zone is corrupted", () => {
		const original = ["line1", "TARGET", "after1", "after2"];
		const result = ["line1", "MODIFIED", "CORRUPTED", "after2"];
		const zones = [{ startLine: 2, endLine: 2 }]; // only modified line 2
		const errors = detectContextHashDrift(original, result, zones);
		expect(errors.length).toBeGreaterThan(0);
	});

	it("passes when edit zone is at file boundary", () => {
		const original = ["aaa", "bbb"];
		const result = ["XXX", "bbb"];
		const zones = [{ startLine: 1, endLine: 1 }];
		const errors = detectContextHashDrift(original, result, zones);
		expect(errors.length).toBe(0);
	});

	it("handles multiple edit zones without false positives", () => {
		const original = ["a1", "a2", "b1", "b2", "c1"];
		const result = ["a1", "MOD", "b1", "MOD2", "c1"];
		const zones = [
			{ startLine: 2, endLine: 2 },
			{ startLine: 4, endLine: 4 },
		];
		const dupWarnings = detectDuplicateAdjacentLines(original, result, zones);
		const driftErrors = detectContextHashDrift(original, result, zones);
		expect(dupWarnings.length).toBe(0);
		expect(driftErrors.length).toBe(0);
	});
});