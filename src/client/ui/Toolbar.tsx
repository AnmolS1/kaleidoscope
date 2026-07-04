import { useState } from "preact/hooks";
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
  ClearIcon,
  DownloadIcon,
  SaveIcon,
  MirrorIcon,
  GuidesIcon,
  GlowIcon,
  BrushIcon,
  HelpIcon,
  SunIcon,
  MoonIcon,
  GalleryIcon,
  MoreIcon,
  ColorIcon,
  SymmetryIcon,
} from "./Icons";
import { AuthButton, AuthMenuItems } from "./AuthButton";
import { Link } from "./Link";
import { PonderanceBacklink } from "./PonderanceBacklink";

const STAMP = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");

async function withScene<T>(fn: (d: ReturnType<NonNullable<typeof S.scene.value>["getDrawing"]>) => Promise<T> | T) {
  const scene = S.scene.value;
  if (!scene) return;
  return fn(scene.getDrawing());
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

  // ----- desktop (≥1024): the original toolbar, kept verbatim for pixel parity -----
  if (bp === "desktop") {
    return (
      <header class="toolbar" role="toolbar" aria-label="Drawing tools">
        <div class="tb-brand" aria-hidden="true">
          <span class="tb-mark" /> Kaleidoscope
        </div>

        {/* colors */}
        <div class="tb-group" role="group" aria-label="Color">
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
              value={S.color.value.startsWith("#") ? S.color.value : "#1B2A33"}
              onInput={(e) => (S.color.value = (e.target as HTMLInputElement).value.toUpperCase())}
            />
          </label>
        </div>

        {/* brush */}
        <div class="tb-group" role="group" aria-label="Brush">
          <button
            class={"icon-btn" + (S.tool.value === "solid" ? " is-active" : "")}
            aria-label="Solid brush"
            aria-pressed={S.tool.value === "solid"}
            onClick={() => (S.tool.value = "solid")}
          >
            <BrushIcon />
          </button>
          <button
            class={"icon-btn" + (S.tool.value === "glow" ? " is-active" : "")}
            aria-label="Glow brush"
            aria-pressed={S.tool.value === "glow"}
            onClick={() => (S.tool.value = "glow")}
          >
            <GlowIcon />
          </button>
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
            />
          </label>
        </div>

        {/* symmetry */}
        <div class="tb-group" role="group" aria-label="Symmetry">
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
            />
          </label>
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

        {/* edit */}
        <div class="tb-group" role="group" aria-label="Edit">
          <button class="icon-btn" aria-label="Undo" disabled={!S.canUndo.value} onClick={() => S.scene.value?.undo()}>
            <UndoIcon />
          </button>
          <button class="icon-btn" aria-label="Redo" disabled={!S.canRedo.value} onClick={() => S.scene.value?.redo()}>
            <RedoIcon />
          </button>
          <button class="icon-btn" aria-label="Clear canvas" disabled={S.strokeCount.value === 0} onClick={() => S.scene.value?.clear()}>
            <ClearIcon />
          </button>
        </div>

        <div class="tb-spacer" />

        {/* theme */}
        <button
          class="icon-btn"
          aria-label={S.bg.value === "dark" ? "Switch to light canvas" : "Switch to dark canvas"}
          onClick={() => (S.bg.value = S.bg.value === "dark" ? "light" : "dark")}
        >
          {S.bg.value === "dark" ? <SunIcon /> : <MoonIcon />}
        </button>

        {/* download */}
        <details class="menu" id="download-menu">
          <summary class="btn btn-ghost" aria-label="Download">
            <DownloadIcon /> <span class="btn-text">Download</span>
          </summary>
          <div class="menu-panel" role="menu">
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
          </div>
        </details>

        {/* save */}
        <button class="btn btn-primary" aria-label="Save to gallery" onClick={() => (S.saveOpen.value = true)}>
          <SaveIcon /> <span class="btn-text">Save</span>
        </button>

        <Link href="/gallery" class="icon-btn" aria-label="Gallery">
          <GalleryIcon />
        </Link>

        <button class="icon-btn" aria-label="Keyboard shortcuts & help" onClick={() => (S.helpOpen.value = true)}>
          <HelpIcon />
        </button>

        <AuthButton />
        <PonderanceBacklink />
      </header>
    );
  }

  // ----- shared compact pieces (tablet + phone) -----
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
          value={S.color.value.startsWith("#") ? S.color.value : "#1B2A33"}
          onInput={(e) => (S.color.value = (e.target as HTMLInputElement).value.toUpperCase())}
        />
      </label>
    </>
  );

  const colorPopover = (
    <details class="menu pop">
      <summary class="icon-btn" aria-label="Color">
        <ColorIcon />
      </summary>
      <div class="menu-panel pop-panel pop-swatches" role="menu">
        {swatchButtons}
      </div>
    </details>
  );

  const brushPopover = (
    <details class="menu pop">
      <summary class="icon-btn" aria-label="Brush settings">
        <BrushIcon />
      </summary>
      <div class="menu-panel pop-panel" role="menu">
        <div class="pop-row">
          <button
            class={"icon-btn" + (S.tool.value === "solid" ? " is-active" : "")}
            aria-label="Solid brush"
            aria-pressed={S.tool.value === "solid"}
            onClick={() => (S.tool.value = "solid")}
          >
            <BrushIcon />
          </button>
          <button
            class={"icon-btn" + (S.tool.value === "glow" ? " is-active" : "")}
            aria-label="Glow brush"
            aria-pressed={S.tool.value === "glow"}
            onClick={() => (S.tool.value = "glow")}
          >
            <GlowIcon />
          </button>
        </div>
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
          />
        </label>
      </div>
    </details>
  );

  const symmetryPopover = (
    <details class="menu pop">
      <summary class="icon-btn" aria-label="Symmetry settings">
        <SymmetryIcon />
      </summary>
      <div class="menu-panel pop-panel" role="menu">
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
      </div>
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

  const themeItem = (
    <button role="menuitem" onClick={() => (S.bg.value = S.bg.value === "dark" ? "light" : "dark")}>
      {S.bg.value === "dark" ? "Light canvas" : "Dark canvas"}
    </button>
  );

  const saveBtn = (
    <button class="btn btn-primary" aria-label="Save to gallery" onClick={() => (S.saveOpen.value = true)}>
      <SaveIcon /> <span class="btn-text">Save</span>
    </button>
  );

  // ----- tablet (641–1023): one non-wrapping row, secondary actions folded into ⋯ -----
  if (bp === "tablet") {
    return (
      <header class="toolbar toolbar-compact" role="toolbar" aria-label="Drawing tools">
        <div class="tb-brand" aria-hidden="true">
          <span class="tb-mark" /> Kaleidoscope
        </div>
        <div class="tb-group" role="group" aria-label="Tools">
          {colorPopover}
          {brushPopover}
          {symmetryPopover}
        </div>
        <div class="tb-group" role="group" aria-label="Edit">
          <button class="icon-btn" aria-label="Undo" disabled={!S.canUndo.value} onClick={() => S.scene.value?.undo()}>
            <UndoIcon />
          </button>
          <button class="icon-btn" aria-label="Redo" disabled={!S.canRedo.value} onClick={() => S.scene.value?.redo()}>
            <RedoIcon />
          </button>
          <button class="icon-btn" aria-label="Clear canvas" disabled={S.strokeCount.value === 0} onClick={() => S.scene.value?.clear()}>
            <ClearIcon />
          </button>
        </div>

        <div class="tb-spacer" />

        <details class="menu" id="download-menu">
          <summary class="btn btn-ghost" aria-label="Download">
            <DownloadIcon /> <span class="btn-text">Download</span>
          </summary>
          <div class="menu-panel" role="menu">
            {downloadItems}
          </div>
        </details>
        {saveBtn}
        <details class="menu overflow-menu">
          <summary class="icon-btn" aria-label="More options">
            <MoreIcon />
          </summary>
          <div class="menu-panel" role="menu">
            {themeItem}
            <button role="menuitem" onClick={() => S.navigate("/gallery")}>
              Gallery
            </button>
            <button role="menuitem" onClick={() => (S.helpOpen.value = true)}>
              Help &amp; shortcuts
            </button>
            <AuthMenuItems />
          </div>
        </details>
        <PonderanceBacklink />
      </header>
    );
  }

  // ----- phone (≤640): slim top bar + docked bottom tool bar -----
  return (
    <>
      <header class="toolbar toolbar-phone-top" role="toolbar" aria-label="Drawing tools">
        <div class="dock-brand" aria-hidden="true">
          <span class="tb-mark" /> Kaleidoscope
        </div>
        <div class="tb-spacer" />
        {saveBtn}
        <details class="menu overflow-menu">
          <summary class="icon-btn" aria-label="More options">
            <MoreIcon />
          </summary>
          <div class="menu-panel" role="menu">
            {themeItem}
            {downloadItems}
            <button
              role="menuitem"
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
          </div>
        </details>
        <PonderanceBacklink />
      </header>

      <nav class="dock" aria-label="Drawing tools">
        {colorPopover}
        {brushPopover}
        {symmetryPopover}
        <button
          class={"icon-btn" + (S.mirror.value ? " is-active" : "")}
          aria-label="Mirror (dihedral symmetry)"
          aria-pressed={S.mirror.value}
          onClick={() => (S.mirror.value = !S.mirror.value)}
        >
          <MirrorIcon />
        </button>
        <button class="icon-btn" aria-label="Undo" disabled={!S.canUndo.value} onClick={() => S.scene.value?.undo()}>
          <UndoIcon />
        </button>
        <button class="icon-btn" aria-label="Redo" disabled={!S.canRedo.value} onClick={() => S.scene.value?.redo()}>
          <RedoIcon />
        </button>
      </nav>
    </>
  );
}
