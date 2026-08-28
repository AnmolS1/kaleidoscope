import { describe, expect, it } from "vitest";
// `?raw` rather than `node:fs`: `tsconfig.app.json` (which covers test/unit) has
// no node types, and Vite's raw import is the idiomatic way to read a source
// file as a string here.
import tokensCss from "../../src/client/styles/tokens.css?raw";

/**
 * WCAG contrast, computed from the SHIPPED token values in `tokens.css`.
 *
 * Why this exists as a unit test rather than only as an axe run: axe renders in
 * whatever theme the page is in, and `a11y.spec.ts` scans the light theme. Its
 * one dark-mode scan had to be removed — a dark-mode `analyze()` reliably hangs
 * the Playwright worker (see the note in that file) — and a token that is only
 * wrong in dark is exactly the failure this project has hit before: white on
 * the dark theme's lighter crease (`#82a9ce`) is 2.47:1.
 *
 * This checks the pairs recorded in `src/client/ACCESSIBILITY_CONTRAST.md`
 * against the real declarations, so editing a token without re-deriving the doc
 * fails here rather than shipping. It parses the CSS instead of restating the
 * hex values: a test that carried its own copy of the palette would still pass
 * after someone changed the palette.
 */

const CSS = tokensCss;

function block(selector: string): Record<string, string> {
  const i = CSS.indexOf(selector + " {");
  if (i < 0) throw new Error(`no ${selector} block in tokens.css`);
  const body = CSS.slice(i, CSS.indexOf("\n}", i));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

const LIGHT = block(":root");
const DARK = { ...LIGHT, ...block('[data-theme="dark"]') };

type RGB = [number, number, number];

/** #rrggbb or rgba(r, g, b, a) → premultiplied over `bg`. */
function parse(value: string, bg: RGB): RGB {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgba = /^rgba?\(([^)]+)\)$/.exec(value.trim());
  if (!rgba) throw new Error(`unparsed colour: ${value}`);
  const parts = rgba[1].split(",").map((p) => Number(p.trim()));
  const a = parts.length > 3 ? parts[3] : 1;
  return [0, 1, 2].map((i) => parts[i] * a + bg[i] * (1 - a)) as RGB;
}

/** Alpha-composite `fg` at `alpha` over `bg`. */
function mix(fg: RGB, alpha: number, bg: RGB): RGB {
  return [0, 1, 2].map((i) => fg[i] * alpha + bg[i] * (1 - alpha)) as RGB;
}

function luminance([r, g, b]: RGB): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function ratio(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const round = (n: number) => Math.round(n * 100) / 100;

interface Theme {
  graph: RGB;
  card: RGB;
  inset: RGB;
  /** The floating chrome surface: `--color-graph-card` at 88% over the ground. */
  chrome: RGB;
  /** `.icon-btn.is-active` — crane at 16% over the chrome surface. */
  activeTint: RGB;
  /** `.chip.is-on` — crane at 10% over the inset. */
  chipTint: RGB;
  token: (name: string, over: RGB) => RGB;
}

function theme(vars: Record<string, string>): Theme {
  const graph = parse(vars["--color-graph"], [255, 255, 255]);
  const card = parse(vars["--color-graph-card"], graph);
  const inset = parse(vars["--color-inset"], graph);
  const chrome = mix(card, 0.88, graph);
  const crane = parse(vars["--color-crane"], chrome);
  return {
    graph,
    card,
    inset,
    chrome,
    activeTint: mix(crane, 0.16, chrome),
    chipTint: mix(parse(vars["--color-crane"], inset), 0.1, inset),
    token: (name, over) => parse(vars[name], over),
  };
}

const THEMES: [string, Theme][] = [
  ["light", theme(LIGHT)],
  ["dark", theme(DARK)],
];

// [what it is, foreground, background, minimum]. 4.5 for text under 18px,
// 3 for graphical objects and control boundaries (SC 1.4.11).
function cases(t: Theme): [string, RGB, RGB, number][] {
  return [
    // Text
    ["--color-on-crease on a crease fill (.seg.is-on 12px, count badge 9px)", t.token("--color-on-crease", t.token("--color-crease", t.chrome)), t.token("--color-crease", t.chrome), 4.5],
    ["--color-graphite-40 (.mono 10px) on the chrome surface", t.token("--color-graphite-40", t.chrome), t.chrome, 4.5],
    ["--color-graphite-60 (.mono-lg readout 12px) on the chrome surface", t.token("--color-graphite-60", t.chrome), t.chrome, 4.5],
    ["--color-graphite-60 (.rail-sub 9px) on the active crane tint", t.token("--color-graphite-60", t.activeTint), t.activeTint, 4.5],
    ["--color-graphite (.chip.is-on label 12px) on the chip tint", t.token("--color-graphite", t.chipTint), t.chipTint, 4.5],
    ["--color-graphite-60 (kbd 10px) on --color-inset", t.token("--color-graphite-60", t.inset), t.inset, 4.5],
    ["--color-graphite (.toast text 13px) on --color-graph-card", t.token("--color-graphite", t.card), t.card, 4.5],
    ["--color-graphite-40 (.mono 10px) on --color-graph-card", t.token("--color-graphite-40", t.card), t.card, 4.5],
    ["--color-crane-strong as text on the page ground", t.token("--color-crane-strong", t.graph), t.graph, 4.5],
    ["white on --color-crane-dark (.btn-primary label)", [255, 255, 255], t.token("--color-crane-dark", t.graph), 4.5],
    // Graphical / control boundaries
    ["--color-crane-strong (.icon-btn.is-active icon) on the active tint", t.token("--color-crane-strong", t.activeTint), t.activeTint, 3],
    ["--color-crease (slider fill, toggle track) on the chrome surface", t.token("--color-crease", t.chrome), t.chrome, 3],
    ["--color-crease (slider thumb border) on the page ground", t.token("--color-crease", t.graph), t.graph, 3],
    ["--color-crane (.chip.is-on border) on --color-inset", t.token("--color-crane", t.inset), t.inset, 3],
    ["--color-crane (.swatch.is-active ring) on the page ground", t.token("--color-crane", t.graph), t.graph, 3],
  ];
}

describe.each(THEMES)("%s theme token contrast", (_name, t) => {
  it.each(cases(t))("%s", (_what, fg, bg, min) => {
    expect(round(ratio(fg, bg))).toBeGreaterThanOrEqual(min);
  });
});

describe("the values the audit document quotes", () => {
  // The doc is a deliverable; these pin the two numbers whose whole point is
  // that they were wrong once. If a token moves, the doc has to move with it.
  it("white on the dark crease is the failure --color-on-crease exists to avoid", () => {
    const dark = theme(DARK);
    expect(round(ratio([255, 255, 255], dark.token("--color-crease", dark.chrome)))).toBe(2.47);
  });

  it("crane-strong on the active tint is below AA for text, which is why .rail-sub is graphite", () => {
    const light = theme(LIGHT);
    expect(round(ratio(light.token("--color-crane-strong", light.activeTint), light.activeTint))).toBeLessThan(4.5);
  });
});
