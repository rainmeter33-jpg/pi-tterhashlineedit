import { createHash } from "crypto";
import { readFile as fsReadFile } from "fs/promises";
import { writeFileAtomically } from "./fs-write";
import { computeLineHash, resolveEditAnchors, type HashlineToolEdit } from "./hashline";
import { throwIfAborted } from "./runtime";

export type LosslessEol = "lf" | "crlf" | "none";

export interface LosslessLine {
  lineNumber: number;
  startByte: number;
  endByte: number;
  byteLength: number;
  eol: LosslessEol;
  hash: string;
  preview: string;
  b64: string;
  text: string;
}

export interface LosslessSnapshot {
  fileHash: string;
  bom: "utf8" | "none";
  bomBytes: number;
  lines: LosslessLine[];
}

export interface StrictEditItem extends HashlineToolEdit {
  expectedStartByte?: number;
  expectedEndByte?: number;
  expectedBytesBase64?: string;
  expectedHash?: string;
  replacementBytesBase64?: string;
}

export interface StrictEditOptions {
  expectedFileHash?: string;
  verifyAfterWrite?: boolean;
  signal?: AbortSignal;
}

interface StrictResolvedOp {
  startByte: number;
  endByte: number;
  replacement: Buffer;
  label: string;
}

export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function escapePreview(text: string, eol: LosslessEol): string {
  const body = text
    .replaceAll("\\", "\\\\")
    .replaceAll("\t", "\\t")
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n")
    .replaceAll('"', '\\"');
  const suffix = eol === "crlf" ? "\\r\\n" : eol === "lf" ? "\\n" : "";
  return `"${body}${suffix}"`;
}

export function parseLosslessSnapshot(buffer: Buffer): LosslessSnapshot {
  const bomBytes =
    buffer.length >= 3 &&
    buffer[0] === 0xef &&
    buffer[1] === 0xbb &&
    buffer[2] === 0xbf
      ? 3
      : 0;

  const lines: LosslessLine[] = [];
  let cursor = bomBytes;
  let lineNumber = 1;

  if (cursor >= buffer.length) {
    lines.push({
      lineNumber: 1,
      startByte: bomBytes,
      endByte: bomBytes,
      byteLength: 0,
      eol: "none",
      hash: computeLineHash(1, ""),
      preview: '""',
      b64: "",
      text: "",
    });
  } else {
    while (cursor < buffer.length) {
      const startByte = cursor;
      let endByte = buffer.indexOf(0x0a, cursor);
      let eol: LosslessEol = "none";

      if (endByte === -1) {
        endByte = buffer.length;
      } else {
        endByte += 1;
        eol = buffer[endByte - 2] === 0x0d ? "crlf" : "lf";
      }

      const contentEnd = eol === "crlf" ? endByte - 2 : eol === "lf" ? endByte - 1 : endByte;
      const lineBytes = buffer.subarray(startByte, endByte);
      const textBytes = buffer.subarray(startByte, contentEnd);
      const text = textBytes.toString("utf-8");

      lines.push({
        lineNumber,
        startByte,
        endByte,
        byteLength: endByte - startByte,
        eol,
        hash: computeLineHash(lineNumber, text),
        preview: escapePreview(text, eol),
        b64: Buffer.from(lineBytes).toString("base64"),
        text,
      });

      cursor = endByte;
      lineNumber++;
    }
  }

  return {
    fileHash: sha256Hex(buffer),
    bom: bomBytes > 0 ? "utf8" : "none",
    bomBytes,
    lines,
  };
}

