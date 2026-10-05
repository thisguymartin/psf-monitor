import { describe, expect, it } from "bun:test";
import { parseInline, parseMarkdown } from "./web/markdown.ts";

describe("markdown parser", () => {
  it("parses headings, paragraphs, quotes, lists, and fenced code", () => {
    const blocks = parseMarkdown("# Heading\n\nA paragraph.\n\n> quoted\n\n- one\n- two\n\n1. first\n2. second\n\n```ts\nconst x = 1;\n```");
    expect(blocks.map((block) => block.kind)).toEqual(["heading", "paragraph", "quote", "list", "list", "code"]);
    expect(blocks[0]).toMatchObject({ level: 1, content: [{ kind: "text", text: "Heading" }] });
    expect(blocks[3]).toMatchObject({ ordered: false, items: [[{ text: "one" }], [{ text: "two" }]] });
    expect(blocks[4]).toMatchObject({ ordered: true, items: [[{ text: "first" }], [{ text: "second" }]] });
    expect(blocks[5]).toEqual({ kind: "code", text: "const x = 1;" });
  });

  it("parses code, bold, italic, and web links", () => {
    expect(parseInline("`code` **bold** *italic* [site](https://example.com)")).toEqual([
      { kind: "code", text: "code" }, { kind: "text", text: " " },
      { kind: "bold", children: [{ kind: "text", text: "bold" }] }, { kind: "text", text: " " },
      { kind: "italic", children: [{ kind: "text", text: "italic" }] }, { kind: "text", text: " " },
      { kind: "link", href: "https://example.com", children: [{ kind: "text", text: "site" }] },
    ]);
  });

  it("renders javascript links as plain text tokens", () => {
    expect(parseInline("[click](javascript:alert)")).toEqual([{ kind: "text", text: "click" }]);
  });
});
