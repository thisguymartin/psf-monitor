// DOM helpers for the monitor page. Transcript text only
// ever reaches the page through textContent; markup is built, never parsed.

const SVG_NS = "http://www.w3.org/2000/svg";

type Child = Node | string | null | false | undefined;

export interface Props {
  readonly class?: string;
  readonly text?: string;
  readonly title?: string;
  readonly attrs?: Readonly<Record<string, string>>;
  readonly on?: Readonly<Partial<Record<keyof HTMLElementEventMap, (event: Event) => void>>>;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (props.class !== undefined) element.className = props.class;
  if (props.text !== undefined) element.textContent = props.text;
  if (props.title !== undefined) element.title = props.title;
  for (const [name, value] of Object.entries(props.attrs ?? {})) element.setAttribute(name, value);
  for (const [name, listener] of Object.entries(props.on ?? {})) {
    if (listener !== undefined) element.addEventListener(name, listener);
  }
  for (const child of children) {
    if (child === null || child === false || child === undefined) continue;
    element.append(child);
  }
  return element;
}

export function svgElement<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Readonly<Record<string, string | number>> = {},
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, String(value));
  return element;
}

// One stroke family: 24-unit grid, 1.75 stroke, round caps and joins.
const ICONS = {
  claude: ["M12 3.5v17", "M3.5 12h17", "M6 6l12 12", "M18 6 6 18"],
  codex: ["M4.5 5h15a1.5 1.5 0 0 1 1.5 1.5v11a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-11A1.5 1.5 0 0 1 4.5 5Z", "m7.5 10 3 2.25-3 2.25", "M13 15h3.5"],
  grok: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z", "M6.5 17.5 17.5 6.5"],
  deepseek: ["M3 13c2.2-4.5 4.4-4.5 6.6 0s4.4 4.5 6.6 0 2.9-3.2 4.8-1.5"],
  minimax: ["M4 18V6.5l8 8.5 8-8.5V18"],
  agent: ["M12 3.2 19.5 7.6v8.8L12 20.8 4.5 16.4V7.6Z", "M12 12l7.5-4.4", "M12 12v8.8", "M12 12 4.5 7.6"],
  lane: ["M4 7h11", "M4 17h11", "m15 4 3.5 3L15 10", "m15 14 3.5 3-3.5 3"],
  check: ["m5 12.5 4.5 4.5L19 7.5"],
  cross: ["M6.5 6.5l11 11", "M17.5 6.5l-11 11"],
  stop: ["M8 8h8v8H8Z"],
  pause: ["M9.5 7v10", "M14.5 7v10"],
  dot: ["M12 11.2a.8.8 0 1 0 0 1.6.8.8 0 0 0 0-1.6Z"],
  question: ["M9.4 9.2a2.7 2.7 0 1 1 3.7 2.5c-.7.3-1.1.9-1.1 1.6v.5", "M12 17.2v.3"],
  spinner: ["M12 4a8 8 0 1 1-8 8"],
  terminal: ["m5 7 4.5 5L5 17", "M12 17h7"],
  file: ["M7 3.5h6.5L18 8v12.5H7Z", "M13.5 3.5V8H18"],
  pencil: ["M15.5 4.5l4 4L9 19H5v-4Z", "m13.5 6.5 4 4"],
  search: ["M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Z", "m15.5 15.5 4.5 4.5"],
  globe: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z", "M3 12h18", "M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z"],
  tool: ["M14.5 5.5a4 4 0 0 0-5 5L4 16l4 4 5.5-5.5a4 4 0 0 0 5-5l-2.6 2.6-2.8-.6-.6-2.8Z"],
  user: ["M12 4.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z", "M5 19.5c1.2-3.3 3.9-5 7-5s5.8 1.7 7 5"],
  reply: ["M5 6.5h14v9H10l-4 3.5v-3.5H5Z"],
  thought: ["M8 15.5a5 5 0 1 1 8.5-3.5c0 1.6-.8 2.6-1.6 3.3-.6.5-.9 1.2-.9 2v.7h-4v-.7c0-.7-.4-1.3-1-1.8Z", "M10 20.5h4"],
  info: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z", "M12 11v5", "M12 7.8v.4"],
  alert: ["M12 4 21 19.5H3Z", "M12 10v4.5", "M12 17.2v.3"],
  chevronRight: ["m9.5 6 6 6-6 6"],
  chevronDown: ["m6 9.5 6 6 6-6"],
  close: ["M6.5 6.5l11 11", "M17.5 6.5l-11 11"],
  plus: ["M12 5v14", "M5 12h14"],
  minus: ["M5 12h14"],
  fit: ["M4 9V4h5", "M15 4h5v5", "M20 15v5h-5", "M9 20H4v-5"],
  follow: ["M12 3v3.5", "M12 17.5V21", "M3 12h3.5", "M17.5 12H21", "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z"],
  sessions: ["M4 6h16", "M4 12h16", "M4 18h10"],
  arrowDown: ["M12 5v14", "m6 13 6 6 6-6"],
  arrowRight: ["M5 12h14", "m13 6 6 6-6 6"],
  widen: ["M9 5H4v14h5", "M15 5h5v14h-5", "m7 12 3-3", "m7 12 3 3", "m17 12-3-3", "m17 12-3 3"],
  folder: ["M3.5 6.5a1.5 1.5 0 0 1 1.5-1.5h4l2 2.5h8a1.5 1.5 0 0 1 1.5 1.5v8.5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5Z"],
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, className = "icon"): SVGSVGElement {
  const root = svgElement("svg", {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": 1.75,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    focusable: "false",
    class: className,
  });
  for (const d of ICONS[name]) root.append(svgElement("path", { d }));
  return root;
}

/** The product mark: a parent node fanning out to two children. */
export function logo(): SVGSVGElement {
  const root = svgElement("svg", { viewBox: "0 0 28 28", class: "logo", "aria-hidden": "true", focusable: "false" });
  root.append(
    svgElement("path", { d: "M8.5 14C13 14 13 7.5 18 7.5M8.5 14C13 14 13 20.5 18 20.5", class: "logo-wire" }),
    svgElement("circle", { cx: 6, cy: 14, r: 3.25, class: "logo-node logo-root" }),
    svgElement("circle", { cx: 21, cy: 7.5, r: 3, class: "logo-node" }),
    svgElement("circle", { cx: 21, cy: 20.5, r: 3, class: "logo-node" }),
  );
  return root;
}

export function providerIcon(provider: string): IconName {
  switch (provider) {
    case "claude":
    case "codex":
    case "grok":
    case "deepseek":
    case "minimax":
      return provider;
    default:
      return "agent";
  }
}

export function toolIcon(name: string): IconName {
  const lower = name.toLowerCase();
  if (/(bash|shell|exec|command|terminal)/.test(lower)) return "terminal";
  if (/(edit|write|patch|notebook)/.test(lower)) return "pencil";
  if (/(read|file|view)/.test(lower)) return "file";
  if (/(grep|glob|search|find|query)/.test(lower)) return "search";
  if (/(fetch|web|url|browse)/.test(lower)) return "globe";
  if (/(agent|task|spawn|send_message|followup)/.test(lower)) return "agent";
  return "tool";
}

export function clear(element: Element): void {
  while (element.firstChild !== null) element.firstChild.remove();
}
