// Generates golden serialization fixtures for the Swift KaleidoEngine port by
// running the REAL web serializer (src/client/engine/strokes.ts). The Swift
// engine must reproduce these byte-for-byte. Run:
//
//   npx vite-node ios/tools/gen-engine-fixtures.ts
//
// Output: ios/KaleidoEngine/Tests/KaleidoEngineTests/Fixtures/golden.json
// Never hand-edit the expected strings — regenerate from the web serializer so
// the fixtures encode the source of truth, not our assumptions.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { serialize, type Drawing } from "../../src/client/engine/strokes";

interface Fixture {
  name: string;
  drawing: Drawing;
  expected: string;
}

// Each case targets a specific fidelity hazard for the Swift port.
const cases: { name: string; drawing: Drawing }[] = [
  {
    name: "empty",
    drawing: { v: 1, bg: "light", sym: { segments: 6, mirror: true }, strokes: [] },
  },
  {
    name: "integers-and-trailing-zeros",
    drawing: {
      v: 1,
      bg: "dark",
      sym: { segments: 12, mirror: false },
      // size 10 -> "10" (not "10.00"); opacity 1 -> "1"; pressure 0 -> "0".
      strokes: [{ tool: "solid", color: "#00ff88", size: 10, opacity: 1, pts: [[0, 0, 0]] }],
    },
  },
  {
    name: "fractions-and-padding",
    drawing: {
      v: 1,
      bg: "light",
      sym: { segments: 3, mirror: false },
      // 0.05 needs a padded leading zero; 0.5 must not print "0.50".
      strokes: [
        { tool: "solid", color: "#123456", size: 2.5, opacity: 0.5, pts: [[0.05, 0.001, 0.07], [0.5, 0.25, 0.5]] },
      ],
    },
  },
  {
    name: "negative-coords-half-up-rounding",
    drawing: {
      v: 1,
      bg: "light",
      sym: { segments: 8, mirror: true },
      // -0.1235 and 0.1235 exercise JS Math.round's toward-+inf half handling
      // under floating-point wobble (0.1235*1000 is actually 123.4999…).
      strokes: [
        {
          tool: "solid",
          color: "#ffffff",
          size: 7.125,
          opacity: 0.333,
          pts: [
            [-0.1235, 0.1235, 0.5],
            [-0.5005, 0.5005, 0.25],
            [-0.0001, 0.0004, 0.005], // round toward zero -> must serialize "0", never "-0"
            [1.5, -2, 1],
          ],
        },
      ],
    },
  },
  {
    name: "spectrum-and-glow",
    drawing: {
      v: 1,
      bg: "dark",
      sym: { segments: 24, mirror: true },
      strokes: [
        { tool: "glow", color: "spectrum", size: 18.4, opacity: 0.7, pts: [[0.2, 0.2, 0.6], [0.21, 0.19, 0.62]] },
        { tool: "solid", color: "#e84a27", size: 4, opacity: 0.85, pts: [[-0.3, 0.4, 0.9]] },
      ],
    },
  },
  {
    name: "many-points",
    drawing: {
      v: 1,
      bg: "light",
      sym: { segments: 5, mirror: false },
      strokes: [
        {
          tool: "solid",
          color: "#2e5e8c",
          size: 3.33,
          opacity: 0.9,
          pts: Array.from({ length: 20 }, (_, i) => [
            (i - 10) / 13,
            Math.sin(i) / 2,
            (i % 10) / 10,
          ]) as Drawing["strokes"][number]["pts"],
        },
      ],
    },
  },
];

const fixtures: Fixture[] = cases.map((c) => ({
  name: c.name,
  drawing: c.drawing,
  expected: serialize(c.drawing),
}));

const outPath = join(
  process.cwd(),
  "ios/KaleidoEngine/Tests/KaleidoEngineTests/Fixtures/golden.json",
);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(fixtures, null, 2) + "\n");
console.log(`Wrote ${fixtures.length} fixtures to ${outPath}`);
for (const f of fixtures) console.log(`  ${f.name}: ${f.expected.slice(0, 72)}${f.expected.length > 72 ? "…" : ""}`);
