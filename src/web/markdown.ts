import { h } from "./dom.ts";

export type Inline =
  | { readonly kind: "text" | "code"; readonly text: string }
  | { readonly kind: "bold" | "italic"; readonly children: readonly Inline[] }
  | { readonly kind: "link"; readonly href: string; readonly children: readonly Inline[] };

export type Block =
  | { readonly kind: "heading"; readonly level: number; readonly content: readonly Inline[] }
  | { readonly kind: "paragraph" | "quote"; readonly content: readonly Inline[] }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "list"; readonly ordered: boolean; readonly items: readonly (readonly Inline[])[] };

export function parseInline(source: string): Inline[] {
  const result: Inline[] = [];
  let rest = source;
  while (rest.length > 0) {
    const match = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^\s)]+\))/.exec(rest);
    if (match === null) { result.push({ kind: "text", text: rest }); break; }
    if (match.index > 0) result.push({ kind: "text", text: rest.slice(0, match.index) });
    const token = match[0];
    if (token.startsWith("`")) result.push({ kind: "code", text: token.slice(1, -1) });
    else if (token.startsWith("**")) result.push({ kind: "bold", children: parseInline(token.slice(2, -2)) });
    else if (token.startsWith("*")) result.push({ kind: "italic", children: parseInline(token.slice(1, -1)) });
    else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)!;
      const href = link[2]!;
      if (/^https?:\/\//i.test(href)) result.push({ kind: "link", href, children: parseInline(link[1]!) });
      else result.push({ kind: "text", text: link[1]! });
    }
    rest = rest.slice(match.index + token.length);
  }
  return result;
}

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.trim() === "") { index += 1; continue; }
    if (/^\s*```/.test(line)) {
      index += 1;
      const code: string[] = [];
      while (index < lines.length && !/^\s*```/.test(lines[index]!)) code.push(lines[index++]!);
      if (index < lines.length) index += 1;
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading !== null) {
      blocks.push({ kind: "heading", level: heading[1]!.length, content: parseInline(heading[2]!) });
      index += 1;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index]!)) quote.push(lines[index++]!.replace(/^>\s?/, ""));
      blocks.push({ kind: "quote", content: parseInline(quote.join(" ")) });
      continue;
    }
    const list = /^\s*(?:([-*+])|(\d+)\.)\s+(.+)$/.exec(line);
    if (list !== null) {
      const ordered = list[2] !== undefined;
      const items: Inline[][] = [];
      while (index < lines.length) {
        const item = /^\s*(?:([-*+])|(\d+)\.)\s+(.+)$/.exec(lines[index]!);
        if (item === null || (item[2] !== undefined) !== ordered) break;
        items.push(parseInline(item[3]!));
        index += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }
    const paragraph = [line];
    index += 1;
    while (index < lines.length && lines[index]!.trim() !== "" && !/^(?:#{1,6}\s|>\s?|\s*```|\s*(?:[-*+]|\d+\.)\s)/.test(lines[index]!)) paragraph.push(lines[index++]!);
    blocks.push({ kind: "paragraph", content: parseInline(paragraph.join(" ")) });
  }
  return blocks;
}

function inlineNodes(parts: readonly Inline[]): Node[] {
  return parts.map((part) => {
    switch (part.kind) {
      case "text": return document.createTextNode(part.text);
      case "code": return h("code", { text: part.text });
      case "bold": return h("strong", {}, ...inlineNodes(part.children));
      case "italic": return h("em", {}, ...inlineNodes(part.children));
      case "link": return h("a", { attrs: { href: part.href, rel: "noreferrer", target: "_blank" } }, ...inlineNodes(part.children));
    }
  });
}

export function markdown(source: string): HTMLElement {
  const root = h("div", { class: "markdown" });
  for (const block of parseMarkdown(source)) {
    switch (block.kind) {
      case "heading": root.append(h(`h${block.level}` as "h1", {}, ...inlineNodes(block.content))); break;
      case "paragraph": root.append(h("p", {}, ...inlineNodes(block.content))); break;
      case "quote": root.append(h("blockquote", {}, ...inlineNodes(block.content))); break;
      case "code": root.append(h("pre", {}, h("code", { text: block.text }))); break;
      case "list": root.append(h(block.ordered ? "ol" : "ul", {}, ...block.items.map((item) => h("li", {}, ...inlineNodes(item))))); break;
    }
  }
  return root;
}