export function formatLosslessReadPreview(
  buffer: Buffer,
  options: { offset?: number; limit?: number },
): string {
  const snapshot = parseLosslessSnapshot(buffer);
  const startLine = options.offset ?? 1;
  const totalLines = snapshot.lines.length;

  if (startLine > totalLines) {
    const suggestion =
      totalLines === 0
        ? "The file is empty."
        : `Use offset=1 to read from the start, or offset=${totalLines} to read the last line.`;
    return `Offset ${startLine} is beyond end of file (${totalLines} lines total). ${suggestion}`;
  }

  const endLine = options.limit
    ? Math.min(startLine - 1 + options.limit, totalLines)
    : totalLines;

  const header = [
    `[lossless sha256=${snapshot.fileHash} bom=${snapshot.bom}]`,
  ];

  const body = snapshot.lines
    .slice(startLine - 1, endLine)
    .map(
      (line) =>
        `${line.lineNumber}#${line.hash} start=${line.startByte} end=${line.endByte} len=${line.byteLength} eol=${line.eol} b64=${line.b64} preview=${line.preview}`,
    );

  const footer =
    endLine < totalLines
      ? [``, `[Showing lines ${startLine}-${endLine} of ${totalLines}. Use offset=${endLine + 1} to continue.]`]
      : [];

  return [...header, ...body, ...footer].join("\n");
}

function linesToReplacementBuffer(lines: string[], defaultLineEnding: "\n" | "\r\n"): Buffer {
  return Buffer.from(lines.join(defaultLineEnding), "utf-8");
}

function validateStrictExpectations(
  item: StrictEditItem,
  actualStartByte: number,
  actualEndByte: number,
  actualBytes: Buffer,
): void {
  if (
    item.expectedStartByte !== undefined &&
    item.expectedStartByte !== actualStartByte
  ) {
    throw new Error(
      `Strict byte mismatch: expected startByte=${item.expectedStartByte}, got ${actualStartByte}.`,
    );
  }

  if (
    item.expectedEndByte !== undefined &&
    item.expectedEndByte !== actualEndByte
  ) {
    throw new Error(
      `Strict byte mismatch: expected endByte=${item.expectedEndByte}, got ${actualEndByte}.`,
    );
  }

  if (item.expectedBytesBase64 !== undefined) {
    const expected = Buffer.from(item.expectedBytesBase64, "base64");
    if (!Buffer.from(actualBytes).equals(expected)) {
      throw new Error("Strict byte mismatch: expectedBytesBase64 does not match the current file content.");
    }
  }

  if (item.expectedHash !== undefined) {
    const actualHash = sha256Hex(actualBytes);
    const expectedHash = item.expectedHash.replace(/^sha256:/, "").toLowerCase();
    if (actualHash !== expectedHash) {
      throw new Error(
        `Strict hash mismatch: expected ${item.expectedHash}, got sha256:${actualHash}.`,
      );
    }
  }
}

