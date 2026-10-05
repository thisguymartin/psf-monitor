// Byte-level JSONL reading: lines are split on 0x0A
// before decoding, so a multi-byte character is never cut, and only complete
// lines are consumed.

export interface Reader {
  /** May return fewer bytes than asked for at end of file. */
  read(path: string, position: number, length: number): Uint8Array;
}

export interface Line {
  readonly text: string;
  readonly offset: number;
}

export interface Forward {
  readonly lines: readonly Line[];
  /** Where the next read starts. */
  readonly next: number;
  readonly oversized: number;
  /** True when `next` sits inside an oversized line that the next read must discard. */
  readonly midLine: boolean;
}

export const MAX_LINE_BYTES = 8 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;
const decoder = new TextDecoder();

function join(parts: readonly Uint8Array[], length: number): Uint8Array {
  const result = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    result.set(part, at);
    at += part.length;
  }
  return result;
}

export function readForward(
  reader: Reader,
  path: string,
  from: number,
  to: number,
  options: { readonly discardFirst?: boolean; readonly maxLine?: number } = {},
): Forward {
  const maxLine = options.maxLine ?? MAX_LINE_BYTES;
  const lines: Line[] = [];
  let oversized = 0;
  let position = from;
  let lineStart = from;
  let parts: Uint8Array[] = [];
  let pending = 0;
  let skipping = options.discardFirst === true;
  // A discarded fragment is the tail of a line already counted as oversized.
  let fragment = skipping;

  while (position < to) {
    const chunk = reader.read(path, position, Math.min(CHUNK_BYTES, to - position));
    if (chunk.length === 0) break;
    let cursor = 0;
    while (cursor < chunk.length) {
      const newline = chunk.indexOf(NEWLINE, cursor);
      if (newline === -1) {
        const rest = chunk.length - cursor;
        if (!skipping && pending + rest > maxLine) {
          skipping = true;
          parts = [];
        }
        if (!skipping) parts.push(chunk.slice(cursor));
        pending += rest;
        break;
      }
      const piece = chunk.subarray(cursor, newline);
      const length = pending + piece.length;
      if (skipping || length > maxLine) {
        if (!fragment) oversized += 1;
      } else if (length > 0) {
        const bytes = parts.length === 0 ? piece : join([...parts, piece], length);
        lines.push({ text: decoder.decode(bytes), offset: lineStart });
      }
      cursor = newline + 1;
      lineStart = position + cursor;
      parts = [];
      pending = 0;
      skipping = false;
      fragment = false;
    }
    position += chunk.length;
  }

  if (skipping) {
    // Consume the oversized line so far; the rest is discarded on the next read.
    if (!fragment && pending > 0) oversized += 1;
    return { lines, next: position, oversized, midLine: true };
  }
  return { lines, next: lineStart, oversized, midLine: false };
}

export interface Backward {
  readonly lines: readonly Line[];
  /** Offset of the earliest returned line, or `before` when nothing fit. */
  readonly start: number;
}

/**
 * Complete lines ending at `before`, newest last. The window grows until it
 * holds `wanted` lines, reaches the start of the file, or hits `maxBytes`.
 */
export function readBackward(
  reader: Reader,
  path: string,
  before: number,
  wanted: number,
  maxBytes: number = MAX_LINE_BYTES,
): Backward {
  let window = 256 * 1024;
  for (;;) {
    const from = Math.max(0, before - window);
    const boundary = from === 0 || reader.read(path, from - 1, 1)[0] === NEWLINE;
    const result = readForward(reader, path, from, before, { discardFirst: !boundary });
    const lines = result.lines;
    if (lines.length >= wanted || from === 0 || window >= maxBytes) {
      return { lines, start: lines[0]?.offset ?? before };
    }
    window = Math.min(window * 4, maxBytes);
  }
}
