# Kaleidoscope iOS — WCAG Contrast Audit

Contrast ratios for the `Blueprint` design tokens (`Shared/Theme.swift`) and the
inline `.opacity(...)` text uses, computed against the app background
`Blueprint.graph` in **both** the light and dark themes.

- **Background** `Blueprint.graph` — light `#EEF0EC`, dark `#13202A`.
- Ratios use the WCAG 2.1 relative-luminance formula; translucent foregrounds are
  first alpha-composited over the background.
- **Thresholds:** body/small text **4.5:1**; large text (≥18pt, or ≥14pt bold)
  and UI component / graphical objects **3:1**.
- Source of numbers: `scratchpad/contrast.py` (checked-in values below).

## Solid text tokens on `graph`

| Token | Hex (light / dark) | Typical use | Light | Dark | Bar | Light | Dark |
|-------|--------------------|-------------|------:|-----:|:---:|:-----:|:-----:|
| `graphite` | `#1B2A33` / `#E9ECE7` | Primary body text | 12.84 | 13.90 | 4.5 | PASS | PASS |
| `crease` | `#2E5E8C` / `#82A9CE` | Secondary text, tint | 5.91 | 6.72 | 4.5 | PASS | PASS |
| `crane` | `#E84A27` / `#F5613C` | Button/accent tint (UI only) | 3.37 | 5.25 | 3.0 | PASS | PASS |
| `sax` | `#D9A521` | Chip text (was) | **1.96** | 7.38 | 4.5 | **FAIL** | PASS |
| `saxText` *(new)* | `#7A5A0F` / `#D9A521` | Chip text (now) | 5.55 | 7.38 | 4.5 | PASS | PASS |
| `craneText` *(new)* | `#A83618` / `#F26B44` | Bordered Like button label | 5.71 | 5.49 | 4.5 | PASS | PASS |

Notes:
- **`crane`** never renders as text; its only uses are the tab tint and the
  selection ring — graphical/UI objects judged at the **3:1** bar, which it
  clears in both themes (light 3.37, dark 5.25). Row is marked against 3:1
  accordingly. (As body text it would fail light at 3.37 — deliberately avoided;
  the bordered Like button, previously crane-tinted text at 3.37 light, now uses
  the **`craneText`** token above.)
- **`sax` as text was the one real failure** (1.96:1 light): it tinted the small
  AI-name chip captions in `SaveSheet`. Fixed by introducing **`Blueprint.saxText`**
  (`#7A5A0F` in light, unchanged `#D9A521` in dark) and pointing the chips at it.
  Decorative `sax` uses (the `RosetteMark` rings) are unchanged — non-text.

## Secondary text via inline opacity (`graphite.opacity(x)` on `graph`)

Used for captions / descriptions in About, AuthSheet, ShuffleViewer, etc.

| Foreground | Light | Dark | Bar | Light | Dark |
|-----------|------:|-----:|:---:|:-----:|:-----:|
| `graphite.opacity(0.85)` | 8.27 | 10.34 | 4.5 | PASS | PASS |
| `graphite.opacity(0.80)` | 7.07 | 9.30 | 4.5 | PASS | PASS |
| `graphite.opacity(0.75)` | 6.05 | 8.33 | 4.5 | PASS | PASS |
| `graphite.opacity(0.70)` | 5.19 | 7.42 | 4.5 | PASS | PASS |

All secondary-text opacity levels pass the 4.5:1 body bar in both themes.

## Non-text / decorative uses of `crease.opacity(x)`

These are hairline frames, wedge guides, and image placeholders — **not text and
not controls needed to operate the UI**, so WCAG's 3:1 UI-object minimum does not
apply (they are decorative per 1.4.11). Listed for completeness.

| Use | Opacity | Light | Dark | Category |
|-----|--------:|------:|-----:|----------|
| Card / image border overlay | 0.50 | 2.18 | 2.70 | Decorative frame |
| Shuffle card stroke | 0.40 | 1.83 | 2.20 | Decorative frame |
| Widget blueprint frame | 0.35 | 1.69 | 1.98 | Decorative frame |
| AsyncImage placeholder fill | 0.12 | 1.18 | 1.23 | Loading placeholder |

