import { useState } from "preact/hooks";
import { signal } from "@preact/signals";
import * as S from "../state";
import {
  exportPNG,
  exportSVG,
  exportReplayWebM,
  canRecordReplay,
  downloadBlob,
} from "../engine/export";
import {
  UndoIcon,
  RedoIcon,
  DownloadIcon,
  SaveIcon,
  MirrorIcon,
  GuidesIcon,
  GlowIcon,
  BrushIcon,
  HelpIcon,
  GalleryIcon,
  MoreIcon,
  SymmetryIcon,
  ZoomIcon,
  HandIcon,
  TuneIcon,
  LayersIcon,
  RemoveStrokeIcon,
} from "./Icons";
import { AuthButton, AuthMenuItems } from "./AuthButton";
import { Link } from "./Link";
import { PonderanceBacklink } from "./PonderanceBacklink";
import { stripShortcuts } from "./HelpOverlay";
import { showToast } from "./Toast";
import { LayersPanel, layersOpen } from "./LayersPanel";
import { RemoveStrokeOverlay, clearRemoveHighlight, removeMode } from "./RemoveStroke";

const STAMP = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");

async function withScene<T>(fn: (d: ReturnType<NonNullable<typeof S.scene.value>["getDrawing"]>) => Promise<T> | T) {
  const scene = S.scene.value;
  if (!scene) return;
  return fn(scene.getDrawing());
}

/** Gamma per preset — mirrors `applyPressureGamma` in the engine, for the preview only. */
const PRESET_GAMMA = { light: 0.6, normal: 1, firm: 1.6 } as const;

/**
 * Which popover is open, or null. One at a time, and owned here rather than by
 * the `<details>` elements themselves.
 *
 * Native `<details>` toggling was not enough for two reasons that only showed up
 * once the chrome floated over the canvas: on a phone the bottom sheet COVERS
 * the strip chip that opened it, so there was no way to close it; and with
 * nothing tracking "a popover is open" there is nowhere to hang the scrim that
 * stops a dismissing tap from also landing a stroke on the canvas underneath.
 *
 * Exported so App can drive it — the `D` shortcut and the Pencil toast's
 * [Open Brush] chip both open a popover from outside the toolbar.
 */
export const openPopover = signal<string | null>(null);

function setOpen(id: string, open: boolean): void {
  if (open) openPopover.value = id;
  else if (openPopover.peek() === id) openPopover.value = null;
}

/** Props that make a `<details>` a member of the one-at-a-time popover set. */
function popProps(id: string) {
  return {
    open: openPopover.value === id,
    onToggle: (e: Event) => setOpen(id, (e.currentTarget as HTMLDetailsElement).open),
  };
}

