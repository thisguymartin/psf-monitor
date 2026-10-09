---
name: psf-monitor
description: A dark local workspace for agent sessions and model lanes.
colors:
  claude-bg: "#12100e"
  claude-canvas: "#171412"
  claude-layer: "#1c1916"
  claude-layer-2: "#25211d"
  claude-card: "#26221e"
  claude-card-hover: "#2c2723"
  claude-code-bg: "#14110f"
  claude-line: "#36302a"
  claude-line-strong: "#4d443b"
  claude-text: "#f2ece3"
  claude-text-2: "#bfb3a4"
  claude-text-3: "#9a8f80"
  claude-accent: "#d97757"
  claude-accent-strong: "#ee9677"
  claude-accent-soft: "rgb(217 119 87 / 0.15)"
  claude-accent-wash: "rgb(217 119 87 / 0.09)"
  claude-on-accent: "#1d120c"
  codex-bg: "#090d12"
  codex-canvas: "#0d1218"
  codex-layer: "#10161e"
  codex-layer-2: "#172030"
  codex-card: "#18212d"
  codex-card-hover: "#1d2836"
  codex-code-bg: "#0a0f15"
  codex-line: "#243142"
  codex-line-strong: "#344760"
  codex-text: "#e8eef7"
  codex-text-2: "#a6b4c7"
  codex-text-3: "#8a9ab0"
  codex-accent: "#4b8dff"
  codex-accent-strong: "#7cabff"
  codex-accent-soft: "rgb(75 141 255 / 0.15)"
  codex-accent-wash: "rgb(75 141 255 / 0.1)"
  codex-on-accent: "#06101f"
  done: "#52c48b"
  failed: "#f26b5e"
  attention: "#e2a845"
  provider-claude: "#d97757"
  provider-codex: "#4b8dff"
  provider-grok: "#c3c3d1"
  provider-deepseek: "#8b93ff"
  provider-minimax: "#f06a8a"
  provider-other: "#a9a39a"
typography:
  headline:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, \"Segoe UI Variable Text\", \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, sans-serif"
    fontSize: "21px"
    fontWeight: 650
    lineHeight: 1.45
  title:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, \"Segoe UI Variable Text\", \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, sans-serif"
    fontSize: "14.5px"
    fontWeight: 650
    lineHeight: 1.45
  body:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, \"Segoe UI Variable Text\", \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, \"Segoe UI Variable Text\", \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.45
  code:
    fontFamily: "ui-monospace, \"SF Mono\", \"JetBrains Mono\", \"Cascadia Code\", Menlo, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.7
rounded:
  field: "5px"
  navigation: "6px"
  control: "7px"
  composer: "8px"
  card: "14px"
  pill: "999px"
spacing:
  compact: "8px"
  control-gap: "12px"
  row: "16px"
  section: "28px"
  wide: "32px"
components:
  button-quiet:
    rounded: "{rounded.control}"
    padding: "5px 8px"
  button-send:
    rounded: "{rounded.composer}"
    padding: "10px 16px"
  input:
    rounded: "{rounded.field}"
    padding: "4px 8px"
  navigation:
    rounded: "{rounded.navigation}"
    padding: "8px 12px"
  chip:
    rounded: "{rounded.pill}"
    padding: "2px 9px"
  provider-card:
    rounded: "{rounded.card}"
    padding: "14px 16px 16px"
---
# Design System: psf-monitor

## Overview

**Creative North Star: "The Night Control Room"**

A compact local workspace for observing agent work. Dark surfaces, harness-colored accents, restrained controls, and dense lists keep names, status, and activity readable as sessions grow.

Warm Claude and cool Codex themes share one structure. The selected harness changes the light; component geometry and status meaning stay consistent. Configuration pages use the same materials as the live workspace.

**Key Characteristics:**

- Harness-specific dark surfaces
- Compact rows and tables with progressive disclosure
- Outlined controls and explicit status text
- Responsive navigation and full-width mobile details

## Colors

### Primary

