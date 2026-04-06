/**
 * hashline.ts — Hash-anchored line editing engine.
 *
 * Features:
 * - 2-char hash anchors for line-level integrity
 * - Range edits (pos + end)
 * - Append / prepend
 * - Dual context anchors (anchor1 + anchor2)
 * - Indentation consistency validation
 * - Post-edit integrity checks
 */

import * as XXH from "xxhashjs";
import { throwIfAborted } from "./runtime";

// ─── Types ──────────────────────────────────────────────────────────────

export type Anchor = { line: number; hash: string };
export type HashlineEdit =
  | { op: "replace"; pos: Anchor; end?: Anchor; lines: string[] }
  | { op: "append"; pos?: Anchor; lines: string[] }
  | { op: "prepend"; pos?: Anchor; lines: string[] };

interface HashMismatch {
  line: number;
  expected: string;
  actual: string;
}

interface NoopEdit {
  editIndex: number;
  loc: string;
  currentContent: string;
}

// ─── Hash computation ───────────────────────────────────────────────────

/**
 * Custom 16-character hash alphabet. Deliberately excludes:
 * - Hex digits A–F (prevents confusion with hex literals in code)
 * - Visually confusable letters: D, G, I, L, O (look like digits 0, 6, 1, 1, 0)
 * - Common vowels A, E, I, O, U (prevents accidental English words)
 *
 * This makes hash references like "5#MQ" unambiguous — they can never be
 * mistaken for code content, hex literals, or natural language.
 */
const NIBBLE_STR = "ZPMQVRWSNKTXJBYH";
const HASH_ALPHABET_RE = new RegExp(`^[${NIBBLE_STR}]+$`);
const HASHLINE_REF_RE = new RegExp(
  `^\\s*[>+-]*\\s*(\\d+)\\s*#\\s*([${NIBBLE_STR}]{2})(?:\\s*:.*)?\\s*$`,
);

const DICT = Array.from({ length: 256 }, (_, i) => {
  const h = i >>> 4;
  const l = i & 0x0f;
  return `${NIBBLE_STR[h]}${NIBBLE_STR[l]}`;
});

