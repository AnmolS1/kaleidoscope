import { useEffect, useRef } from "preact/hooks";
import { effect } from "@preact/signals";
import { Scene } from "../engine/scene";
import * as S from "../state";
import { showToast } from "./Toast";
import { EyeOffIcon } from "./Icons";

// Mounts the framework-free Scene engine into a host div and keeps it in sync
// with the tool signals. The engine owns the canvases and the render loop; this
// component is just the bridge.
export function Canvas() {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!host.current) return;
    const scene = new Scene(
      host.current,
      {
        tool: S.tool.value,
        color: S.color.value,
        size: S.size.value,
        opacity: S.opacity.value,
        segments: S.segments.value,
        mirror: S.mirror.value,
        bg: S.bg.value,
        showGuides: S.showGuides.value,
      },
      {
        onHistoryChange: (canUndo, canRedo, count) => {
          S.canUndo.value = canUndo;
          S.canRedo.value = canRedo;
          S.strokeCount.value = count;
          // Read from the scene rather than adding a fourth callback argument:
          // hiding a layer changes this WITHOUT changing the stroke count, so
          // the two are not derivable from one another.
          S.visibleStrokeCount.value = scene.visibleStrokeCount;
        },
        // The engine is the source of truth for the layer stack. Mirroring it
        // into signals here — including writing the ACTIVE layer's symmetry back
        // into the shared segments/mirror signals — is what makes the main rail
        // a view onto the active layer rather than a global setting. The write
        // back is safe because setSegments/setMirror are no-ops when the value
        // already matches, so this cannot loop.
        // The engine owns the view; these are read-only mirrors for the zoom
        // badge (T06b). Writing back from here would fight the gesture handlers.
        onPenSeen: () => {
          S.penSeen.value = true;
        },
        // The engine drops a stroke drawn onto a hidden layer. Without this the
        // refusal is completely silent — the user draws and simply nothing
        // happens, which is the failure mode refusing was meant to avoid.
        onHiddenLayerRefusal: (layerId, layerName) => {
          showToast({
            icon: <EyeOffIcon />,
            // Typographic quotes, matching the Nudges artboard. DESIGN.md's prose
            // line uses straight ones, but it states that the frames are the spec
            // for copy, and this string is user-visible.
            text: `“${layerName}” is hidden, so nothing was drawn.`,
            cta: {
              label: "Show layer",
              onClick: () => S.scene.value?.setLayerVisible(layerId, true),
            },
          });
        },
        // T07: a hovering Apple Pencil. The engine is the only thing that sees
        // `pointerType`/`pressure`, so — like onPenSeen — this has to be
        // announced rather than derived.
        onHoverChange: (p) => {
          S.hoverPoint.value = p;
        },
        onViewChange: (view) => {
          S.viewScale.value = view.scale;
          S.viewIsDefault.value = view.scale === 1 && view.tx === 0 && view.ty === 0;
        },
        onLayersChange: (layers, activeLayerId) => {
          S.layers.value = layers;
          S.activeLayerId.value = activeLayerId;
          // Also here, not only on history change: toggling a layer's eye is
          // deliberately NOT an undo step, so it never reaches
          // onHistoryChange — yet it is exactly what changes how much of the
          // drawing is visible.
          S.visibleStrokeCount.value = scene.visibleStrokeCount;
          const active = layers.find((l) => l.id === activeLayerId);
          if (active) {
            S.segments.value = active.sym.segments;
            S.mirror.value = active.sym.mirror;
          }
        },
      },
      { layerCap: S.layerCap.value, drawWithFinger: S.drawWithFinger.value },
    );
    S.scene.value = scene;

    // Push every subsequent signal change into the imperative engine.
    const disposers = [
      effect(() => scene.setTool(S.tool.value)),
      effect(() => scene.setColor(S.color.value)),
      effect(() => scene.setSize(S.size.value)),
      effect(() => scene.setOpacity(S.opacity.value)),
      // Input preferences. These are capture-time only — they shape the next
      // stroke, never one already drawn — so pushing them in on change is
      // enough; nothing needs re-rendering. (T04: state.ts persists them and
      // T06c builds the popover that writes them; this is the missing bridge,
      // which no task's ownership list claimed.)
      effect(() => scene.setPressurePreset(S.pressurePreset.value)),
      effect(() => scene.setPressureOpacity(S.pressureOpacity.value)),
      effect(() => scene.setSmoothStrokes(S.smoothStrokes.value)),
      // Whether a bare finger draws or pans. Same shape as the two above: the
      // signal is persisted by state.ts, the popover that writes it is T06b's,
      // and this is the bridge that makes it reach the input path.
      effect(() => scene.setDrawWithFinger(S.drawWithFinger.value)),
      // `.peek()` on the drag flag, so a gesture starting or ending does not by
      // itself re-push the value — only an actual change of segments does.
      effect(() => scene.setSegments(S.segments.value, S.symDragging.peek())),
      effect(() => scene.setMirror(S.mirror.value)),
      effect(() => scene.setBackground(S.bg.value)),
      effect(() => scene.setShowGuides(S.showGuides.value)),
      // /api/me resolves after mount, so the cap arrives late.
      effect(() => scene.setLayerCap(S.layerCap.value)),
    ];

    // If we arrived here via "Remix", load that drawing and sync the toolbar.
    // The engine picks the top-most visible layer as active and reports its
    // symmetry back through onLayersChange, so nothing is read off the drawing
    // here — a v2 piece has no single symmetry to read.
    const remix = S.pendingRemix.value;
    if (remix) {
      S.bg.value = remix.bg;
      scene.loadDrawing(remix);
      S.pendingRemix.value = null;
    } else {
      // Fresh studio session — don't carry a stale remix parent.
      S.remixOf.value = null;
      S.remixSourceHash.value = null;
      S.remixSourceMeta.value = null;
    }

    return () => {
      disposers.forEach((d) => d());
      scene.destroy();
      S.scene.value = null;
      // The view mirrors have to go back to the default with the engine that
      // owned them. A fresh Scene starts at the identity view and never fires
      // onViewChange for it (setViewInternal is a no-op when nothing changed),
      // so leaving these behind means navigating away at 4x and back shows a
      // badge reading 400% over a canvas that is at 1x.
      S.viewScale.value = 1;
      S.viewIsDefault.value = true;
      // A ring belongs to the engine that reported it. Left behind, it would be
      // drawn over the next Scene at a position that engine never saw.
      S.hoverPoint.value = null;
    };
  }, []);

  // Reading these signals in the render body subscribes the component, so the
  // label re-computes whenever symmetry, the layer stack or the stroke count
  // changes. A multi-layer piece has no single symmetry, so it is described as
  // layered rather than by the active layer's fold — the same wording the
  // gallery uses when `segments` is 0.
  const n = S.strokeCount.value;
  const stack = S.layers.value;
  const visible = stack.filter((l) => l.visible);
  const mixed =
    visible.length > 1 &&
    visible.some(
      (l) => l.sym.segments !== visible[0].sym.segments || l.sym.mirror !== visible[0].sym.mirror,
    );
  const symLabel = mixed
    ? `layered, ${visible.length} layers`
    : `${S.segments.value}-fold ${S.mirror.value ? "mirror" : "rotational"} symmetry`;
  const label = `Drawing canvas: ${symLabel}, ${n} ${n === 1 ? "stroke" : "strokes"}`;

  // T07 hover ring (DESIGN.md §3). The engine holds the authoritative size,
  // symmetry and view — `hoverRings` reads all three — so these reads exist to
  // SUBSCRIBE this component to them: without them a pen parked over the canvas
  // while `[`/`]` changes the brush, or `,`/`.` the fold count, would keep
  // showing the ring the previous value drew.
  void S.size.value;
  void S.viewScale.value;
  const rings = S.scene.value?.hoverRings(S.hoverPoint.value) ?? [];

  return (
    <div ref={host} class="canvas-host" aria-label={label} role="img">
      {/* Always rendered, never conditional: the Scene appends its three
          canvases to this same host imperatively, and a child that comes and
          goes would be re-inserted relative to them. An empty <svg> costs
          nothing and keeps Preact's one child in one place. Inline styles
          rather than a rule in studio.css, which three other agents are in.
          `stroke` is inherited by the circles. */}
      <svg
        class="hover-ring"
        aria-hidden="true"
        data-rings={rings.length}
        style="position:absolute;inset:0;width:100%;height:100%;z-index:3;pointer-events:none;stroke:var(--color-crane);fill:none"
      >
        {rings.map((r, i) => (
          <circle
            key={i}
            cx={r.x}
            cy={r.y}
            r={r.r}
            stroke-width="1"
            // The image under the pen is opaque; its reflections are at 55%.
            opacity={r.primary ? 1 : 0.55}
            data-primary={r.primary ? "1" : "0"}
          />
        ))}
      </svg>
    </div>
  );
}