## Filled (prominent) buttons

A filled button's label is **text**, so it is judged at the **4.5:1** body bar,
not the 3:1 graphical bar. `borderedProminent` otherwise lets the *system* pick
the label color, which is not statically verifiable — so every prominent button
below **pins `.foregroundStyle(.white)`** and uses a WCAG-tuned fill token
(`craneButton` / `creaseButton`, `Shared/Theme.swift`) that is dark enough for a
white label in **both** themes. The two right-hand columns also confirm the fill
still separates from the `graph` background at the 3:1 UI-component bar.

| Button (file) | Fill token | Label | Light | Dark | Bar | Light | Dark | Fill-vs-bg L/D |
|---------------|-----------|-------|------:|-----:|:---:|:-----:|:-----:|:--------------:|
| Save (`StudioView`) | `craneButton` `#C23A1C` | white | 5.36 | 5.36 | 4.5 | PASS | PASS | 4.68 / 3.09 |
| Sign in (`YouView`) | `craneButton` `#C23A1C` | white | 5.36 | 5.36 | 4.5 | PASS | PASS | 4.68 / 3.09 |
| Shuffle (`ShuffleViewer`) | `craneButton` `#C23A1C` | white | 5.36 | 5.36 | 4.5 | PASS | PASS | 4.68 / 3.09 |
| Try again (`ShuffleViewer`) | `craneButton` `#C23A1C` | white | 5.36 | 5.36 | 4.5 | PASS | PASS | 4.68 / 3.09 |
| Remix (`ArtworkView`) | `creaseButton` `#2E5E8C`/`#40729E` | white | 6.78 | 5.10 | 4.5 | PASS | PASS | 5.91 / 3.25 |

Notes:
- **Before:** these used plain `crane` / `crease` with a system-chosen label.
  White-on-`crane` was **3.86 (light) / 3.15 (dark)** and white-on-`crease` was
  **6.78 (light) / 2.47 (dark)** — both below the 4.5:1 text bar (crease-dark
  even below 3:1). The new tokens + pinned white label fix every case.
- The **bordered** Like button (`ArtworkView`) is not filled; its label renders in
  the tint color, now `craneText` (5.71 light / 5.49 dark — see the table above).
- Other bordered buttons already passed as text and are unchanged: Download PNG /
  Open on the web use `crease` (5.91 / 6.72), Share / Sign-in-with-Google use
  `graphite` (12.84 / 13.90).
- The widget caption (white on a black→clear gradient over art) is ~21:1.

The app's tab bar keeps the plain `crane` tint: a selected-tab tint is a system
UI component (3:1 bar, 3.37 light / 5.25 dark), not body text.

## Selected button-style toggles (Studio)

The Studio's Glow / Mirror / Guides / Dark / Spectrum toggles are button-style
toggles: **selected** fills the label's background with a color. `.toggleStyle(.button)`
uses the raw tint as that fill and lets the *system* pick the label color — not
verifiable, and it drops below 4.5:1 on light tints. They now use a custom
`ContrastToggleStyle` (`App/Studio/StudioView.swift`) with an explicit fill token
+ a **pinned** label color. Ratios are label-vs-fill, so they are theme-agnostic
except where the fill token is a light/dark pair.

| Toggle | Selected fill | Label | Light | Dark | Bar | Light | Dark |
|--------|---------------|-------|------:|-----:|:---:|:-----:|:-----:|
| Spectrum | `craneButton` `#C23A1C` | white | 5.36 | 5.36 | 4.5 | PASS | PASS |
| Mirror | `creaseButton` `#2E5E8C`/`#40729E` | white | 6.78 | 5.10 | 4.5 | PASS | PASS |
| Guides | `creaseButton` `#2E5E8C`/`#40729E` | white | 6.78 | 5.10 | 4.5 | PASS | PASS |
| Glow | `sax` `#D9A521` | `onSax` `#13202A` | 7.38 | 7.38 | 4.5 | PASS | PASS |
| Dark | `graphite` `#1B2A33`/`#E9ECE7` | `graph` `#EEF0EC`/`#13202A` | 12.84 | 13.90 | 4.5 | PASS | PASS |

