# Accessibility contrast audit — kaleidoscope web client

WCAG 2.1 AA for text requires **4.5:1** for normal text (< 18px, or < 14px bold)
and **3:1** for large text and non-text UI/graphical objects (SC 1.4.11).

Ratios below are alpha-composited over the real background the token is painted
on (`--color-graph` #eef0ec / #13202a, `--color-graph-card`, `--color-inset`),
computed with the sRGB relative-luminance formula. Worst-case background shown.
All values verified with `scratchpad/contrast.mjs`.

## Text tokens

| Token | Theme | Used for (size) | Before | After | AA (4.5:1) |
|-------|-------|-----------------|-------:|------:|:----------:|
| `--color-graphite-60` | light | secondary text, `.empty` 15px, `.artwork-meta` 13px, menu labels | 5.52:1 | 5.52:1 (unchanged) | PASS |
| `--color-graphite-60` | dark  | same | 6.49:1 | 6.49:1 (unchanged) | PASS |
| `--color-graphite-40` | light | mono labels: `.slider-label` 10px, `.downloads-label` 11px, `.field span` 11px | **2.30:1** | **5.19:1** (0.40 → 0.70 alpha) | FAIL → PASS |
| `--color-graphite-40` | dark  | same | **4.35:1** | **5.57:1** (0.50 → 0.62 alpha) | FAIL → PASS |
| `--color-crane` as text (`.form-error` 13px, `.link-danger` 12px) | light | error / delete text | **3.37:1** | **4.68:1** (→ `--color-crane-strong` #c23a1c) | FAIL → PASS |
| `--color-crane` as text | dark | error / delete text | 5.25:1 | 5.25:1 (`--color-crane-strong` = #f5613c) | PASS |
| `.btn-primary` label (white 13px on crane) | light | Save / Remix button | **3.86:1** | **5.36:1** (bg crane → `--color-crane-dark` #c23a1c) | FAIL → PASS |
| `.btn-primary` label | dark | same | **3.15:1** | **5.36:1** (bg → crane-dark, constant across themes) | FAIL → PASS |
| `--color-crease` (`.link`) | light | inline links 15px | 5.91:1 | 5.91:1 (unchanged) | PASS |
| `--color-crease` (`.link`) | dark | inline links | 6.72:1 | 6.72:1 (unchanged) | PASS |
| `.avatar-fallback` initials (`--color-crease`) | both | author initials | ≥5.9:1 | unchanged | PASS |

## Non-text / graphical (3:1, SC 1.4.11)

| Element | Theme | Value | 3:1 | Note |
|---------|-------|------:|:---:|------|
| `.icon-btn.is-active` icon (SVG, no text) | light | 2.93 → **4.07:1** | PASS | routed to `--color-crane-strong`; also clears text 4.5 comfortably except the tinted-bg case, still ≥ 3:1 |
| `.icon-btn.is-active` icon | dark | 4.07:1 | PASS | on crane-16% tint over dark card |
| `.swatch.is-active` ring (`--color-crane`) | light | 3.37:1 | PASS | graphical selection ring; left as base crane |
| Focus outline (`--color-crease`, 2px) | both | ≥5.9:1 | PASS | unchanged |

## Changes made

- `--color-graphite-40`: light 0.40 → **0.70** alpha; dark 0.50 → **0.62** alpha (`tokens.css`).
- Added `--color-crane-strong` (light `#c23a1c`, dark `#f5613c`) for crane used as
  text; applied to `.form-error`, `.link-danger`, `.icon-btn.is-active`.
- `.btn-primary` background: `--color-crane` → `--color-crane-dark` so the white
  label clears AA in both themes; hover darkened via `color-mix`.
- `--color-graphite-60` and `--color-crease` were already AA-compliant — left unchanged.

## System-preference support (added)

- `@media (prefers-contrast: more)` (`tokens.css`): collapses graphite-40/60 to full
  `--color-graphite` and bolds hairlines/grid lines in both themes.
- `@media (forced-colors: active)` (`studio.css`): re-expresses `.icon-btn.is-active`
  and `.swatch.is-active` pressed states with a `Highlight` system-color outline
  (background/border colors are flattened in forced-colors), and uses `GrayText`
  for disabled controls (opacity is ignored in that mode).

**Result: all audited text tokens meet WCAG 2.1 AA (4.5:1); all graphical marks meet 3:1.**
