import { describe, expect, it } from "bun:test";
import { readBackward, readForward, type Reader } from "./tail.ts";

const encoder = new TextEncoder();

/** A reader over in-memory bytes that returns at most `step` bytes per call. */
function memory(content: string | Uint8Array, step = Number.MAX_SAFE_INTEGER): Reader & { bytes: Uint8Array } {
  const bytes = typeof content === "string" ? encoder.encode(content) : content;
  return {
    bytes,
    read(_path, position, length) {
      return bytes.slice(position, Math.min(bytes.length, position + Math.min(length, step)));
    },
  };
}

describe("readForward", () => {
  it("consumes only complete lines", () => {
    const reader = memory('{"a":1}\n{"b":2}\n{"c":');
    const result = readForward(reader, "f", 0, reader.bytes.length);
    expect(result.lines.map((line) => line.text)).toEqual(['{"a":1}', '{"b":2}']);
    expect(result.lines.map((line) => line.offset)).toEqual([0, 8]);
    expect(result.next).toBe(16);
    expect(result.midLine).toBe(false);
  });

  it("never splits a multi-byte character across reads", () => {
    const text = '{"t":"héllo — ✓"}\n{"t":"🙂"}\n';
    const reader = memory(text, 3);
    const result = readForward(reader, "f", 0, reader.bytes.length);
    expect(result.lines.map((line) => JSON.parse(line.text).t)).toEqual(["héllo — ✓", "🙂"]);
  });

  it("resumes where the previous read stopped", () => {
    const reader = memory('{"a":1}\n{"b":2}\n');
    const first = readForward(reader, "f", 0, 12);
    expect(first.lines.map((line) => line.text)).toEqual(['{"a":1}']);
    const second = readForward(reader, "f", first.next, reader.bytes.length);
    expect(second.lines.map((line) => line.text)).toEqual(['{"b":2}']);
  });

  it("skips and counts an oversized line without stalling", () => {
    const reader = memory(`${"x".repeat(40)}\nok\n`, 7);
    const result = readForward(reader, "f", 0, reader.bytes.length, { maxLine: 16 });
    expect(result.lines.map((line) => line.text)).toEqual(["ok"]);
    expect(result.oversized).toBe(1);
  });

  it("consumes an oversized line that is still being written and discards its tail later", () => {
    const reader = memory(`${"x".repeat(40)}\nok\n`);
    const first = readForward(reader, "f", 0, 30, { maxLine: 16 });
    expect(first).toMatchObject({ lines: [], next: 30, oversized: 1, midLine: true });
    const second = readForward(reader, "f", first.next, reader.bytes.length, { maxLine: 16, discardFirst: true });
    expect(second.lines.map((line) => line.text)).toEqual(["ok"]);
    expect(second.oversized).toBe(0);
  });
});

describe("readBackward", () => {
  const lines = Array.from({ length: 50 }, (_, i) => `{"n":${i}}`);
  const reader = memory(`${lines.join("\n")}\n`);

  it("returns the newest complete lines before a cursor", () => {
    const page = readBackward(reader, "f", reader.bytes.length, 3, 64);
    const numbers = page.lines.map((line) => JSON.parse(line.text).n as number);
    expect(numbers.at(-1)).toBe(49);
    expect(numbers.length).toBeGreaterThanOrEqual(3);
    // The first line in the window starts on a line boundary.
    expect(page.start).toBe(page.lines[0]!.offset);
  });

  it("pages back to the start of the file", () => {
    let before = reader.bytes.length;
    const seen: number[] = [];
    for (let guard = 0; guard < 100 && before > 0; guard++) {
      const page = readBackward(reader, "f", before, 5, 64);
      seen.unshift(...page.lines.map((line) => JSON.parse(line.text).n as number));
      before = page.start;
    }
    expect(seen).toEqual(lines.map((_, i) => i));
  });
});
