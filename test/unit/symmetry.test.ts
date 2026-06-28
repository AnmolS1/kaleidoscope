import { describe, it, expect } from "vitest";
import {
  forEachImage,
  imageCount,
  transformPoint,
  clampSegments,
  imageTransformSvg,
  type SymmetryImage,
} from "../../src/client/engine/symmetry";

function collect(segments: number, mirror: boolean): SymmetryImage[] {
  const out: SymmetryImage[] = [];
  forEachImage(segments, mirror, (img) => out.push(img));
  return out;
}

const TAU = Math.PI * 2;
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

describe("imageCount", () => {
  it("is n for cyclic C_n", () => {
    expect(imageCount(3, false)).toBe(3);
    expect(imageCount(12, false)).toBe(12);
  });
  it("is 2n for dihedral D_n", () => {
    expect(imageCount(3, true)).toBe(6);
    expect(imageCount(12, true)).toBe(24);
  });
});

describe("forEachImage", () => {
  it("emits n pure rotations for C_n with correct angles", () => {
    const imgs = collect(4, false);
    expect(imgs).toHaveLength(4);
    expect(imgs.every((i) => i.mirror === false)).toBe(true);
    imgs.forEach((img, i) => expect(near(img.angle, (i * TAU) / 4)).toBe(true));
  });

  it("emits 2n images for D_n: rotations then reflected rotations", () => {
    const imgs = collect(4, true);
    expect(imgs).toHaveLength(8);
    // first n are non-mirrored
    expect(imgs.slice(0, 4).every((i) => !i.mirror)).toBe(true);
    // last n are mirrored, same angle sequence
    expect(imgs.slice(4).every((i) => i.mirror)).toBe(true);
    imgs.slice(4).forEach((img, i) => expect(near(img.angle, (i * TAU) / 4)).toBe(true));
  });

  it("indices are unique and contiguous", () => {
    const imgs = collect(5, true);
    expect(imgs.map((i) => i.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("works for odd n (where the old i%2 construction broke)", () => {
    expect(collect(3, true)).toHaveLength(6);
    expect(collect(7, true)).toHaveLength(14);
  });
});

describe("transformPoint", () => {
  it("identity at angle 0, no mirror", () => {
    const p = transformPoint({ index: 0, angle: 0, mirror: false }, 1, 0);
    expect(near(p.x, 1)).toBe(true);
    expect(near(p.y, 0)).toBe(true);
  });

  it("rotates (1,0) by 90° to (0,1)", () => {
    const p = transformPoint({ index: 0, angle: Math.PI / 2, mirror: false }, 1, 0);
    expect(near(p.x, 0)).toBe(true);
    expect(near(p.y, 1)).toBe(true);
  });

  it("mirror reflects y before rotation", () => {
    // angle 0, mirror: (x,y) -> (x,-y)
    const p = transformPoint({ index: 0, angle: 0, mirror: true }, 2, 3);
    expect(near(p.x, 2)).toBe(true);
    expect(near(p.y, -3)).toBe(true);
  });

  it("preserves distance from origin (isometry)", () => {
    const imgs = collect(6, true);
    const [x, y] = [0.3, -0.7];
    const r0 = Math.hypot(x, y);
    for (const img of imgs) {
      const p = transformPoint(img, x, y);
      expect(near(Math.hypot(p.x, p.y), r0, 1e-9)).toBe(true);
    }
  });

  it("the n images of D_n are all distinct for a generic point", () => {
    const imgs = collect(8, true);
    const pts = imgs.map((i) => transformPoint(i, 0.37, 0.11));
    for (let a = 0; a < pts.length; a++) {
      for (let b = a + 1; b < pts.length; b++) {
        const same = near(pts[a].x, pts[b].x, 1e-6) && near(pts[a].y, pts[b].y, 1e-6);
        expect(same).toBe(false);
      }
    }
  });
});

describe("clampSegments", () => {
  it("clamps into [3,24] and rounds", () => {
    expect(clampSegments(1)).toBe(3);
    expect(clampSegments(99)).toBe(24);
    expect(clampSegments(12.4)).toBe(12);
    expect(clampSegments(NaN)).toBe(3);
  });
});

describe("imageTransformSvg", () => {
  it("emits rotate for non-mirrored", () => {
    expect(imageTransformSvg({ index: 0, angle: Math.PI, mirror: false })).toBe("rotate(180)");
  });
  it("appends scale for mirrored", () => {
    expect(imageTransformSvg({ index: 0, angle: 0, mirror: true })).toBe("rotate(0) scale(1,-1)");
  });
});