export function Toolbar() {
  const [busy, setBusy] = useState<string | null>(null);

  const onPNG = (scale: 1 | 2 | 4) =>
    withScene(async (d) => {
      setBusy(`png${scale}`);
      try {
        downloadBlob(await exportPNG(d, scale), `kaleidoscope-${STAMP()}@${scale}x.png`, "image/png");
      } finally {
        setBusy(null);
      }
    });

  const onSVG = () =>
    withScene((d) => downloadBlob(exportSVG(d), `kaleidoscope-${STAMP()}.svg`));

  const onReplay = () =>
    withScene(async (d) => {
      setBusy("replay");
      try {
        const blob = await exportReplayWebM(d);
        downloadBlob(blob, `kaleidoscope-${STAMP()}.webm`, "video/webm");
      } catch {
        alert("Animated replay isn't supported in this browser.");
      } finally {
        setBusy(null);
      }
    });

  const bp = S.breakpoint.value;
  const phone = bp === "phone";

  // ---- derived readouts (DESIGN.md §2, "Readout") ----------------------------
  // `L2 · 12 · D · 6 PX · 100%` = active layer · segments · C/D · brush px · zoom.
  const stack = S.layers.value;
  const activeIndex = Math.max(0, stack.findIndex((l) => l.id === S.activeLayerId.value)) + 1;
  const activeLayer = stack.find((l) => l.id === S.activeLayerId.value);
  const symShort = `${S.segments.value} · ${S.mirror.value ? "D" : "C"}`;
  const zoomPct = Math.round(S.viewScale.value * 100);
  const opacityPct = Math.round(S.opacity.value * 100);
  // Remove-stroke REPLACES the brush tail rather than appending to it — the
  // `IPadRemoveStroke` frame reads `L2 · 6 · C · REMOVE STROKE`, and a brush
  // size shown while no brush is armed would be a readout that lies.
  const removing = removeMode.value;
  const readoutTail = removing ? "REMOVE STROKE" : `${S.size.value} PX · ${zoomPct}%`;
  const readout = `L${activeIndex} · ${symShort} · ${readoutTail}`;
  const readoutShort = `L${activeIndex} · ${symShort}${removing ? " · REMOVE STROKE" : ""}`;

  // ---- shared control fragments ---------------------------------------------

  const swatchButtons = (
    <>
      {S.PALETTE.map((c) => (
        <button
          key={c.value}
          class={"swatch" + (S.color.value === c.value ? " is-active" : "")}
          style={{ background: c.value }}
          aria-label={c.name}
          aria-pressed={S.color.value === c.value}
          onClick={() => (S.color.value = c.value)}
        />
      ))}
      <button
        class={"swatch swatch-spectrum" + (S.color.value === "spectrum" ? " is-active" : "")}
        aria-label="Spectrum (rainbow by angle)"
        aria-pressed={S.color.value === "spectrum"}
        onClick={() => (S.color.value = "spectrum")}
      />
      <label class="swatch swatch-picker" aria-label="Custom color">
        <input
          type="color"
          aria-label="Custom color"
          value={S.color.value.startsWith("#") ? S.color.value : "#1B2A33"}
          onInput={(e) => (S.color.value = (e.target as HTMLInputElement).value.toUpperCase())}
        />
      </label>
    </>
  );

  // The trio, and the reason its active states are not just `S.tool`:
  // remove-stroke is a MODE that sits on top of the brush rather than a third
  // member of the tool signal (see the header of LayersPanel.tsx — widening
  // `BrushTool` would write "remove" into the saved wire format). So while it
  // is armed neither brush is active, and leaving it restores whichever brush
  // was already selected for free.
  const brushActive = (t: "solid" | "glow") => S.tool.value === t && !removing;
  const pickBrush = (t: "solid" | "glow") => {
    removeMode.value = false;
    S.tool.value = t;
  };

  const toolTrio = (
    <>
      <button
        class={"icon-btn" + (brushActive("solid") ? " is-active" : "")}
        aria-label="Solid brush"
        aria-pressed={brushActive("solid")}
        onClick={() => pickBrush("solid")}
      >
        <BrushIcon />
      </button>
      <button
        class={"icon-btn" + (brushActive("glow") ? " is-active" : "")}
        aria-label="Glow brush"
        aria-pressed={brushActive("glow")}
        onClick={() => pickBrush("glow")}
      >
        <GlowIcon />
      </button>
      <button
        class={"icon-btn" + (removing ? " is-active" : "")}
        aria-label="Remove stroke"
        aria-pressed={removing}
        onClick={() => {
          // Disarming has to take the pending highlight with it, or the halo
          // outlives the tool that can act on it.
          if (removing) clearRemoveHighlight();
          removeMode.value = !removing;
        }}
      >
        <RemoveStrokeIcon />
      </button>
    </>
  );

  // The layers button carries a crease count badge, per the rail anatomy. The
  // count is in the aria-label too — the badge is `aria-hidden`, so a screen
  // reader would otherwise hear only "Layers".
  const layerCount = stack.length;
  const layersButton = (
    <button
      class={"icon-btn layer-btn" + (layersOpen.value ? " is-active" : "")}
      aria-label={`Layers, ${layerCount} of ${S.layerCap.value}`}
      aria-pressed={layersOpen.value}
      onClick={() => (layersOpen.value = !layersOpen.value)}
    >
      <LayersIcon />
      <span class="layer-count-badge" aria-hidden="true">
        {layerCount}
      </span>
    </button>
  );

  /** The live scribble under the pressure segmented control (decorative). */
  const pressurePreview = (
    <svg class="pressure-preview" width="100%" height="26" viewBox="0 0 232 26" aria-hidden="true">
      {[0.25, 0.55, 0.85].map((p, i) => {
        const w = 1 + 7 * Math.pow(p, PRESET_GAMMA[S.pressurePreset.value]);
        return (
          <path
            key={i}
            d={`M ${8 + i * 76} 20 C ${28 + i * 76} 2, ${44 + i * 76} 24, ${68 + i * 76} 6`}
            fill="none"
            stroke="currentColor"
            stroke-width={w}
            stroke-linecap="round"
          />
        );
      })}
    </svg>
  );

  const toggleRow = (
    label: string,
    hint: string,
    on: boolean,
    set: (v: boolean) => void,
  ) => (
    <button
      class="toggle-row"
      role="switch"
      aria-checked={on}
      onClick={() => set(!on)}
    >
      <span class="toggle-label">
        {label}
        {hint ? <span class="mono toggle-hint">{hint}</span> : null}
      </span>
      <span class={"toggle-track" + (on ? " is-on" : "")} aria-hidden="true">
        <span class="toggle-knob" />
      </span>
    </button>
  );

  // The brush popover (DESIGN.md §3). The pressure block is hidden until a pen
  // has been seen: a preset that shapes nothing — the gamma is pen-only — is a
  // control that lies about what it does.
  const brushBody = (
    <>
      <div class="pop-head">
        <span class="pop-title">Brush</span>
        <span class="mono">{S.penSeen.value ? "Pen" : "Mouse"}</span>
      </div>
      <div class="pop-row">{toolTrio}</div>

      {S.penSeen.value ? (
        <>
          <hr class="hair" />
          <div class="pop-field">
            <div class="mono">Pressure affects</div>
            <div class="pop-row" role="group" aria-label="Pressure affects">
              <button class="chip is-on" disabled aria-pressed={true} title="Pressure always affects width">
                Size
              </button>
              <button
                class={"chip" + (S.pressureOpacity.value ? " is-on" : "")}
                aria-pressed={S.pressureOpacity.value}
                onClick={() => (S.pressureOpacity.value = !S.pressureOpacity.value)}
              >
                Opacity
              </button>
            </div>
          </div>
          <div class="pop-field">
            <div class="mono">Pressure · applies to new strokes</div>
            <div class="segmented" role="group" aria-label="Pressure preset">
              {(["light", "normal", "firm"] as const).map((p) => (
                <button
                  key={p}
                  class={"seg" + (S.pressurePreset.value === p ? " is-on" : "")}
                  aria-pressed={S.pressurePreset.value === p}
                  onClick={() => (S.pressurePreset.value = p)}
                >
                  {p[0].toUpperCase() + p.slice(1)}
                </button>
              ))}
            </div>
            {pressurePreview}
          </div>
        </>
      ) : null}

      <hr class="hair" />
      {toggleRow(
        "Draw with finger",
        S.drawWithFinger.value ? "" : "off · fingers pan",
        S.drawWithFinger.value,
        (v) => {
          S.drawWithFinger.value = v;
          if (!v) {
            showToast({
              icon: <HandIcon />,
              text: "Finger touches now pan and zoom. Change in Brush ▸ Draw with finger.",
            });
          }
        },
      )}
      {toggleRow("Smooth strokes", "", S.smoothStrokes.value, (v) => (S.smoothStrokes.value = v))}
    </>
  );

  // `id` so the "Apple Pencil detected" toast's [Open Brush] chip can open it.
  // The phone sheet carries the same id — only one of the two ever renders.
  const brushPopover = (
    <details class="menu pop" id="brush-sheet" {...popProps("brush")}>
      <summary class="icon-btn" aria-label="Brush settings">
        <TuneIcon />
      </summary>
      <div class="pop-panel menu-panel pop-brush">{brushBody}</div>
    </details>
  );

  const symmetryPanel = (
    <div class="pop-panel menu-panel pop-sym">
      <div class="pop-head">
        <span class="pop-title">Symmetry</span>
        <span class="chip chip-sm">{activeLayer?.name || `Layer ${activeIndex}`}</span>
      </div>
      {/* T06d INSERTION POINT — SymmetryDial replaces this slider. The range
          input below is what the dial's visually-hidden control becomes, so the
          `aria-label="Symmetry segments"` contract carries over unchanged. */}
      <label class="slider" title="Symmetry segments">
        <span class="slider-label">Segments {S.segments.value}</span>
        <input
          type="range"
          min="3"
          max="24"
          step="1"
          value={S.segments.value}
          onInput={(e) => (S.segments.value = +(e.target as HTMLInputElement).value)}
          aria-label="Symmetry segments"
          aria-valuetext={`${S.segments.value} segments`}
        />
      </label>
      <div class="pop-row">
        <button
          class={"icon-btn" + (S.mirror.value ? " is-active" : "")}
          aria-label="Mirror (dihedral symmetry)"
          aria-pressed={S.mirror.value}
          onClick={() => (S.mirror.value = !S.mirror.value)}
        >
          <MirrorIcon />
        </button>
        <button
          class={"icon-btn" + (S.showGuides.value ? " is-active" : "")}
          aria-label="Toggle guide axes"
          aria-pressed={S.showGuides.value}
          onClick={() => (S.showGuides.value = !S.showGuides.value)}
        >
          <GuidesIcon />
        </button>
      </div>
      <div class="pop-foot">
        <span class="mono-lg">
          {S.segments.value} segments · {S.mirror.value ? "mirrored" : "rotational"}
        </span>
        <span class="pop-keys">
          <kbd>,</kbd>
          <kbd>.</kbd>
        </span>
      </div>
      <hr class="hair" />
      <button
        class="chip chip-wide"
        onClick={() =>
          S.scene.value?.setAllSym({ segments: S.segments.value, mirror: S.mirror.value })
        }
      >
        Apply to all layers
      </button>
    </div>
  );

  const symmetryPopover = (
    <details class="menu pop" {...popProps("sym")}>
      <summary class="icon-btn rail-sym" aria-label={`Symmetry settings, ${symShort}`}>
        <SymmetryIcon />
        <span class="rail-sub mono">{symShort}</span>
      </summary>
      {symmetryPanel}
    </details>
  );

  const downloadItems = (
    <>
      <button role="menuitem" onClick={() => onPNG(1)} disabled={busy !== null}>
        PNG · 1×
      </button>
      <button role="menuitem" onClick={() => onPNG(2)} disabled={busy !== null}>
        PNG · 2×
      </button>
      <button role="menuitem" onClick={() => onPNG(4)} disabled={busy !== null}>
        PNG · 4×
      </button>
      <button role="menuitem" onClick={onSVG}>
        SVG · vector
      </button>
      {canRecordReplay() && (
        <button role="menuitem" onClick={onReplay} disabled={busy !== null}>
          {busy === "replay" ? "Recording…" : "Replay · WebM"}
        </button>
      )}
    </>
  );

  const downloadMenu = (
    <details class="menu" id="download-menu" {...popProps("download")}>
      <summary class={"btn btn-ghost chrome" + (phone ? " btn-icon" : "")} aria-label="Download">
        <DownloadIcon /> <span class="btn-text">Download</span>
      </summary>
      <div class="menu-panel" role="menu">
        {downloadItems}
      </div>
    </details>
  );

  // The More menu carries everything that is not a tool: theme, guides, clear,
  // and the navigation the compact-height layout hides from the top bar.
  const moreMenu = (
    <details class="menu overflow-menu" {...popProps("more")}>
      <summary class="icon-btn" aria-label="More options">
        <MoreIcon />
      </summary>
      <div class="menu-panel" role="menu">
        <button role="menuitem" onClick={() => (S.bg.value = S.bg.value === "dark" ? "light" : "dark")}>
          {S.bg.value === "dark" ? "Light canvas" : "Dark canvas"}
        </button>
        <button role="menuitem" onClick={() => (S.showGuides.value = !S.showGuides.value)}>
          {S.showGuides.value ? "Hide guide axes" : "Show guide axes"}
        </button>
        <button
          role="menuitem"
          aria-label="Clear canvas"
          disabled={S.strokeCount.value === 0}
          onClick={() => S.scene.value?.clear()}
        >
          Clear canvas
        </button>
        <button role="menuitem" onClick={() => S.navigate("/gallery")}>
          Gallery
        </button>
        <button role="menuitem" onClick={() => (S.helpOpen.value = true)}>
          Help &amp; shortcuts
        </button>
        <AuthMenuItems />
        {phone ? <PonderanceBacklink /> : null}
      </div>
    </details>
  );

  const saveBtn = (
    <button class="btn btn-primary" aria-label="Save to gallery" onClick={() => (S.saveOpen.value = true)}>
      <SaveIcon /> <span class="btn-text">Save</span>
    </button>
  );

  const undoRedo = (
    <>
      <button class="icon-btn" aria-label="Undo" disabled={!S.canUndo.value} onClick={() => S.scene.value?.undo()}>
        <UndoIcon />
      </button>
      <button class="icon-btn" aria-label="Redo" disabled={!S.canRedo.value} onClick={() => S.scene.value?.redo()}>
        <RedoIcon />
      </button>
    </>
  );

  // The zoom badge is a reset button, not a label — tapping it restores the
  // identity view. It hides itself when the view is already default.
  // The badge is a reset button, not a label. DESIGN.md's frames all show it at
  // 100%, so it stays on screen at the identity view rather than hiding (T05's
  // note guessed the other way); `viewIsDefault` instead quiets it, and the
  // click is a harmless no-op there.
  const zoomBadge = (
    <button
      class={"zoom-badge chrome mono-lg" + (S.viewIsDefault.value ? " is-default" : "")}
      aria-label={`Reset view · ${zoomPct}%`}
      onClick={() => S.scene.value?.resetView()}
    >
      <ZoomIcon width="14" height="14" /> {zoomPct}%
    </button>
  );

  // ===== phone (≤640): top bar + scrolling strip + docked tools ==============
  if (phone) {
    return (
      <div class="studio-chrome is-phone">
        {openPopover.value !== null ? (
          <div class="pop-scrim" onClick={() => (openPopover.value = null)} />
        ) : null}
        <div class="top-bar">
          <div class="readout chrome mono-lg">{readoutShort}</div>
          <div class="top-actions">
            {downloadMenu}
            {saveBtn}
          </div>
        </div>

        <div class="strip" role="group" aria-label="Color and settings">
          {swatchButtons}
          <details class="menu pop chip-pop" {...popProps("sym")}>
            <summary class="chip" aria-label={`Symmetry settings, ${symShort}`}>
              <SymmetryIcon width="14" height="14" /> {symShort}
            </summary>
            {symmetryPanel}
          </details>
          <details class="menu pop chip-pop" id="brush-sheet" {...popProps("brush")}>
            <summary class="chip" aria-label={`Brush settings, ${S.size.value} px`}>
              {S.size.value} px
            </summary>
            <div class="pop-panel menu-panel pop-brush">
              <label class="slider" title="Brush size">
                <span class="slider-label">Size</span>
                <input
                  type="range"
                  min="1"
                  max="40"
                  step="1"
                  value={S.size.value}
                  onInput={(e) => (S.size.value = +(e.target as HTMLInputElement).value)}
                  aria-label="Brush size"
                  aria-valuetext={`size ${S.size.value}`}
                />
              </label>
              <label class="slider" title="Opacity">
                <span class="slider-label">Opacity</span>
                <input
                  type="range"
                  min="0.05"
                  max="1"
                  step="0.05"
                  value={S.opacity.value}
                  onInput={(e) => (S.opacity.value = +(e.target as HTMLInputElement).value)}
                  aria-label="Opacity"
                  aria-valuetext={`${opacityPct} percent`}
                />
              </label>
              <hr class="hair" />
              {brushBody}
            </div>
          </details>
          {/* The opacity chip is a second trigger for the same sheet rather than
              a second copy of it — two `<details>` holding the same sliders
              would give every control a duplicate. */}
          <button
            class="chip"
            aria-label={`Opacity settings, ${opacityPct}%`}
            onClick={() => setOpen("brush", openPopover.peek() !== "brush")}
          >
            {opacityPct}%
          </button>
          {/* The layers chip opens the same panel the dock button does — one
              panel, two triggers, exactly as the opacity chip re-triggers the
              brush sheet rather than duplicating its controls. */}
          <button
            class={"chip" + (layersOpen.value ? " is-on" : "")}
            aria-label={`Layers, ${layerCount} of ${S.layerCap.value}`}
            aria-pressed={layersOpen.value}
            onClick={() => (layersOpen.value = !layersOpen.value)}
          >
            <LayersIcon width="14" height="14" /> {layerCount}
          </button>
        </div>

        <div class="dock chrome" role="toolbar" aria-label="Drawing tools">
          {toolTrio}
          {layersButton}
          {undoRedo}
          {moreMenu}
        </div>

        <LayersPanel onOpenSym={() => setOpen("sym", true)} />
        <RemoveStrokeOverlay />
      </div>
    );
  }

  // ===== regular width (rail) — also compact height, restyled in CSS =========
  return (
    <div class="studio-chrome">
        {openPopover.value !== null ? (
          <div class="pop-scrim" onClick={() => (openPopover.value = null)} />
        ) : null}
      <div class="rail chrome" role="toolbar" aria-label="Drawing tools">
        <span class="tb-mark rail-mark" aria-hidden="true" />
        {toolTrio}
        <hr class="rail-hair" />
        <details class="menu pop rail-color" {...popProps("color")}>
          <summary class="icon-btn" aria-label="Color">
            <span
              class={"swatch swatch-current" + (S.color.value === "spectrum" ? " swatch-spectrum" : "")}
              style={S.color.value === "spectrum" ? undefined : { background: S.color.value }}
            />
          </summary>
          <div class="pop-panel menu-panel pop-swatches">{swatchButtons}</div>
        </details>
        {symmetryPopover}
        {brushPopover}
        {layersButton}
        <div class="rail-spacer" />
        {undoRedo}
        <hr class="rail-hair" />
        {moreMenu}
      </div>

      <div class="top-bar">
        <div class="readout chrome mono-lg">{readout}</div>
        <div class="top-actions">
          {downloadMenu}
          {saveBtn}
          <Link href="/gallery" class="icon-btn chrome" aria-label="Gallery">
            <GalleryIcon />
          </Link>
          <button
            class="icon-btn chrome"
            aria-label="Keyboard shortcuts &amp; help"
            onClick={() => (S.helpOpen.value = true)}
          >
            <HelpIcon />
          </button>
          <AuthButton />
          <PonderanceBacklink />
        </div>
      </div>

      {/* Edge sliders: the two values you change without looking. Inset from the
          right edge in CSS (≥ 20px; 24px, which also clears the iPad system
          swipe). Hidden at compact height, where the corner strip takes over. */}
      <div class="edge-sliders">
        <label class="vslider">
          <span class="mono">Size</span>
          <input
            type="range"
            class="vrange"
            min="1"
            max="40"
            step="1"
            value={S.size.value}
            style={{ "--fill": `${((S.size.value - 1) / 39) * 100}%` }}
            onInput={(e) => (S.size.value = +(e.target as HTMLInputElement).value)}
            aria-label="Brush size"
            aria-valuetext={`size ${S.size.value}`}
          />
          <span class="mono-lg">{S.size.value}</span>
        </label>
        <label class="vslider">
          <span class="mono">Opac</span>
          <input
            type="range"
            class="vrange"
            min="0.05"
            max="1"
            step="0.05"
            value={S.opacity.value}
            style={{ "--fill": `${((S.opacity.value - 0.05) / 0.95) * 100}%` }}
            onInput={(e) => (S.opacity.value = +(e.target as HTMLInputElement).value)}
            aria-label="Opacity"
            aria-valuetext={`${opacityPct} percent`}
          />
          <span class="mono-lg">{opacityPct}</span>
        </label>
      </div>

      {/* Compact height (phone landscape) only — see studio.css. */}
      <div class="corner-strip" role="group" aria-label="Color">
        {swatchButtons}
        <span class="readout chrome mono-lg">{`${symShort} · ${S.size.value} PX`}</span>
      </div>

      {zoomBadge}

      <LayersPanel onOpenSym={() => setOpen("sym", true)} />
      <RemoveStrokeOverlay />

      <div class="shortcut-strip chrome" aria-hidden="true">
        {stripShortcuts().map((s) => (
          <span class="shortcut-item" key={s.keys.join("")}>
            {s.keys.map((k) => (
              <kbd key={k}>{k}</kbd>
            ))}{" "}
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}
