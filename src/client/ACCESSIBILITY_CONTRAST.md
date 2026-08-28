# Accessibility contrast audit — kaleidoscope web client

WCAG 2.1 AA for text requires **4.5:1** for normal text (< 18px, or < 14px bold)
and **3:1** for large text and non-text UI/graphical objects (SC 1.4.11).

Ratios below are alpha-composited over the real background the token is painted
on (`--color-graph` #eef0ec / #13202a, `--color-graph-card`, `--color-inset`),
computed with the sRGB relative-luminance formula. Worst-case background shown.

**Every ratio below is recomputed on each `npm test` by `test/unit/contrast.test.ts`,**
which parses the real declarations out of `tokens.css` for both themes rather than
restating them. (An earlier revision of this file pointed at `scratchpad/contrast.mjs`,
which was never committed and no longer exists — a number nobody can re-derive is a
number nobody can trust, so the derivation is now a test.)

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


---

# Second pass — the D01 studio chrome (T06b, 2026-08-28)

The floating chrome introduced surfaces the first audit had no reason to consider:
a translucent panel (`--color-graph-card` at 88% over the ground), coloured fills
behind labels, and a set of 9–12px mono readouts sitting on tinted buttons. Three
of them failed, and two only in dark — which is why the checks are now a unit test
over both themes rather than an axe run over whichever theme the page happens to be in.

## New token

| Token | Light | Dark | Why |
|-------|-------|------|-----|
| `--color-on-crease` | `#ffffff` | `#13202a` | Label colour on a `--color-crease` fill. White is safe only in light. |

## New pairs (all recomputed, none copied)

| Pair | Theme | Ratio | Min | Verdict |
|------|-------|------:|----:|:-------:|
| `--color-on-crease` on `--color-crease` (`.seg.is-on` 12px, layer count badge 9px) | light | 6.78:1 | 4.5 | PASS |
| `--color-on-crease` on `--color-crease` | dark | 6.72:1 | 4.5 | PASS |
| ~~white~~ on `--color-crease` — **the value the mockup used** | dark | **2.47:1** | 4.5 | **FAIL → fixed by the token above** |
| `--color-graphite-40` (`.mono` 10px) on the chrome surface | light / dark | 5.34 / 5.92:1 | 4.5 | PASS |
| `--color-graphite-60` (`.mono-lg` readout 12px) on the chrome surface | light / dark | 5.68 / 6.52:1 | 4.5 | PASS |
| `--color-graphite-60` (`.rail-sub` 9px) on the `.icon-btn.is-active` crane tint | light / dark | 5.13 / 5.69:1 | 4.5 | PASS |
| ~~`--color-crane-strong`~~ on that same tint — **what `color: inherit` would give** | light / dark | **4.04 / 4.10:1** | 4.5 | **FAIL → `.rail-sub` is graphite-60** |
| `--color-graphite` (`.chip.is-on` label 12px) on the crane-10% chip tint | light / dark | 12.94 / 10.74:1 | 4.5 | PASS |
| ~~`--color-crane-strong`~~ as that label — **what the frame draws** | light / dark | 4.71 / **4.06:1** | 4.5 | **FAIL in dark → label is graphite** |
| `--color-graphite-60` (`kbd` 10px, shortcut strip) on `--color-inset` | light / dark | 5.92 / 6.10:1 | 4.5 | PASS |
| `--color-graphite` (`.toast` text 13px) on `--color-graph-card` | light / dark | 13.70 / 13.09:1 | 4.5 | PASS |
| `--color-graphite-40` (`.mono` 10px) on `--color-graph-card` (popovers) | light / dark | 5.36 / 5.90:1 | 4.5 | PASS |

## Non-text / graphical (3:1, SC 1.4.11)

| Element | Theme | Ratio | Verdict |
|---------|-------|------:|:-------:|
| `--color-crease` slider fill + toggle track, vs the chrome surface | light / dark | 6.26 / 6.37:1 | PASS |
| `--color-crease` edge-slider **thumb border**, vs the page ground | light / dark | 5.91 / 6.72:1 | PASS |
| ~~`--color-crease-line-bold`~~ as that thumb border — **what the frame draws** | light / dark | 1.51 / 1.78:1 | **FAIL → thumb border is solid crease** |
| `--color-crane` `.chip.is-on` border, vs `--color-inset` | light / dark | 3.86 / 4.53:1 | PASS |
| `--color-crane-strong` toast icon, vs `--color-graph-card` | light / dark | 4.99 / 4.95:1 | PASS |

**Known and accepted:** the *unfilled* remainder of an edge-slider track is
`--color-crease-line-bold`, 1.51:1 light / 1.78:1 dark against the ground — the same
hairline every `.btn` border already uses. The control is identified by its 22px thumb
(crease-bordered, ≥5.9:1) and by the crease fill below it, both past 3:1; the empty
remainder is background, the way an unfilled progress bar is. Raising it is a
one-line change if a future audit disagrees.

## Three changes made, and what each one is a deviation from

1. **`--color-on-crease`** — the mockup writes `#fff` on every crease fill. Shipped as a
   token so dark flips to the graph ground.
2. **`.rail-sub` is `--color-graphite-60`, not `color: inherit`.** The measurement sheet
   inherits the active button's crane; at 9px that is 4.04:1.
3. **`.chip.is-on`'s label is `--color-graphite` with `font-weight: 600`**, not crane.
   No tint strength rescues crane-strong in dark — 6% only reaches 4.25:1 — so the
   "on" state is carried by the crane border (3.86 / 4.53:1, past the 3:1 non-text
   minimum), the tint, and the weight.

**Result: every audited text pair meets WCAG 2.1 AA (4.5:1) in both themes; every
graphical mark meets 3:1. Re-derived, not asserted, by `test/unit/contrast.test.ts`.**
