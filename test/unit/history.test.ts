import { describe, it, expect } from "vitest";
import { History } from "../../src/client/engine/history";
import type { Stroke } from "../../src/client/engine/strokes";

const mk = (color: string): Stroke => ({
  tool: "solid",
  color,
  size: 4,
  opacity: 1,
  pts: [[0, 0, 1]],
});

describe("History", () => {
  it("starts empty, nothing to undo/redo", () => {
    const h = new History();
    expect(h.strokes).toHaveLength(0);
    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(false);
    expect(h.undo()).toBe(false);
    expect(h.redo()).toBe(false);
  });

  it("commit then undo then redo", () => {
    const h = new History();
    h.commit(mk("#111111"));
    h.commit(mk("#222222"));
    expect(h.strokes).toHaveLength(2);

    expect(h.undo()).toBe(true);
    expect(h.strokes).toHaveLength(1);
    expect(h.strokes[0].color).toBe("#111111");

    expect(h.redo()).toBe(true);
    expect(h.strokes).toHaveLength(2);
    expect(h.strokes[1].color).toBe("#222222");
  });

  it("committing after undo clears the redo branch", () => {
    const h = new History();
    h.commit(mk("#111111"));
    h.commit(mk("#222222"));
    h.undo();
    h.commit(mk("#333333"));
    expect(h.canRedo).toBe(false);
    expect(h.strokes.map((s) => s.color)).toEqual(["#111111", "#333333"]);
  });

  it("clear is undoable", () => {
    const h = new History();
    h.commit(mk("#111111"));
    expect(h.clear()).toBe(true);
    expect(h.strokes).toHaveLength(0);
    expect(h.undo()).toBe(true);
    expect(h.strokes).toHaveLength(1);
  });

  it("clear on empty is a no-op", () => {
    const h = new History();
    expect(h.clear()).toBe(false);
    expect(h.canUndo).toBe(false);
  });

  it("reset replaces strokes and drops history", () => {
    const h = new History();
    h.commit(mk("#111111"));
    h.reset([mk("#aaaaaa"), mk("#bbbbbb")]);
    expect(h.strokes).toHaveLength(2);
    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(false);
  });
});
