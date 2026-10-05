import type { Clipped, NormalizedUsage } from "./domain.ts";

// Narrow accessors for untrusted transcript JSON. Nothing here throws.

export type JsonObject = Record<string, unknown>;

export function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

export function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

export function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

export function clip(value: string, limit: number): Clipped {
  return value.length <= limit
    ? { text: value, omitted: 0 }
    : { text: value.slice(0, limit), omitted: value.length - limit };
}

export function oneLine(value: string, limit: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

export function pretty(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return "";
  }
}

/** Text of a Claude- or Codex-style content field: a string, or blocks carrying `text`. */
export function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  const parts: string[] = [];
  for (const block of array(value)) {
    const part = text(object(block)?.text);
    if (part !== null) parts.push(part);
  }
  return parts.join("\n");
}

export function usageFrom(value: unknown): NormalizedUsage | null {
  const usage = object(value);
  if (usage === null) return null;
  const result: NormalizedUsage = {
    inputTokens: finite(usage.input_tokens),
    cachedInputTokens: finite(usage.cached_input_tokens ?? usage.cache_read_input_tokens),
    cacheCreationInputTokens: finite(
      usage.cache_creation_input_tokens ?? usage.cache_write_input_tokens
    ),
    outputTokens: finite(usage.output_tokens),
    reasoningTokens: finite(usage.reasoning_tokens ?? usage.reasoning_output_tokens),
    totalTokens: finite(usage.total_tokens),
  };
  return Object.values(result).some((entry) => entry !== undefined) ? result : null;
}

export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}