Notes:
- **Before:** `.toggleStyle(.button)` selected labels were white on the raw tint —
  white on `sax` **≈1.6:1** and white on dark-mode `graphite` (**#E9ECE7**, a light
  fill) **≈1.1:1** were the worst; crane/crease selected labels were 3.15–3.86:1.
  All below the 4.5:1 text bar.
- **Glow** uses a *dark* pinned label (white fails on light gold); **Dark** pairs
  the `graphite` fill with the `graph` label so both flip with the theme and the
  contrast stays ~13:1 either way.
- The **off/unselected** state now renders the label in neutral `graphite`
  (~12.84:1 on the graph background) instead of the tint color — this also fixes
  the previously tinted off-labels (gold `sax` off-label was **1.96:1**, crane
  3.37:1).

## Result

**All text — body, secondary, and button labels — passes 4.5:1** in both light
and dark themes:
- `sax` chip caption (was 1.96:1 light) → fixed by `saxText` (5.55:1 light).
- Prominent button labels (Save / Sign in / Shuffle / Try again / Remix), which
  were white on plain `crane` (3.15:1 dark) or `crease` (2.47:1 dark), now use the
  `craneButton` / `creaseButton` fills with a **pinned** white label — 5.10:1+ in
  the worst case.
- The bordered Like button label (was crane at 3.37:1 light) → `craneText`
  (5.71:1 light).
- The Studio button-style toggles (Glow / Mirror / Guides / Dark / Spectrum),
  whose selected labels were system-white on the raw tint (≈1.1–3.86:1), now use
  a custom `ContrastToggleStyle` with pinned labels — 5.10:1+ selected, and the
  off labels are neutral `graphite` (12.84:1) rather than the tint.

Remaining sub-threshold rows are decorative frames/placeholders (not text, not
operable UI) and are out of scope per WCAG 1.4.3 / 1.4.11.

---

# 1.2 — the blueprint-instrument studio (T12)

The 1.2 studio replaces the controls panel with chrome floating over a full-bleed
canvas, which adds four grounds a control can sit on. Every ratio below was
computed by alpha-compositing the foreground over the ground first (an
`.opacity()` foreground dims *toward its backdrop*, so the raw token's ratio is
not the one on screen).

**The chrome surface is itself a composite.** `--color-graph-card` at 88% over
the canvas ground resolves to **#F5F6F3** light / **#17242F** dark; those are the
grounds used for anything on the rail, the readout capsule, the zoom badge and
the top actions.

**The studio's colour scheme follows the CANVAS, not the system.** Every
`Blueprint` token is a light/dark pair keyed on `userInterfaceStyle`, so a dark
canvas under a light system appearance put graphite ink on a near-black ground —
about 1.2:1 for the edge-slider labels. `StudioView` now sets
`environment(\.colorScheme,)` from `model.background`, so the numbers below are
the ones that actually render in both canvas modes.

## Studio chrome

| Pair | Light | Dark | Bar | |
|---|---:|---:|:---:|:---:|
| `graphite` on `graph-card` (panel body, 13pt) | 13.70 | 13.09 | 4.5 | PASS |
| `graphite` @0.85 on chrome (readout capsule) | 8.56 | 9.91 | 4.5 | PASS |
| `graphite` @0.70 on `graph-card` (mono labels) | 5.33 | 7.09 | 4.5 | PASS |
| `graphite` @0.70 on `graph` (SIZE / OPAC labels) | 5.23 | 7.44 | 4.5 | PASS |
| `graphite` @0.72 on chrome (rail glyphs) | 5.69 | 7.50 | 3.0 | PASS |
| `graphite` @0.85 on `inset` (chip labels) | 9.13 | 9.06 | 4.5 | PASS |
| `graphite` @0.80 on the active crane fill (rail caption) | 6.45 | 7.57 | 4.5 | PASS |
| `craneStrong` on `graph-card` (active rail glyph) | 6.09 | 5.17 | 3.0 | PASS |
| white on `creaseButton` (layer-count badge) | 6.78 | 5.10 | 4.5 | PASS |
| white on `craneButton` (Save) | 5.36 | 5.36 | 4.5 | PASS |
| `crease` slider fill vs its `creaseLineBold` track | 3.92 | 3.78 | 3.0 | PASS |
| `crease` tick vs `graph-card` (dial, filled) | 6.31 | 6.33 | 3.0 | PASS |
| `crane` handle ring vs `graph-card` (dial) | 3.59 | 4.95 | 3.0 | PASS |

