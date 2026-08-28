// A canvas 2D context that records what was asked of it instead of rasterizing.
//
// Pixel snapshots are the obvious way to pin a renderer down, but they are
// platform-dependent (antialiasing differs between a macOS dev box and a Linux
// CI runner) and a missing baseline is auto-created, so the first CI run passes
// having compared nothing. An operation trace has neither problem: it is exact,
// it is identical on every platform, and a missing baseline is a missing file.
//
// It is also more diagnostic. A pixel diff says "these 400 pixels changed"; a
// trace diff says "globalCompositeOperation was 'source-over' here and is now
// 'lighter'", which names the bug.

type Num = number;

const ROUND = 1e6;

/** Round away float noise that differs in the last ULP between architectures. */
function r(n: Num): Num {
  if (!Number.isFinite(n)) return n;
  const v = Math.round(n * ROUND) / ROUND;
  // Normalize -0 to 0 so a trace never differs only by the sign of zero.
  return Object.is(v, -0) ? 0 : v;
}

function fmt(v: unknown): string {
  if (typeof v === "number") return String(r(v));
  if (typeof v === "string") return JSON.stringify(v);
  return String(v);
}

/** Canvas state properties whose assignment is part of the render contract. */
const TRACKED_PROPS = [
  "lineCap",
  "lineJoin",
  "lineWidth",
  "globalAlpha",
  "globalCompositeOperation",
  "strokeStyle",
  "fillStyle",
] as const;

/** Methods recorded with their arguments. */
const TRACKED_METHODS = [
  "save",
  "restore",
  "translate",
  "rotate",
  "scale",
  "setTransform",
  "transform",
  "beginPath",
  "closePath",
  "moveTo",
  "lineTo",
  "bezierCurveTo",
  "quadraticCurveTo",
  "arc",
  "stroke",
  "fill",
  "clearRect",
  "fillRect",
  "drawImage",
  "clip",
] as const;

export interface RecordingContext {
  /** The object to pass where a CanvasRenderingContext2D is expected. */
  ctx: CanvasRenderingContext2D;
  /** One entry per operation, in order. */
  trace: string[];
}

/**
 * Build a recording context. Property writes are recorded as `prop = value`
 * and method calls as `name(args)`, both in call order, so the trace is the
 * full sequence of instructions the renderer issued.
 */
export function recordingContext(): RecordingContext {
  const trace: string[] = [];
  const state: Record<string, unknown> = {};

  const target: Record<string, unknown> = {};

  for (const m of TRACKED_METHODS) {
    target[m] = (...args: unknown[]) => {
      trace.push(`${m}(${args.map(fmt).join(", ")})`);
    };
  }

  const ctx = new Proxy(target, {
    get(t, prop: string) {
      if (prop in t) return t[prop];
      if (prop in state) return state[prop];
      return undefined;
    },
    set(t, prop: string, value: unknown) {
      if ((TRACKED_PROPS as readonly string[]).includes(prop)) {
        trace.push(`${prop} = ${fmt(value)}`);
      }
      state[prop] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;

  return { ctx, trace };
}
