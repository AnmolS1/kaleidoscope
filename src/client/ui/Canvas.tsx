import { useEffect, useRef } from "preact/hooks";
import { effect } from "@preact/signals";
import { Scene } from "../engine/scene";
import * as S from "../state";

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
        },
      },
    );
    S.scene.value = scene;

    // Push every subsequent signal change into the imperative engine.
    const disposers = [
      effect(() => scene.setTool(S.tool.value)),
      effect(() => scene.setColor(S.color.value)),
      effect(() => scene.setSize(S.size.value)),
      effect(() => scene.setOpacity(S.opacity.value)),
      effect(() => scene.setSegments(S.segments.value)),
      effect(() => scene.setMirror(S.mirror.value)),
      effect(() => scene.setBackground(S.bg.value)),
      effect(() => scene.setShowGuides(S.showGuides.value)),
    ];

    return () => {
      disposers.forEach((d) => d());
      scene.destroy();
      S.scene.value = null;
    };
  }, []);

  return <div ref={host} class="canvas-host" aria-label="Drawing canvas" role="img" />;
}