Claude uses terracotta; Codex and OpenCode use signal blue. The `accent` family distinguishes active navigation, selected work, focus, and actions. `on-accent` supplies the corresponding dark label color. The prefixed frontmatter tokens record both themes; the application resolves them through unprefixed CSS variables.

### Secondary

Provider identity colors remain distinct from session status. Shared `done`, `failed`, and `attention` colors communicate completion, failure, and conditions requiring attention. Preserve their labels alongside color.

### Neutral

Each harness has a complete background, canvas, layer, card, code, border, and text family. Text has three levels of emphasis. Use the whole family when switching themes, including borders and control backgrounds.

**The Harness Light Rule.** Use the selected harness palette together; preserve shared success, failure, and attention meanings across themes.

## Typography

The incumbent interface uses the system UI stack for headings, body, and controls, with the monospace stack for model identifiers, commands, and output. There is no separate display face. The frontmatter records the configuration heading, section title, body, metadata, and output roles; overview section headings use 15px and session identities use 14px at weight 600. Preserve these local distinctions rather than forcing a geometric type scale.

**The Readable Density Rule.** Use compact text for metadata and distinguish identity with weight and placement. Keep status readable when rows wrap.

## Layout

The desktop shell uses a 284px workspace sidebar and a 52px top bar. Content owns its scrolling area. Configuration has an 1180px maximum width, 28px inset, and 28px section gaps. Overview uses 28px 32px 48px padding. Provider cards auto-fill from a 340px minimum, bounded by available width.

At 860px and below, navigation becomes a sliding drawer up to 320px or 90vw, with a scrim, close control, and 44px navigation targets; agent details occupy the full width. Overview priority columns stack at 1100px, with attention first. At 600px, overview padding becomes 20px 16px 36px and rows wrap metadata below identity. Explorer also responds to its container width, hiding secondary columns and wrapping status as the detail panel reduces space.

## Elevation & Depth

Configuration and overview rely on dark tonal layers and fine borders. Graph cards retain their incumbent subtle gradient, inset highlight, diffuse shadow, and activity glow. The detail panel uses a leftward shadow to separate it from work beneath. Shadows and motion are recorded in the sidecar. Reduced-motion rules suppress animation and drawer transitions.

**The Working Surface Rule.** Use tonal layers and borders for lists and configuration; reserve the existing glow and lifted treatment for graph activity and overlays.

## Shapes

Small rounded controls and fields sit inside larger rounded provider cards. Status chips are pills. Graph sessions retain their asymmetric capsule silhouette, and graph skill nodes retain their pill shape; these shapes identify graph entities rather than defining every page container. Rows and tables use straight dividing lines.

## Components

### Buttons

Quiet actions have an outlined border, secondary text, and a stronger border with a tonal background on hover. Send actions in the composer use the harness accent and its dark label color. Disabled buttons lower opacity; keyboard focus uses a two-pixel accent outline with two-pixel offset.

### Inputs

Fields use a layer background, fine border, and small rounded corners. Hover strengthens the border and focus adds the accent outline. The composer uses a larger field with code-background fill and room for multiline text.

### Navigation

Workspace links pair a small SVG icon with text. The current page uses the soft accent background, strong accent text, and increased weight. Mobile links expand to touch targets inside the drawer.

### Chips

Neutral pills label compact metadata. Ready, warning, and live states use their corresponding semantic color with translucent fill and border. Chip text keeps state explicit.

### Cards and rows

Provider cards use a layer fill and border; unavailable providers use dashed borders and disclose setup details on demand. Overview and explorer agent rows emphasize identity, show secondary activity and model metadata, and expose status without requiring an expanded transcript. Model usage stays tabular with numeric alignment.

## Do's and Don'ts

- Do use semantic CSS variables so both harness themes remain coherent.
- Do pair status color with readable labels or icons.
- Do keep navigation, hover, selection, and keyboard focus visibly distinct.
- Do preserve mobile wrapping, touch targets, and reduced-motion behavior.

- Don't replace the established harness themes with a new palette.
- Don't apply graph-card glows to every list row or configuration section.
- Don't truncate the only readable status or identity at narrow widths.
