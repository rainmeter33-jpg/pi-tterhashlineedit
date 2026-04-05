import { describe, it, expect } from "bun:test";
import { detectIndentation, validateIndentationConsistency } from "../src/hashline";
import type { HashlineEdit } from "../src/hashline";

describe("Indentation helpers", () => {
	it("detectIndentation detects tabs", () => {
		const result = detectIndentation("\t\thello");
		expect(result.type).toBe("tabs");
		expect(result.count).toBe(2);
	});

	it("detectIndentation detects spaces", () => {
		const result = detectIndentation("    hello");
		expect(result.type).toBe("spaces");
		expect(result.count).toBe(4);
	});

	it("detectIndentation detects mixed", () => {
		const result = detectIndentation("\t  hello");
		expect(result.type).toBe("mixed");
		expect(result.count).toBe(3);
	});

	it("detectIndentation detects none", () => {
		const result = detectIndentation("hello");
		expect(result.type).toBe("none");
		expect(result.count).toBe(0);
	});

	it("validateIndentationConsistency warns on tabs-to-spaces", () => {
		const fileLines = ["\tconst x = 1;"];
		const edits: HashlineEdit[] = [
			{
				op: "replace",
				pos: { line: 1, hash: "whatever" },
				lines: ["    const x = 2;"],
			},
		];
		// Override hash to match (this is just for testing the logic)
		const warnings = validateIndentationConsistency(edits, fileLines);
		expect(warnings.length).toBeGreaterThan(0);
		expect(warnings[0]).toContain("spaces");
	});

	it("validateIndentationConsistency warns on spaces-to-tabs", () => {
		const fileLines = ["    const x = 1;"];
		const edits: HashlineEdit[] = [
			{
				op: "replace",
				pos: { line: 1, hash: "whatever" },
				lines: ["\t\tconst x = 2;"],
			},
		];
		const warnings = validateIndentationConsistency(edits, fileLines);
		expect(warnings.length).toBeGreaterThan(0);
		expect(warnings[0]).toContain("tabs");
	});

	it("validateIndentationConsistency passes with matching style", () => {
		const fileLines = ["\tconst x = 1;"];
		const edits: HashlineEdit[] = [
			{
				op: "replace",
				pos: { line: 1, hash: "whatever" },
				lines: ["\tconst x = 2;"],
			},
		];
		const warnings = validateIndentationConsistency(edits, fileLines);
		expect(warnings.length).toBe(0);
	});

	it("validateIndentationConsistency skips non-replace edits", () => {
		const fileLines = ["const x = 1;"];
		const edits: HashlineEdit[] = [
			{
				op: "append",
				pos: { line: 1, hash: "whatever" },
				lines: ["\tconst y = 2;"],
			},
		];
		const warnings = validateIndentationConsistency(edits, fileLines);
		expect(warnings.length).toBe(0);
	});
});