`craneStrong` is DESIGN.md §1's "crane as text". It resolves to the existing
`craneText` token, **not** to the spec's literal `#C23A1C`, which is only 4.10:1
on the light graph ground. §1 also says the rules in this document still hold, so
where the two disagree the contrast rule wins.

## Two fixes this pass

- **The rail's mono caption** (`9 · D` under the symmetry glyph) inherited the
  active button's `craneStrong` tint, which on the 16% crane fill is **4.25:1 in
  dark** — a fail for 10pt text. It is a readout, not part of the active-state
  indication, so it is now pinned to `graphite` @0.8 (6.45 / 7.57).
- **The edge-slider thumb.** The frame draws its border as `rgba(46,94,140,.28)`,
  which puts a white thumb on the light graph ground at **1.15:1** behind a
  **1.51:1** outline — a slider handle that is not visible, and a WCAG 1.4.11 fail
  at the 3:1 bar for an operable component. The border is now solid `crease`:
  5.91 / 6.72 against the ground, 6.78 / 5.79 against the thumb's own fill. A
  deliberate deviation from the frame, recorded here.

## Sub-threshold rows that are deliberate, and why

These are the rows a naive sweep flags. Each is a *reinforcement* of a state that
is carried elsewhere at threshold, not the state's only signal.

- **Active-button wash — crane 16% fill, 1.23 / 1.22 vs the surface.** DESIGN.md
  fixes this at 16% fill + 35% border. The state's perceivable signals are the
  glyph turning `craneStrong` (6.09 / 5.17 against the surface), the `.isSelected`
  accessibility trait, and — because a colour change alone is a colour-only cue —
  a filled dot under the glyph when **Differentiate Without Color** is on. The
  wash is the fourth signal, not the first.
- **Dial ticks below the current value — `creaseLineBold`, 1.52 / 1.78 vs the
  card.** These are the *unfilled* part of a scale, the same category as a
  slider's empty track. The value is read from the handle (3.59 / 4.95), from the
  filled ticks (6.31 / 6.33, and 4.14 / 3.56 against the unfilled ones), from the
  `12 segments · mirrored` caption under it, and from the dial's own
  `accessibilityValue`.
- **Card and hairline borders vs the ground.** A panel is separated by its fill
  plus `--shadow-card`; the 1pt hairline is a refinement of that edge rather than
  the edge itself.

## Where the moved controls kept their labels

Every VoiceOver string the 1.1 audit fixed still exists, on the same control, at
its new location — `Clear canvas`, `Dark canvas` and `Symmetry guides` in the
More menu; `teal` / `crane orange` / `Rainbow spectrum brush` in the colour
popover (the strip, on a phone); `Mirror symmetry` on the dial's centre disc;
`Download PNG`, `Save`, `Glow brush`, `Undo`, `Redo` unchanged. `AccessibilityUITests`
asserts each one through its new path rather than dropping the assertion.

New in 1.2: the dial is one `accessibilityAdjustableAction` element whose value is
DESIGN.md §3's `aria-valuetext` form verbatim (`12 segments, mirrored`); the edge
sliders are adjustable elements rather than rotated `Slider`s (a rotated Slider
keeps its original hit rectangle and drags VoiceOver's coordinate space with it);
each layer row carries Move up / Move down / Rename as custom actions, because
reordering by drag is not an interaction a screen-reader user has; and every touch
target is ≥44pt, including the 26pt swatches and the 4pt slider tracks.

At accessibility Dynamic Type sizes the rail widens to 76pt, the edge sliders give
way to the Brush popover's own Size and Opacity rows (a 10pt label and a 4pt track
cannot scale), the rail's `9 · D` caption is dropped rather than truncated to
`9 · …` (the value stays in the button's `accessibilityValue` and in the readout),
and the palette wraps to a grid — as a single row it overflowed the 260pt card and
clipped crane orange and teal off the ends.