const HASHLINE_PREFIX_RE =
  /^\s*(?:>>>|>>)?\s*(?:\d+\s*#\s*|#\s*)[ZPMQVRWSNKTXJBYH]{2}:/;
const HASHLINE_PREFIX_PLUS_RE =
  /^\+\s*(?:\d+\s*#\s*|#\s*)[ZPMQVRWSNKTXJBYH]{2}:/;
const DIFF_PLUS_RE = /^\+(?!\+)/;
const DIFF_MINUS_RE = /^-\s*\d+\s{4}/;

function stripDiffPreviewPrefix(line: string): string | null {
  if (DIFF_MINUS_RE.test(line)) {
    return null;
  }
  if (HASHLINE_PREFIX_PLUS_RE.test(line)) {
    return line.replace(HASHLINE_PREFIX_PLUS_RE, "");
  }
  if (HASHLINE_PREFIX_RE.test(line)) {
    return line.replace(HASHLINE_PREFIX_RE, "");
  }
  return line.replace(DIFF_PLUS_RE, "");
}

const RE_SIGNIFICANT = /[\p{L}\p{N}]/u;

function xxh32(input: string, seed = 0): number {
  return XXH.h32(seed).update(input).digest().toNumber() >>> 0;
}

export function computeLineHash(idx: number, line: string): string {
  line = line.replace(/\r/g, "").trimEnd();
  let seed = 0;
  if (!RE_SIGNIFICANT.test(line)) {
    seed = idx;
  }
  return DICT[xxh32(line, seed) & 0xff];
}

// --- Indentation helpers ---

export function detectIndentation(line: string): { type: 'tabs' | 'spaces' | 'mixed' | 'none'; count: number } {
  const lead = line.match(/^(\t*)( *)/);
  if (!lead) return { type: 'none', count: 0 };
  const tabs = lead[1]!.length;
  const spaces = lead[2]!.length;
  if (tabs > 0 && spaces > 0) return { type: 'mixed', count: tabs + spaces };
  if (tabs > 0) return { type: 'tabs', count: tabs };
  if (spaces > 0) return { type: 'spaces', count: spaces };
  return { type: 'none', count: 0 };
}

/**
 * Detect the dominant indentation style across the ENTIRE file.
 */
function detectFileIndentation(fileLines: string[]): { type: 'tabs' | 'spaces' | 'none' } {
  let tabs = 0, spaces = 0;
  for (const line of fileLines) {
    if (line.trim() === '') continue;
    const ind = detectIndentation(line);
    if (ind.type === 'tabs') tabs++;
    else if (ind.type === 'spaces') spaces++;
    else if (ind.type === 'mixed') tabs++; // mixed counts as tab file
  }
  if (tabs >= spaces && tabs > 0) return { type: 'tabs' };
  if (spaces > tabs) return { type: 'spaces' };
  return { type: 'none' };
}

export function validateIndentationConsistency(
  edits: HashlineEdit[],
  fileLines: string[],
): string[] {
  const warnings: string[] = [];
  const fileStyle = detectFileIndentation(fileLines);
  for (const edit of edits) {
    if (edit.op !== 'replace') continue;
    for (let i = 0; i < edit.lines.length; i++) {
      const newLine = edit.lines[i]!;
      if (newLine.trim() === '') continue;
      const newInd = detectIndentation(newLine);
      if (fileStyle.type === 'tabs' && newInd.type === 'spaces' && newInd.count > 0) {
        warnings.push(`Edit line ${i + 1}: uses spaces but file uses tabs.`);
      }
      if (fileStyle.type === 'spaces' && newInd.type === 'tabs' && newInd.count > 0) {
        warnings.push(`Edit line ${i + 1}: uses tabs but file uses spaces.`);
      }
    }
  }
  return warnings;
}

// ─── Post-edit integrity checks ────────────────────────────────────────

/**
 * PROTECTION 1: Duplicate adjacent line detection.
 *
 * After an edit, scan ±5 lines around each edit zone for consecutive
 * identical lines. Only warns if:
 *   - The duplicate is NEW (not present anywhere in the original file), AND
 *   - Neither duplicate line is within the edit zone (not caused by replacement text)
 */
export function detectDuplicateAdjacentLines(
  originalLines: string[],
  resultLines: string[],
  editZones: Array<{ startLine: number; endLine: number }>,
  window: number = 5,
): string[] {
  const warnings: string[] = [];
  const editZoneSet = new Set<number>();

  // Mark all lines that were explicitly part of an edit
  for (const zone of editZones) {
    for (let line = zone.startLine; line <= zone.endLine; line++) {
      editZoneSet.add(line);
    }
  }

  // Build set of all unique trimmed original line contents (for content comparison)
  const originalContents = new Set<string>();
  for (const line of originalLines) {
    const trimmed = line.trimEnd();
    if (trimmed.length > 0) originalContents.add(trimmed);
  }

  // Check for NEW duplicate positions in result, within scan window of edit zones
  for (const zone of editZones) {
    const scanStart = Math.max(1, zone.startLine - window);
    const scanEnd = Math.min(resultLines.length, zone.endLine + window);

    for (let i = scanStart; i < scanEnd; i++) {
      const curr = resultLines[i - 1]!;
      const next = resultLines[i]!; // i is 1-based
      if (next === undefined) continue;

      const currTrimmed = curr.trimEnd();
      const nextTrimmed = next.trimEnd();
      if (currTrimmed.length > 0 && currTrimmed === nextTrimmed) {
        const pos = `${i}-${i + 1}`;

        // Skip if either duplicate line is from the edit zone (intentional replacement)
        if (editZoneSet.has(i) || editZoneSet.has(i + 1)) continue;

        // Skip if this content already existed somewhere in the original
        if (originalContents.has(currTrimmed)) continue;

        warnings.push(
          `Duplicate adjacent lines at lines ${i}-${i + 1}: ` +
          `"${currTrimmed.slice(0, 60)}${currTrimmed.length > 60 ? '...' : ''}". ` +
          `This is a NEW duplicate not present in the original file.`,
        );
      }
    }
  }

  return warnings;
}

/**
 * PROTECTION 3: Hash overlap guard.
 *
 * After an edit, re-hash the lines JUST OUTSIDE the edit zone (before start
 * and after end). If those adjacent lines changed hash, the edit corrupted context.
 */
export function detectContextHashDrift(
  originalLines: string[],
  resultLines: string[],
  editZones: Array<{ startLine: number; endLine: number }>,
  contextRadius: number = 2,
): string[] {
  const errors: string[] = [];

  const modifiedLines = new Set<number>();
  for (const zone of editZones) {
    for (let line = zone.startLine; line <= zone.endLine; line++) {
      modifiedLines.add(line);
    }
  }

  for (const zone of editZones) {
    // Check lines BEFORE the edit zone (skip if that line is in another edit zone)
    for (let offset = 1; offset <= contextRadius; offset++) {
      const origLineNum = zone.startLine - offset;
      if (origLineNum < 1) continue;
      if (modifiedLines.has(origLineNum)) continue;

      const origHash = computeLineHash(origLineNum, originalLines[origLineNum - 1]!);
      const resultLineNum = origLineNum;
      if (resultLineNum < 1 || resultLineNum > resultLines.length) continue;

      const resultHash = computeLineHash(resultLineNum, resultLines[resultLineNum - 1]!);
      if (origHash !== resultHash) {
        errors.push(
          `Context hash drift above edit zone (line ${origLineNum}): ` +
          `expected hash ${origHash}, got ${resultHash}. ` +
          `The edit may have corrupted surrounding context.`,
        );
      }
    }

    // Check lines AFTER the edit zone (skip if that line is in another edit zone)
    const lineDelta = resultLines.length - originalLines.length;
    for (let offset = 1; offset <= contextRadius; offset++) {
      const origLineNum = zone.endLine + offset;
      if (origLineNum > originalLines.length) continue;
      if (modifiedLines.has(origLineNum)) continue;

      const resultLineNum = origLineNum + lineDelta;
      if (resultLineNum < 1 || resultLineNum > resultLines.length) continue;

      const origContent = originalLines[origLineNum - 1]!.trimEnd();
      const resultContent = resultLines[resultLineNum - 1]!.trimEnd();

      if (origContent !== resultContent && origContent.length > 0) {
        errors.push(
          `Context content drift below edit zone (original line ${origLineNum}): ` +
          `expected "${origContent.slice(0, 50)}...", ` +
          `got "${resultContent.slice(0, 50)}...". ` +
          `The edit may have corrupted surrounding context.`,
        );
      }
    }
  }

  return errors;
}

// ─── Parsing ────────────────────────────────────────────────────────────

function diagnoseLineRef(ref: string): string {
  const trimmed = ref.trim();
  const core = ref.replace(/^\s*[>+-]*\s*/, "").trim();

  if (!core.length) {
    return `Invalid line reference "${ref}". Expected "LINE#HASH" (e.g. "5#MQ").`;
  }
  if (/^\d+\s*$/.test(core)) {
    return `Invalid line reference "${ref}": missing hash, use "LINE#HASH" from read output (e.g. "5#MQ").`;
  }
  if (/^\d+\s*:/.test(core)) {
    return `Invalid line reference "${ref}": wrong separator, use "LINE#HASH" instead of "LINE:...".`;
  }

  const hashMatch = core.match(/^(\d+)\s*#\s*([^\s:]+)(?:\s*:.*)?$/);
  if (hashMatch) {
    const line = Number.parseInt(hashMatch[1]!, 10);
    const hash = hashMatch[2]!;
    if (line < 1) {
      return `Line number must be >= 1, got ${line} in "${ref}".`;
    }
    if (hash.length !== 2) {
      return `Invalid line reference "${ref}": hash must be exactly 2 characters from ${NIBBLE_STR}.`;
    }
    if (!HASH_ALPHABET_RE.test(hash)) {
      return `Invalid line reference "${ref}": hash uses invalid characters, hashes use alphabet ${NIBBLE_STR} only.`;
    }
  }

  const missingHashMatch = core.match(/^(\d+)\s*#\s*$/);
  if (missingHashMatch) {
    return `Invalid line reference "${ref}": missing hash after "#", use "LINE#HASH" from read output.`;
  }

  if (/^0+\s*#/.test(core)) {
    return `Line number must be >= 1, got 0 in "${ref}".`;
  }

  return `Invalid line reference "${trimmed || ref}". Expected "LINE#HASH" (e.g. "5#MQ").`;
}

export function parseLineRef(ref: string): { line: number; hash: string } {
  const match = ref.match(HASHLINE_REF_RE);
  if (!match) {
    throw new Error(diagnoseLineRef(ref));
  }
  const line = Number.parseInt(match[1], 10);
  if (line < 1) {
    throw new Error(`Line number must be >= 1, got ${line} in "${ref}".`);
  }
  return { line, hash: match[2]! };
}

// ─── Content preprocessing ──────────────────────────────────────────────

export function stripNewLinePrefixes(lines: string[]): string[] {
  let hashCount = 0;
  let hashPlusCount = 0;
  let minusCount = 0;
  let diffPreviewCount = 0;
  let nonEmpty = 0;

  for (const line of lines) {
    if (!line.length) continue;
    nonEmpty++;

    const isHashLine = HASHLINE_PREFIX_RE.test(line);
    const isHashPlusLine = HASHLINE_PREFIX_PLUS_RE.test(line);
    const isMinusLine = DIFF_MINUS_RE.test(line);

    if (isHashLine) hashCount++;
    if (isHashPlusLine) hashPlusCount++;
    if (isHashLine || isHashPlusLine || isMinusLine) diffPreviewCount++;
    if (isMinusLine) minusCount++;
  }

  if (!nonEmpty) return lines;
  const stripHash = hashCount > 0 && hashCount === nonEmpty;
  const stripDiffPreview =
    !stripHash && (hashPlusCount > 0 || minusCount > 0) && diffPreviewCount === nonEmpty;
  if (!stripHash && !stripDiffPreview) return lines;

  if (stripDiffPreview) {
    const stripped: string[] = [];
    for (const line of lines) {
      const normalized = stripDiffPreviewPrefix(line);
      if (normalized !== null) stripped.push(normalized);
    }
    return stripped;
  }

  return lines.map((line) => line.replace(HASHLINE_PREFIX_RE, ""));
}

export function hashlineParseText(edit: string[] | string | null): string[] {
  if (edit === null) return [];
  if (typeof edit === "string") {
    const normalized = edit.endsWith("\n") ? edit.slice(0, -1) : edit;
    return stripNewLinePrefixes(normalized.replaceAll("\r", "").split("\n"));
  }
  return stripNewLinePrefixes(edit);
}

// ─── Edit resolution ──────────────────────────────────────────────────

export type HashlineToolEdit = {
  op: string;
  pos?: string;
  end?: string;
  lines: string[] | string | null;
};

export function resolveEditAnchors(edits: HashlineToolEdit[]): HashlineEdit[] {
  const result: HashlineEdit[] = [];
  for (const edit of edits) {
    const lines = hashlineParseText(edit.lines);
    const op = edit.op;
    if (op !== "replace" && op !== "append" && op !== "prepend") {
      throw new Error(
        `Unknown edit op "${op}". Expected "replace", "append", or "prepend".`,
      );
    }

    switch (op) {
      case "replace": {
        if (!edit.pos) {
          throw new Error('Replace requires a "pos" anchor.');
        }
        result.push({
          op: "replace",
          pos: parseLineRef(edit.pos),
          ...(edit.end ? { end: parseLineRef(edit.end) } : {}),
          lines,
        });
        break;
      }
      case "append": {
        if (edit.end !== undefined) {
          throw new Error('Append does not support "end". Use "pos" or omit it for EOF.');
        }
        result.push({
          op: "append",
          ...(edit.pos ? { pos: parseLineRef(edit.pos) } : {}),
          lines,
        });
        break;
      }
      case "prepend": {
        if (edit.end !== undefined) {
          throw new Error('Prepend does not support "end". Use "pos" or omit it for BOF.');
        }
        result.push({
          op: "prepend",
          ...(edit.pos ? { pos: parseLineRef(edit.pos) } : {}),
          lines,
        });
        break;
      }
    }
  }
  return result;
}

// ─── Main edit engine ──────────────────────────────────────────────────

const MIN_AUTOCORRECT_LENGTH = 2;
const LEADING_ESCAPED_TABS_RE = /^((?:\\t)+)/;

function shouldAutocorrect(line: string, otherLine: string): boolean {
  if (!line || line !== otherLine) return false;
  line = line.trim();
  if (line.length < MIN_AUTOCORRECT_LENGTH) {
    return line.endsWith("}") || line.endsWith(")");
  }
  return true;
}

function isEscapedTabAutocorrectEnabled(): boolean {
  return process.env.PI_HASHLINE_AUTOCORRECT_ESCAPED_TABS === "1";
}

function countLeadingTabs(line: string): number {
  let count = 0;
  while (line[count] === "\t") {
    count++;
  }
  return count;
}

function maybeAutocorrectEscapedTabIndentation(
  edits: HashlineEdit[],
  warnings: string[],
  fileLines: string[],
): void {
  if (!isEscapedTabAutocorrectEnabled()) return;

  for (const edit of edits) {
    if (edit.op !== "replace" || edit.lines.length === 0) continue;

    const hasEscapedTabs = edit.lines.some((line) => line.includes("\\t"));
    if (!hasEscapedTabs) continue;

    const hasRealTabs = edit.lines.some((line) => line.includes("\t"));
    if (hasRealTabs) continue;

    const targetStart = edit.pos.line - 1;
    const targetCount = edit.end ? edit.end.line - edit.pos.line + 1 : 1;
    if (targetCount !== edit.lines.length) continue;

    let correctedCount = 0;
    edit.lines = edit.lines.map((line, index) => {
      const match = line.match(LEADING_ESCAPED_TABS_RE);
      if (!match) return line;

      const escapedTabs = match[1]!;
      const tabCount = escapedTabs.length / 2;
      const targetLine = fileLines[targetStart + index];
      if (!targetLine) return line;

      if (countLeadingTabs(targetLine) !== tabCount || targetLine.startsWith(escapedTabs)) {
        return line;
      }

      correctedCount += tabCount;
      return "\t".repeat(tabCount) + line.slice(escapedTabs.length);
    });

    if (correctedCount > 0) {
      warnings.push(
        "Auto-corrected escaped tab indentation in anchored replace edit: converted leading \\t sequence(s) where the replaced file content already used matching real tab indentation",
      );
    }
  }
}

function maybeWarnSuspiciousUnicodeEscapePlaceholder(
  edits: HashlineEdit[],
  warnings: string[],
): void {
  for (const edit of edits) {
    if (edit.lines.some((line) => /\\uDDDD/i.test(line))) {
      warnings.push(
        "Detected literal \\uDDDD in edit content; no autocorrection applied. Verify whether this should be a real Unicode escape or plain text.",
      );
    }
  }
}

type NormalizedEditTarget =
  | { kind: "replace"; index: number; label: string; startLine: number; endLine: number }
  | { kind: "insert"; index: number; label: string; boundary: number };

function describeEdit(edit: HashlineEdit): string {
  switch (edit.op) {
    case "replace":
      return edit.end
        ? `replace ${edit.pos.line}#${edit.pos.hash}-${edit.end.line}#${edit.end.hash}`
        : `replace ${edit.pos.line}#${edit.pos.hash}`;
    case "append":
      return edit.pos ? `append after ${edit.pos.line}#${edit.pos.hash}` : "append at EOF";
    case "prepend":
      return edit.pos ? `prepend before ${edit.pos.line}#${edit.pos.hash}` : "prepend at BOF";
  }
}

function normalizeEditTarget(
  edit: HashlineEdit,
  index: number,
  fileLineCount: number,
): NormalizedEditTarget {
  switch (edit.op) {
    case "replace":
      return { kind: "replace", index, label: describeEdit(edit), startLine: edit.pos.line, endLine: edit.end?.line ?? edit.pos.line };
    case "append":
      return { kind: "insert", index, label: describeEdit(edit), boundary: edit.pos ? edit.pos.line : fileLineCount };
    case "prepend":
      return { kind: "insert", index, label: describeEdit(edit), boundary: edit.pos ? edit.pos.line - 1 : 0 };
  }
}

function throwEditConflict(left: NormalizedEditTarget, right: NormalizedEditTarget, reason: string): never {
  throw new Error(
    `Conflicting edits in a single request: edit ${left.index} (${left.label}) and edit ${right.index} (${right.label}) ${reason}. Merge them into one non-overlapping change or split the request.`,
  );
}

function cloneHashlineEdit(edit: HashlineEdit): HashlineEdit {
  switch (edit.op) {
    case "replace":
      return { op: "replace", pos: { ...edit.pos }, ...(edit.end ? { end: { ...edit.end } } : {}), lines: [...edit.lines] };
    case "append":
      return { op: "append", ...(edit.pos ? { pos: { ...edit.pos } } : {}), lines: [...edit.lines] };
    case "prepend":
      return { op: "prepend", ...(edit.pos ? { pos: { ...edit.pos } } : {}), lines: [...edit.lines] };
  }
}

function assertNoConflictingEdits(edits: HashlineEdit[], fileLineCount: number): void {
  const targets = edits.map((edit, index) => normalizeEditTarget(edit, index, fileLineCount));

  for (let i = 0; i < targets.length; i++) {
    const left = targets[i]!;
    for (let j = i + 1; j < targets.length; j++) {
      const right = targets[j]!;

      if (left.kind === "replace" && right.kind === "replace") {
        const overlaps = left.startLine <= right.endLine && right.startLine <= left.endLine;
        if (overlaps) {
          throwEditConflict(left, right, "overlap on the same original line range");
        }
        continue;
      }

      if (left.kind === "insert" && right.kind === "insert") {
        if (left.boundary === right.boundary) {
          throwEditConflict(left, right, "target the same insertion boundary");
        }
        continue;
      }

      const [replaceTarget, insertTarget] =
        left.kind === "replace" ? [left, right as Extract<NormalizedEditTarget, { kind: "insert" }>] : [right as Extract<NormalizedEditTarget, { kind: "replace" }>, left];

      const insertsInsideReplace =
        insertTarget.boundary >= replaceTarget.startLine &&
        insertTarget.boundary < replaceTarget.endLine;

      if (insertsInsideReplace) {
        throwEditConflict(left, right, "cannot be applied together because one inserts inside a replaced original range");
      }
    }
  }
}

export function applyHashlineEdits(
  content: string,
  edits: HashlineEdit[],
  signal?: AbortSignal,
): {
  content: string;
  firstChangedLine: number | undefined;
  warnings?: string[];
  noopEdits?: NoopEdit[];
} {
  throwIfAborted(signal);
  if (!edits.length) return { content, firstChangedLine: undefined };

  const workingEdits = edits.map(cloneHashlineEdit);
  const fileLines = content.split("\n");
  const hasTerminalNewline = content.endsWith("\n");
  const origLines = [...fileLines];
  let firstChanged: number | undefined;
  const noopEdits: NoopEdit[] = [];
  const warnings: string[] = [];

  // Validate all refs before mutation
  const mismatches: HashMismatch[] = [];
  const retryLines = new Set<number>();
  function validate(ref: Anchor): boolean {
    if (ref.line < 1 || ref.line > fileLines.length) {
      throw new Error(`Line ${ref.line} does not exist (file has ${fileLines.length} lines)`);
    }
    const actual = computeLineHash(ref.line, fileLines[ref.line - 1]);
    if (actual === ref.hash) return true;
    mismatches.push({ line: ref.line, expected: ref.hash, actual });
    retryLines.add(ref.line);
    return false;
  }

  // Pre-validate: collect all hash mismatches before mutating
  for (const edit of workingEdits) {
    throwIfAborted(signal);
    switch (edit.op) {
      case "replace": {
        if (edit.end) {
          if (edit.pos.line > edit.end.line) {
            throw new Error(`Range start line ${edit.pos.line} must be <= end line ${edit.end.line}`);
          }
          const startOk = validate(edit.pos);
          const endOk = validate(edit.end);
          if (!startOk && endOk) retryLines.add(edit.end.line);
          if (startOk && !endOk) retryLines.add(edit.pos.line);
          if (!startOk || !endOk) continue;
        } else {
          if (!validate(edit.pos)) continue;
        }
        break;
      }
      case "append": {
        if (edit.pos && !validate(edit.pos)) continue;
        if (edit.lines.length === 0) {
          throw new Error("Append with empty lines payload. Provide content to insert or remove the edit.");
        }
        break;
      }
      case "prepend": {
        if (edit.pos && !validate(edit.pos)) continue;
        if (edit.lines.length === 0) {
          throw new Error("Prepend with empty lines payload. Provide content to insert or remove the edit.");
        }
        break;
      }
    }
  }
  if (mismatches.length) {
    const retryLineSet = new Set<number>();
    for (const m of mismatches) retryLineSet.add(m.line);

    const displayLines = new Set<number>();
    for (const m of mismatches) {
      for (let i = Math.max(1, m.line - 2); i <= Math.min(fileLines.length, m.line + 2); i++) displayLines.add(i);
    }
    for (const line of retryLineSet) displayLines.add(line);

    const sorted = [...displayLines].sort((a, b) => a - b);
    const out: string[] = [
      `${mismatches.length} stale anchor${mismatches.length > 1 ? "s" : ""}. Retry with the >>> LINE#HASH lines below; keep both endpoints for range replaces.`,
      "",
    ];
    let prev = -1;
    for (const num of sorted) {
      if (prev !== -1 && num > prev + 1) out.push("    ...");
      prev = num;
      const content = fileLines[num - 1]!;
      const hash = computeLineHash(num, content);
      const prefix = `${num}#${hash}`;
      out.push(retryLineSet.has(num) ? `>>> ${prefix}:${content}` : `    ${prefix}:${content}`);
    }
    throw new Error(out.join("\n"));
  }

  // Deduplicate identical edits
  const seenEditKeys = new Map<string, number>();
  const dedupedEdits: HashlineEdit[] = [];
  for (const edit of workingEdits) {
    throwIfAborted(signal);
    let lineKey: string;
    switch (edit.op) {
      case "replace":
        lineKey = !edit.end ? `s:${edit.pos.line}` : `r:${edit.pos.line}:${edit.end.line}`;
        break;
      case "append":
        lineKey = edit.pos ? `i:${edit.pos.line}` : "ieof";
        break;
      case "prepend":
        lineKey = edit.pos ? `ib:${edit.pos.line}` : "ibef";
        break;
    }
    const dstKey = `${lineKey}:${edit.lines.join("\n")}`;
    if (seenEditKeys.has(dstKey)) continue;
    seenEditKeys.set(dstKey, dedupedEdits.length);
    dedupedEdits.push(edit);
  }

  assertNoConflictingEdits(dedupedEdits, fileLines.length);
  maybeAutocorrectEscapedTabIndentation(dedupedEdits, warnings, fileLines);
  maybeWarnSuspiciousUnicodeEscapePlaceholder(dedupedEdits, warnings);

  // Sort: bottom-up (descending line number)
  const annotated = dedupedEdits.map((edit, idx) => {
    let sortLine: number, precedence: number;
    switch (edit.op) {
      case "replace":
        sortLine = edit.end ? edit.end.line : edit.pos.line;
        precedence = 0;
        break;
      case "append":
        sortLine = edit.pos ? edit.pos.line : fileLines.length + 1;
        precedence = 1;
        break;
      case "prepend":
        sortLine = edit.pos ? edit.pos.line : 0;
        precedence = 2;
        break;
    }
    return { edit, idx, sortLine, precedence };
  });
  annotated.sort((a, b) => b.sortLine - a.sortLine || a.precedence - b.precedence || a.idx - b.idx);

  // Apply edits
  for (const { edit, idx } of annotated) {
    throwIfAborted(signal);
    switch (edit.op) {
      case "replace": {
        if (!edit.end) {
          const origLine = origLines.slice(edit.pos.line - 1, edit.pos.line);
          const newLines = edit.lines;
          if (origLine.length === newLines.length && origLine.every((line, i) => line === newLines[i])) {
            noopEdits.push({ editIndex: idx, loc: `${edit.pos.line}#${edit.pos.hash}`, currentContent: origLine.join("\n") });
            break;
          }
          fileLines.splice(edit.pos.line - 1, 1, ...newLines);
          track(edit.pos.line);
        } else {
          const count = edit.end.line - edit.pos.line + 1;
          const orig = origLines.slice(edit.pos.line - 1, edit.pos.line - 1 + count);
          if (orig.length === edit.lines.length && orig.every((line, i) => line === edit.lines[i])) {
            noopEdits.push({ editIndex: idx, loc: `${edit.pos.line}#${edit.pos.hash}`, currentContent: orig.join("\n") });
            break;
          }
          const newLines = [...edit.lines];
          const trailingReplacementLine = newLines[newLines.length - 1]?.trimEnd();
          const nextSurvivingLine = fileLines[edit.end.line]?.trimEnd();
          if (shouldAutocorrect(trailingReplacementLine, nextSurvivingLine) && fileLines[edit.end.line - 1]?.trimEnd() !== trailingReplacementLine) {
            newLines.pop();
            warnings.push(`Auto-corrected range replace ${edit.pos.line}#${edit.pos.hash}-${edit.end.line}#${edit.end.hash}: removed trailing replacement line "${trailingReplacementLine}" that duplicated next surviving line`);
          }
          const leadingReplacementLine = newLines[0]?.trimEnd();
          const prevSurvivingLine = fileLines[edit.pos.line - 2]?.trimEnd();
          if (shouldAutocorrect(leadingReplacementLine, prevSurvivingLine) && fileLines[edit.pos.line - 1]?.trimEnd() !== leadingReplacementLine) {
            newLines.shift();
            warnings.push(`Auto-corrected range replace ${edit.pos.line}#${edit.pos.hash}-${edit.end.line}#${edit.end.hash}: removed leading replacement line "${leadingReplacementLine}" that duplicated preceding surviving line`);
          }
          fileLines.splice(edit.pos.line - 1, count, ...newLines);
          track(edit.pos.line);
        }
        break;
      }
      case "append": {
        const inserted = edit.lines;
        if (inserted.length === 0) {
          noopEdits.push({ editIndex: idx, loc: edit.pos ? `${edit.pos.line}#${edit.pos.hash}` : "EOF", currentContent: edit.pos ? origLines[edit.pos.line - 1] : "" });
          break;
        }
        if (edit.pos) {
          const insertAt = hasTerminalNewline && edit.pos.line === fileLines.length ? fileLines.length - 1 : edit.pos.line;
          fileLines.splice(insertAt, 0, ...inserted);
          track(insertAt + 1);
        } else {
          if (fileLines.length === 1 && fileLines[0] === "") {
            fileLines.splice(0, 1, ...inserted);
            track(1);
          } else {
            const insertAt = hasTerminalNewline ? fileLines.length - 1 : fileLines.length;
            fileLines.splice(insertAt, 0, ...inserted);
            track(insertAt + 1);
          }
        }
        break;
      }
      case "prepend": {
        const inserted = edit.lines;
        if (inserted.length === 0) {
          noopEdits.push({ editIndex: idx, loc: edit.pos ? `${edit.pos.line}#${edit.pos.hash}` : "BOF", currentContent: edit.pos ? origLines[edit.pos.line - 1] : "" });
          break;
        }
        if (edit.pos) {
          fileLines.splice(edit.pos.line - 1, 0, ...inserted);
          track(edit.pos.line);
        } else {
          if (fileLines.length === 1 && fileLines[0] === "") {
            fileLines.splice(0, 1, ...inserted);
          } else {
            fileLines.splice(0, 0, ...inserted);
          }
          track(1);
        }
        break;
      }
    }
  }

  let diff = Math.abs(fileLines.length - origLines.length);
  for (let i = 0; i < Math.min(fileLines.length, origLines.length); i++) {
    if (fileLines[i] !== origLines[i]) diff++;
  }
  if (diff > dedupedEdits.length * 4) {
    warnings.push(`Edit changed ${diff} lines across ${dedupedEdits.length} operations — verify no unintended reformatting.`);
  }

  return {
    content: fileLines.join("\n"),
    firstChangedLine: firstChanged,
    ...(warnings.length ? { warnings } : {}),
    ...(noopEdits.length ? { noopEdits } : {}),
  };

  function track(line: number): void {
    if (firstChanged === undefined || line < firstChanged) {
      firstChanged = line;
    }
  }
}