export async function applyStrictEditRequest(
  absolutePath: string,
  originalTextNormalized: string,
  toolEdits: StrictEditItem[],
  options: StrictEditOptions = {},
): Promise<{
  content: string;
  rawContent: Buffer;
  fileHash: string;
  firstChangedLine: number | undefined;
}> {
  const { expectedFileHash, verifyAfterWrite = true, signal } = options;

  throwIfAborted(signal);
  const originalBuffer = await fsReadFile(absolutePath);
  throwIfAborted(signal);

  const snapshot = parseLosslessSnapshot(originalBuffer);
  if (expectedFileHash) {
    const expected = expectedFileHash.replace(/^sha256:/, "").toLowerCase();
    if (snapshot.fileHash !== expected) {
      throw new Error(
        `Strict file hash mismatch: expected ${expectedFileHash}, got sha256:${snapshot.fileHash}.`,
      );
    }
  }

  const resolvedEdits = resolveEditAnchors(toolEdits);
  const lineEnding: "\n" | "\r\n" = snapshot.lines.some((line) => line.eol === "crlf") ? "\r\n" : "\n";
  let firstChangedLine: number | undefined;

  for (const edit of resolvedEdits) {
    switch (edit.op) {
      case "replace": {
        const endLine = edit.end?.line ?? edit.pos.line;
        for (let line = edit.pos.line; line <= endLine; line++) {
          const meta = snapshot.lines[line - 1];
          if (!meta) throw new Error(`Line ${line} does not exist.`);
          const actualHash = computeLineHash(line, meta.text);
          const expectedHash =
            line === edit.pos.line ? edit.pos.hash : line === endLine && edit.end ? edit.end.hash : actualHash;
          if (actualHash !== expectedHash) {
            throw new Error(`Stale strict anchor at ${line}#${expectedHash}; actual hash is ${actualHash}.`);
          }
        }
        break;
      }
      case "append":
      case "prepend": {
        if (edit.pos) {
          const meta = snapshot.lines[edit.pos.line - 1];
          if (!meta) throw new Error(`Line ${edit.pos.line} does not exist.`);
          const actualHash = computeLineHash(edit.pos.line, meta.text);
          if (actualHash !== edit.pos.hash) {
            throw new Error(
              `Stale strict anchor at ${edit.pos.line}#${edit.pos.hash}; actual hash is ${actualHash}.`,
            );
          }
        }
        break;
      }
    }
  }

  const ops: StrictResolvedOp[] = toolEdits.map((item, index) => {
    const resolved = resolvedEdits[index]!;
    const replacement =
      item.replacementBytesBase64 !== undefined
        ? Buffer.from(item.replacementBytesBase64, "base64")
        : linesToReplacementBuffer(
            typeof resolved.lines === "object" && Array.isArray(resolved.lines)
              ? resolved.lines
              : [],
            lineEnding,
          );

    switch (resolved.op) {
      case "replace": {
        const startMeta = snapshot.lines[resolved.pos.line - 1];
        const endMeta = snapshot.lines[(resolved.end?.line ?? resolved.pos.line) - 1];
        if (!startMeta || !endMeta) throw new Error("Strict replace target is out of range.");
        const startByte = startMeta.startByte;
        const endByte = endMeta.endByte;
        validateStrictExpectations(item, startByte, endByte, originalBuffer.subarray(startByte, endByte));
        if (firstChangedLine === undefined || resolved.pos.line < firstChangedLine) firstChangedLine = resolved.pos.line;
        return {
          startByte,
          endByte,
          replacement,
          label: `replace ${resolved.pos.line}-${resolved.end?.line ?? resolved.pos.line}`,
        };
      }
      case "append": {
        const boundary = resolved.pos
          ? snapshot.lines[resolved.pos.line - 1]?.endByte ?? originalBuffer.length
          : originalBuffer.length;
        validateStrictExpectations(item, boundary, boundary, originalBuffer.subarray(boundary, boundary));
        const changedLine = resolved.pos ? resolved.pos.line + 1 : snapshot.lines.length + 1;
        if (firstChangedLine === undefined || changedLine < firstChangedLine) firstChangedLine = changedLine;
        return { startByte: boundary, endByte: boundary, replacement, label: `append ${resolved.pos?.line ?? "EOF"}` };
      }
      case "prepend": {
        const boundary = resolved.pos
          ? snapshot.lines[resolved.pos.line - 1]?.startByte ?? snapshot.bomBytes
          : snapshot.bomBytes;
        validateStrictExpectations(item, boundary, boundary, originalBuffer.subarray(boundary, boundary));
        const changedLine = resolved.pos ? resolved.pos.line : 1;
        if (firstChangedLine === undefined || changedLine < firstChangedLine) firstChangedLine = changedLine;
        return { startByte: boundary, endByte: boundary, replacement, label: `prepend ${resolved.pos?.line ?? "BOF"}` };
      }
    }
  });

  ops.sort((a, b) => b.startByte - a.startByte || b.endByte - a.endByte);

  let nextBuffer = Buffer.from(originalBuffer);
  for (const op of ops) {
    throwIfAborted(signal);
    nextBuffer = Buffer.concat([
      nextBuffer.subarray(0, op.startByte),
      op.replacement,
      nextBuffer.subarray(op.endByte),
    ]);
  }

  await writeFileAtomically(absolutePath, nextBuffer);

  if (verifyAfterWrite) {
    const written = await fsReadFile(absolutePath);
    if (!Buffer.from(written).equals(nextBuffer)) {
      throw new Error("Strict verification failed: file bytes on disk differ from the expected buffer.");
    }
  }

  return {
    content: nextBuffer.toString("utf-8"),
    rawContent: nextBuffer,
    fileHash: sha256Hex(nextBuffer),
    firstChangedLine,
  };
}
