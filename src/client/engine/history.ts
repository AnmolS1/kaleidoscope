// Undo/redo/clear over the vector stroke list. Because committed strokes are
// never mutated, each history entry is just a shallow copy of the stroke array —
// undo/redo swap whole snapshots (cheap: arrays of shared references). This
// replaces the old "reload the page to clear" hack entirely.

import type { Stroke } from "./strokes";

const MAX_DEPTH = 250;

export class History {
  private past: Stroke[][] = [];
  private current: Stroke[] = [];
  private future: Stroke[][] = [];

  get strokes(): readonly Stroke[] {
    return this.current;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  private pushPast(snapshot: Stroke[]): void {
    this.past.push(snapshot);
    if (this.past.length > MAX_DEPTH) this.past.shift();
  }

  /** Add a finished stroke as a new committed state. */
  commit(stroke: Stroke): void {
    this.pushPast(this.current);
    this.current = [...this.current, stroke];
    this.future = [];
  }

  /** Clear the canvas (undoable). No-op if already empty. */
  clear(): boolean {
    if (this.current.length === 0) return false;
    this.pushPast(this.current);
    this.current = [];
    this.future = [];
    return true;
  }

  undo(): boolean {
    const prev = this.past.pop();
    if (prev === undefined) return false;
    this.future.push(this.current);
    this.current = prev;
    return true;
  }

  redo(): boolean {
    const next = this.future.pop();
    if (next === undefined) return false;
    this.pushPast(this.current);
    this.current = next;
    return true;
  }

  /** Replace the whole list and drop history — used when loading or remixing. */
  reset(strokes: Stroke[]): void {
    this.past = [];
    this.future = [];
    this.current = [...strokes];
  }
}
