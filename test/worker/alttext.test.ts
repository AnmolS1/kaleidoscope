// Pure-helper tests for accessibility alt text. Lives under test/worker (not
// test/unit) so it shares the tsconfig.worker.json project with the module it
// imports — test/unit belongs to the app project, which doesn't include src/worker.

import { describe, it, expect } from "vitest";
import { nearestName, templateAlt } from "../../src/worker/lib/alttext";

describe("nearestName", () => {
  it("maps exact palette hexes to their names", () => {
    expect(nearestName("#E84A27")).toBe("crane orange");
    expect(nearestName("#2E5E8C")).toBe("teal");
    expect(nearestName("#D9A521")).toBe("sax gold");
    expect(nearestName("#1B2A33")).toBe("graphite");
    expect(nearestName("#3FA34D")).toBe("green");
    expect(nearestName("#8E44AD")).toBe("purple");
    expect(nearestName("#EAEAEA")).toBe("light gray");
  });

  it("snaps a near color to the closest anchor", () => {
    expect(nearestName("#e94b28")).toBe("crane orange"); // ~crane orange
    expect(nearestName("#000000")).toBe("graphite"); // darkest anchor
    expect(nearestName("#ffffff")).toBe("light gray"); // lightest anchor
  });

  it("passes spectrum through and treats junk as spectrum", () => {
    expect(nearestName("spectrum")).toBe("spectrum");
    expect(nearestName("not-a-hex")).toBe("spectrum");
    expect(nearestName("#fff")).toBe("spectrum"); // wrong length
  });

  it("is case-insensitive on hex", () => {
    expect(nearestName("#e84a27")).toBe("crane orange");
  });
});

describe("templateAlt", () => {
  it("renders the canonical shape from a JSON-string palette", () => {
    expect(
      templateAlt({ segments: 12, mirror: 1, palette: JSON.stringify(["#E84A27", "#2E5E8C", "#1B2A33"]) }),
    ).toBe("12-fold mirrored mandala in crane orange, teal and graphite");
  });

  it("accepts an array palette and uses rotational for falsy mirror", () => {
    expect(templateAlt({ segments: 6, mirror: 0, palette: ["#3FA34D", "#8E44AD"] })).toBe(
      "6-fold rotational mandala in green and purple",
    );
  });

  it("treats mirror as boolean truthy/falsy too", () => {
    expect(templateAlt({ segments: 8, mirror: true, palette: null })).toBe("8-fold mirrored mandala");
    expect(templateAlt({ segments: 8, mirror: false, palette: null })).toBe("8-fold rotational mandala");
  });

  it("dedupes color names and caps at 3", () => {
    // two near-orange hexes collapse to one name; capped at 3 distinct names
    expect(
      templateAlt({
        segments: 4,
        mirror: 0,
        palette: ["#E84A27", "#e94b28", "#2E5E8C", "#D9A521", "#3FA34D"],
      }),
    ).toBe("4-fold rotational mandala in crane orange, teal and sax gold");
  });

  it("handles a null palette (single color word omitted)", () => {
    expect(templateAlt({ segments: 3, mirror: 1, palette: null })).toBe("3-fold mirrored mandala");
  });

  it("degrades gracefully with no/invalid segments and stays non-empty", () => {
    const alt = templateAlt({ segments: NaN, mirror: 0, palette: null });
    expect(alt).toBe("rotational mandala");
    expect(alt.length).toBeGreaterThan(0);
  });

  it("ignores non-JSON string palettes without throwing", () => {
    expect(templateAlt({ segments: 5, mirror: 1, palette: "#E84A27" })).toBe("5-fold mirrored mandala");
  });
});
