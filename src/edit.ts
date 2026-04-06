import { applyStrictEditRequest, type StrictEditItem } from "./strict-bytes";
import type { EditToolDetails, ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { constants } from "fs";
import { readFileSync } from "fs";
import { access as fsAccess, readFile as fsReadFile } from "fs/promises";
import {
	buildCompactHashlineDiffPreview,
	detectLineEnding,
	generateDiffString,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "./edit-diff";
import {
	applyExactUniqueLegacyReplace,
	extractLegacyTopLevelReplace,
} from "./edit-compat";
import { writeFileAtomically } from "./fs-write";
import {
	applyHashlineEdits,
	resolveEditAnchors,
	type HashlineToolEdit,
} from "./hashline";
import { executeEditPipeline, type DualAnchorToolEdit } from "./pipeline";
import { classifyFileKind } from "./file-kind";
import { resolveToCwd } from "./path-utils";
import { throwIfAborted } from "./runtime";

// ─── Schema with dual anchor support ────────────────────────────────────

const hashlineEditLinesSchema = Type.Union([
	Type.Array(Type.String(), { description: "content (preferred format)" }),
	Type.String(),
	Type.Null(),
]);

const anchorField = Type.Optional(
	Type.String({
		description: "context anchor (LINE#HASH) for verification",
	}),
);

const replaceEditItemSchema = Type.Object(
	{
		op: Type.Literal("replace"),
		pos: Type.String({ description: "anchor" }),
		end: Type.Optional(Type.String({ description: "limit position" })),
		lines: hashlineEditLinesSchema,
		anchor1: anchorField,
		anchor2: anchorField,
		expectedStartByte: Type.Optional(Type.Integer()),
		expectedEndByte: Type.Optional(Type.Integer()),
		expectedBytesBase64: Type.Optional(Type.String()),
		expectedHash: Type.Optional(Type.String({ description: "sha256:<hex> or raw hex" })),
		replacementBytesBase64: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

const appendEditItemSchema = Type.Object(
	{
		op: Type.Literal("append"),
		pos: Type.Optional(Type.String({ description: "anchor" })),
		lines: hashlineEditLinesSchema,
		anchor1: anchorField,
		anchor2: anchorField,
		expectedStartByte: Type.Optional(Type.Integer()),
		expectedEndByte: Type.Optional(Type.Integer()),
		expectedBytesBase64: Type.Optional(Type.String()),
		expectedHash: Type.Optional(Type.String({ description: "sha256:<hex> or raw hex" })),
		replacementBytesBase64: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

const prependEditItemSchema = Type.Object(
	{
		op: Type.Literal("prepend"),
		pos: Type.Optional(Type.String({ description: "anchor" })),
		lines: hashlineEditLinesSchema,
		anchor1: anchorField,
		anchor2: anchorField,
		expectedStartByte: Type.Optional(Type.Integer()),
		expectedEndByte: Type.Optional(Type.Integer()),
		expectedBytesBase64: Type.Optional(Type.String()),
		expectedHash: Type.Optional(Type.String({ description: "sha256:<hex> or raw hex" })),
		replacementBytesBase64: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

const hashlineEditItemSchema = Type.Union([
	replaceEditItemSchema,
	appendEditItemSchema,
	prependEditItemSchema,
]);

export const hashlineEditToolSchema = Type.Object(
	{
		path: Type.String({ description: "path" }),
		edits: Type.Optional(
			Type.Array(hashlineEditItemSchema, { description: "edits over $path" }),
		),
		strict: Type.Optional(Type.Boolean({ description: "Enable strict byte-verified editing" })),
		expectedFileHash: Type.Optional(Type.String({ description: "sha256:<hex> or raw hex for whole-file verification" })),
		oldText: Type.Optional(Type.String()),
		newText: Type.Optional(Type.String()),
		old_text: Type.Optional(Type.String()),
		new_text: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

type EditRequest = Static<typeof hashlineEditToolSchema>;

type EditRequestParams = {
	path: string;
	edits?: (DualAnchorToolEdit & StrictEditItem)[];
	strict?: boolean;
	expectedFileHash?: string;
	oldText?: string;
	newText?: string;
	old_text?: string;
	new_text?: string;
};

type CompatibilityDetails = {
	used: true;
	strategy: "legacy-top-level-replace";
	matchCount: 1;
};

const EDIT_DESC = readFileSync(
	new URL("../prompts/edit.md", import.meta.url),
	"utf-8",
).trim();

const ROOT_KEYS = new Set(["path", "edits", "strict", "expectedFileHash", "oldText", "newText", "old_text", "new_text"]);
const ITEM_KEYS = new Set([
  "op", "pos", "end", "lines", "anchor1", "anchor2",
  "expectedStartByte", "expectedEndByte", "expectedBytesBase64", "expectedHash", "replacementBytesBase64",
]);
const LEGACY_KEYS = ["oldText", "newText", "old_text", "new_text"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(request: Record<string, unknown>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(request, key);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

// Intentional overlap with the published TypeBox schema:
// - pi normally runs AJV validation before execute(), but that can be disabled in
//   environments without runtime code generation support.
// - some request rules here are cross-field semantics the top-level object schema does
//   not express cleanly, such as rejecting mixed camelCase/snake_case legacy keys.
export function assertEditRequest(request: unknown): asserts request is EditRequestParams {
	if (!isRecord(request)) {
		throw new Error("Edit request must be an object.");
	}

	const unknownRootKeys = Object.keys(request).filter((key) => !ROOT_KEYS.has(key));
	if (unknownRootKeys.length > 0) {
		throw new Error(
			`Edit request contains unknown or unsupported fields: ${unknownRootKeys.join(", ")}.`,
		);
	}

	if (typeof request.path !== "string" || request.path.length === 0) {
		throw new Error('Edit request requires a non-empty "path" string.');
	}

	if (hasOwn(request, "edits") && !Array.isArray(request.edits)) {
		throw new Error('Edit request requires an "edits" array when provided.');
	}

	for (const legacyKey of LEGACY_KEYS) {
		if (hasOwn(request, legacyKey) && typeof request[legacyKey] !== "string") {
			throw new Error(`Edit request field "${legacyKey}" must be a string.`);
		}
	}

	const hasCamelLegacy = hasOwn(request, "oldText") || hasOwn(request, "newText");
	const hasSnakeLegacy = hasOwn(request, "old_text") || hasOwn(request, "new_text");
	if (hasCamelLegacy && hasSnakeLegacy) {
		throw new Error(
			'Edit request cannot mix legacy camelCase and snake_case fields. Use either oldText/newText or old_text/new_text.',
		);
	}

	const hasAnyLegacyKey = hasCamelLegacy || hasSnakeLegacy;
	const hasStructuredEdits = Array.isArray(request.edits) && request.edits.length > 0;
	if (hasAnyLegacyKey && !hasStructuredEdits) {
		const legacy = extractLegacyTopLevelReplace(request);
		if (!legacy) {
			throw new Error(
				'Legacy top-level replace requires both oldText/newText or old_text/new_text.',
			);
		}
	}

	if (!Array.isArray(request.edits)) {
		return;
	}

	for (const [index, edit] of request.edits.entries()) {
		if (!isRecord(edit)) {
			throw new Error(`Edit ${index} must be an object.`);
		}

		const unknownItemKeys = Object.keys(edit).filter((key) => !ITEM_KEYS.has(key));
		if (unknownItemKeys.length > 0) {
			throw new Error(
				`Edit ${index} contains unknown or unsupported fields: ${unknownItemKeys.join(", ")}.`,
			);
		}

		if (typeof edit.op !== "string") {
			throw new Error(`Edit ${index} requires an "op" string.`);
		}
		if (edit.op !== "replace" && edit.op !== "append" && edit.op !== "prepend") {
			throw new Error(
				`Edit ${index} uses unknown op "${edit.op}". Expected "replace", "append", or "prepend".`,
			);
		}

		if (hasOwn(edit, "pos") && typeof edit.pos !== "string") {
			throw new Error(`Edit ${index} field "pos" must be a string when provided.`);
		}
		if (hasOwn(edit, "end") && typeof edit.end !== "string") {
			throw new Error(`Edit ${index} field "end" must be a string when provided.`);
		}
		if (!hasOwn(edit, "lines")) {
			throw new Error(`Edit ${index} requires a "lines" field.`);
		}
		if (
			edit.lines !== null &&
			typeof edit.lines !== "string" &&
			!isStringArray(edit.lines)
		) {
			throw new Error(
				`Edit ${index} field "lines" must be a string array, string, or null.`,
			);
		}

		if (edit.op === "replace" && typeof edit.pos !== "string") {
			throw new Error(`Edit ${index} with op "replace" requires a "pos" anchor string.`);
		}

		if ((edit.op === "append" || edit.op === "prepend") && hasOwn(edit, "end")) {
			throw new Error(
				`Edit ${index} with op "${edit.op}" does not support "end". Use "pos" or omit it for file boundary insertion.`,
			);
		}

		// Validate anchor1/anchor2 if provided
		for (const anchorKey of ["anchor1", "anchor2"] as const) {
			if (
				hasOwn(edit, anchorKey) &&
				edit[anchorKey] !== undefined &&
				typeof edit[anchorKey] !== "string"
			) {
				throw new Error(
					`Edit ${index} field "${anchorKey}" must be a string when provided.`,
				);
			}
		}
	}
}

function usesStrictMode(params: EditRequestParams): boolean {
	return params.strict === true || !!params.expectedFileHash || (params.edits?.some(
		(edit) =>
			edit.expectedStartByte !== undefined ||
			edit.expectedEndByte !== undefined ||
			edit.expectedBytesBase64 !== undefined ||
			edit.expectedHash !== undefined ||
			edit.replacementBytesBase64 !== undefined,
	) ?? false);
}

// ─── Check if any edit uses dual anchors ─────────────────────────────────

function usesDualAnchors(edits: DualAnchorToolEdit[]): boolean {
	return edits.some(
		(edit) =>
			(edit.anchor1 !== undefined && edit.anchor1 !== "") ||
			(edit.anchor2 !== undefined && edit.anchor2 !== ""),
	);
}

// ─── Register edit tool ─────────────────────────────────────────────────

export function registerEditTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "edit",
		label: "Edit",
		description: EDIT_DESC,
		parameters: hashlineEditToolSchema,

		async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
			const params = rawParams as EditRequest;
			assertEditRequest(params);

			const path = params.path;
			const absolutePath = resolveToCwd(path, ctx.cwd);
			const toolEdits = Array.isArray(params.edits)
				? (params.edits as (DualAnchorToolEdit & StrictEditItem)[])
				: [];
			const legacy = extractLegacyTopLevelReplace(params as Record<string, unknown>);

			if (toolEdits.length === 0 && !legacy) {
				return {
					content: [{ type: "text", text: "No edits provided." }],
					isError: true,
					details: { diff: "", firstChangedLine: undefined } as EditToolDetails,
				};
			}

			throwIfAborted(signal);
			try {
				await fsAccess(absolutePath, constants.R_OK | constants.W_OK);
			} catch {
				throw new Error(`File not found: ${path}`);
			}

			throwIfAborted(signal);
			const fileKind = await classifyFileKind(absolutePath);
			if (fileKind.kind === "directory") {
				throw new Error(`Path is a directory: ${path}. Use ls to inspect directories.`);
			}
			if (fileKind.kind === "image") {
				throw new Error(
					`Path is an image file: ${path}. Hashline edit only supports UTF-8 text files.`,
				);
			}
			if (fileKind.kind === "binary") {
				throw new Error(
					`Path is a binary file: ${path} (${fileKind.description}). Hashline edit only supports UTF-8 text files.`,
				);
			}

			throwIfAborted(signal);
			const raw = (await fsReadFile(absolutePath)).toString("utf-8");
			throwIfAborted(signal);

			const { bom, text: content } = stripBom(raw);
			const originalEnding = detectLineEnding(content);
			const originalNormalized = normalizeToLF(content);

			let result: string;
			let warnings: string[] | undefined;
			let noopEdits:
				| Array<{
						editIndex: number;
						loc: string;
						currentContent: string;
					}>
				| undefined;
			let firstChangedLine: number | undefined;
			let compatibilityDetails: CompatibilityDetails | undefined;

			if (toolEdits.length > 0 && usesStrictMode(params)) {
				const strictResult = await applyStrictEditRequest(
					absolutePath,
					originalNormalized,
					toolEdits,
					{
						expectedFileHash: params.expectedFileHash,
						verifyAfterWrite: true,
						signal,
					},
				);

				result = normalizeToLF(stripBom(strictResult.content).text);
				firstChangedLine = strictResult.firstChangedLine;

				const diffResult = generateDiffString(originalNormalized, result);
				const preview = buildCompactHashlineDiffPreview(diffResult.diff);
				const summaryLine = `Changes: +${preview.addedLines} -${preview.removedLines}`;
				const previewBlock = preview.preview ? `\n\nDiff preview:\n${preview.preview}` : "";

				return {
					content: [
						{
							type: "text",
							text: `Updated ${path} (strict)\n${summaryLine}${previewBlock}\n\nStrict verification: byte-range checks + atomic write + post-write verification passed.`,
						},
					],
					details: {
						diff: diffResult.diff,
						firstChangedLine: firstChangedLine ?? diffResult.firstChangedLine,
					} as EditToolDetails,
				};
			}
			if (toolEdits.length > 0 && usesDualAnchors(toolEdits)) {
				// ── Pipeline mode (dual anchors) ──────────────────────
				const pipelineResult = await executeEditPipeline(
					originalNormalized,
					toolEdits,
					{
						absolutePath,
						verifyAfterWrite: true,
						bom,
						lineEnding: originalEnding,
						signal,
					},
				);

				if (!pipelineResult.success) {
					// Build a descriptive error from pipeline stages
					const failedStages = pipelineResult.stages
						.filter((s) => !s.passed)
						.map((s) => `[${s.stage}] ${s.message}`)
						.join("\n");
					throw new Error(
						`Edit pipeline failed:\n${failedStages}` +
							(pipelineResult.errors.length
								? `\nErrors: ${pipelineResult.errors.join("; ")}`
								: ""),
					);
				}

				result = pipelineResult.simulatedContent!;
				warnings = pipelineResult.warnings.length
					? pipelineResult.warnings
					: undefined;
				firstChangedLine = pipelineResult.firstChangedLine;

				// Pipeline already wrote the file
				// Build diff for display
				const diffResult = generateDiffString(originalNormalized, result);
				const preview = buildCompactHashlineDiffPreview(diffResult.diff);
				const summaryLine = `Changes: +${preview.addedLines} -${preview.removedLines}`;
				const previewBlock = preview.preview
					? `\n\nDiff preview:\n${preview.preview}`
					: "";
				const pipelineInfo = pipelineResult.stages
					.map((s) => `${s.stage}: ${s.passed ? "✓" : "✗"} (${s.durationMs}ms)`)
					.join(" → ");
				const warningsBlock = warnings?.length
					? `\n\nWarnings:\n${warnings.join("\n")}`
					: "";

				return {
					content: [
						{
							type: "text",
							text:
								`Updated ${path} (pipeline)\n${summaryLine}${previewBlock}` +
								`\n\nPipeline: ${pipelineInfo}${warningsBlock}`,
						},
					],
					details: {
						diff: diffResult.diff,
						firstChangedLine:
							firstChangedLine ?? diffResult.firstChangedLine,
					} as EditToolDetails,
				};
			}

			if (toolEdits.length > 0) {
				// ── Standard hashline mode (no dual anchors) ──────────
				const resolved = resolveEditAnchors(toolEdits);
				const anchorResult = applyHashlineEdits(
					originalNormalized,
					resolved,
					signal,
				);
				result = anchorResult.content;
				warnings = anchorResult.warnings;
				noopEdits = anchorResult.noopEdits;
				firstChangedLine = anchorResult.firstChangedLine;
			} else {
				// ── Legacy compatibility mode ─────────────────────────
				const normalizedOldText = normalizeToLF(legacy!.oldText);
				const normalizedNewText = normalizeToLF(legacy!.newText);
				const replaced = applyExactUniqueLegacyReplace(
					originalNormalized,
					normalizedOldText,
					normalizedNewText,
				);
				result = replaced.content;
				compatibilityDetails = {
					used: true,
					strategy: legacy!.strategy,
					matchCount: replaced.matchCount,
				};
			}

			if (originalNormalized === result) {
				let diagnostic = `No changes made to ${path}. The edits produced identical content.`;
				if (noopEdits?.length) {
					diagnostic +=
						"\n" +
						noopEdits
							.map(
								(edit) =>
									`Edit ${edit.editIndex}: replacement for ${edit.loc} is identical to current content:\n  ${edit.loc}: ${edit.currentContent}`,
							)
							.join("\n");
				}
				diagnostic +=
					"\nYour content must differ from what the file already contains. Re-read the file to see the current state.";
				throw new Error(diagnostic);
			}

			throwIfAborted(signal);
			await writeFileAtomically(
				absolutePath,
				bom + restoreLineEndings(result, originalEnding),
			);

			const diffResult = generateDiffString(originalNormalized, result);
			const preview = buildCompactHashlineDiffPreview(diffResult.diff);
			const summaryLine = `Changes: +${preview.addedLines} -${preview.removedLines}${preview.preview ? "" : " (no textual diff preview)"}`;
			const previewBlock = preview.preview
				? `\n\nDiff preview:\n${preview.preview}`
				: "";
			const warningsBlock = warnings?.length
				? `\n\nWarnings:\n${warnings.join("\n")}`
				: "";
			return {
				content: [
					{
						type: "text",
						text: `Updated ${path}\n${summaryLine}${previewBlock}${warningsBlock}`,
					},
				],
				details: {
					diff: diffResult.diff,
					firstChangedLine:
						firstChangedLine ?? diffResult.firstChangedLine,
					...(compatibilityDetails
						? { compatibility: compatibilityDetails }
						: {}),
				} as EditToolDetails,
			};
		},
	});
}
