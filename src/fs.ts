import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import type { Reader } from "./tail.ts";

// The monitor's only view of the disk, injectable for tests.

export interface FileStat {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ino: number;
  readonly directory: boolean;
}

export interface Entry {
  readonly name: string;
  readonly directory: boolean;
}

export interface FileSystem extends Reader {
  stat(path: string): FileStat | null;
  list(dir: string): readonly Entry[] | null;
  readText(path: string, limit: number): string | null;
}

export const diskFileSystem: FileSystem = {
  stat(path) {
    try {
      const stat = statSync(path);
      return { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, directory: stat.isDirectory() };
    } catch {
      return null;
    }
  },

  list(dir) {
    try {
      return readdirSync(dir, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        directory: entry.isDirectory(),
      }));
    } catch {
      return null;
    }
  },

  read(path, position, length) {
    let descriptor: number | null = null;
    try {
      descriptor = openSync(path, "r");
      const buffer = new Uint8Array(length);
      const read = readSync(descriptor, buffer, 0, length, position);
      return read === length ? buffer : buffer.subarray(0, read);
    } catch {
      return new Uint8Array(0);
    } finally {
      if (descriptor !== null) closeSync(descriptor);
    }
  },

  readText(path, limit) {
    const bytes = this.read(path, 0, limit);
    return bytes.length === 0 && this.stat(path) === null ? null : new TextDecoder().decode(bytes);
  },
};
