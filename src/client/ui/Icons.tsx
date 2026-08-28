// Minimal stroke icon set. 24x24, currentColor, 1.8 stroke. Decorative — buttons
// supply their own aria-label.
import type { JSX } from "preact";

type P = JSX.SVGAttributes<SVGSVGElement>;

function Svg(props: P & { children: JSX.Element | JSX.Element[] }) {
  const { children, ...rest } = props;
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const UndoIcon = (p: P) => (
  <Svg {...p}>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h11a5 5 0 0 1 0 10h-3" />
  </Svg>
);
export const RedoIcon = (p: P) => (
  <Svg {...p}>
    <path d="m15 14 5-5-5-5" />
    <path d="M20 9H9a5 5 0 0 0 0 10h3" />
  </Svg>
);
export const ClearIcon = (p: P) => (
  <Svg {...p}>
    <path d="M3 6h18" />
    <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
    <path d="M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14" />
  </Svg>
);
export const DownloadIcon = (p: P) => (
  <Svg {...p}>
    <path d="M12 3v12" />
    <path d="m7 10 5 5 5-5" />
    <path d="M5 21h14" />
  </Svg>
);
export const SaveIcon = (p: P) => (
  <Svg {...p}>
    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" />
    <path d="M17 21v-8H7v8M7 3v5h8" />
  </Svg>
);
export const MirrorIcon = (p: P) => (
  <Svg {...p}>
    <path d="M12 3v18" stroke-dasharray="2 2" />
    <path d="M8 7 4 12l4 5z" />
    <path d="m16 7 4 5-4 5z" />
  </Svg>
);
export const GuidesIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4" />
  </Svg>
);
export const GlowIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" />
  </Svg>
);
export const BrushIcon = (p: P) => (
  <Svg {...p}>
    <path d="M9.5 14.5 3 21" />
    <path d="M14 4 20 10l-7 7-6-6z" />
  </Svg>
);
export const HelpIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.8.4-1 .9-1 1.7" />
    <path d="M12 17h.01" />
  </Svg>
);
export const SunIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19" />
  </Svg>
);
export const MoonIcon = (p: P) => (
  <Svg {...p}>
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
  </Svg>
);
export const GalleryIcon = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <rect x="14" y="14" width="7" height="7" rx="1" />
  </Svg>
);
export const MoreIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="5" cy="12" r="1.4" />
    <circle cx="12" cy="12" r="1.4" />
    <circle cx="19" cy="12" r="1.4" />
  </Svg>
);
export const SymmetryIcon = (p: P) => (
  <Svg {...p}>
    <path d="M12 2v20M4 7l16 10M20 7 4 17" />
  </Svg>
);
export const ColorIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="13.5" cy="6.5" r="2.5" />
    <circle cx="17.5" cy="12.5" r="2.5" />
    <circle cx="6.5" cy="8.5" r="2.5" />
    <path d="M12 22a10 10 0 1 1 0-20c4 0 6 2.5 6 5 0 2-1.8 3-3.4 3H13a2.4 2.4 0 0 0-1 4.6c.7.4 1 1 1 1.8A2 2 0 0 1 12 22Z" />
  </Svg>
);

// ── D01 chrome additions ─────────────────────────────────────────────────────
// The rail, the strip chips and the toasts need marks the old wrapped toolbar
// never had. Same 24×24 / currentColor contract as everything above.

/** Brush SETTINGS (sliders), distinct from the brush TOOL mark. */
export const TuneIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h9M17 18h3" />
    <circle cx="16" cy="6" r="2" />
    <circle cx="10" cy="12" r="2" />
    <circle cx="15" cy="18" r="2" />
  </Svg>
);
/** Zoom badge. A magnifier, not a percent sign — the number sits beside it. */
export const ZoomIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.6-3.6" />
  </Svg>
);
/** Layers. Also used by T06c's panel button and the phone strip's layers chip. */
export const LayersIcon = (p: P) => (
  <Svg {...p}>
    <path d="m12 3 9 5-9 5-9-5 9-5Z" />
    <path d="m3 13 9 5 9-5" />
  </Svg>
);
/** Remove-stroke (the `E` tool). Rendered by T06c; the mark lives here. */
export const RemoveStrokeIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 20c4-1 6-4 8-8s4-7 8-8" stroke-dasharray="3 3" />
    <path d="m15 15 6 6M21 15l-6 6" />
  </Svg>
);
export const EyeIcon = (p: P) => (
  <Svg {...p}>
    <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6Z" />
    <circle cx="12" cy="12" r="2.6" />
  </Svg>
);
export const EyeOffIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4.5 7.5C2.9 9.2 2 12 2 12s3.6 6 10 6c1.7 0 3.2-.4 4.5-1M9.9 6.2A9.9 9.9 0 0 1 12 6c6.4 0 10 6 10 6s-1 1.7-2.8 3.3" />
    <path d="m3 3 18 18" />
  </Svg>
);
/** Apple Pencil / stylus — the "pen detected" toast. */
export const PenIcon = (p: P) => (
  <Svg {...p}>
    <path d="m15 4 5 5L9 20H4v-5L15 4Z" />
    <path d="m13.5 5.5 5 5" />
  </Svg>
);
/** A hand — the "fingers now pan" toast. */
export const HandIcon = (p: P) => (
  <Svg {...p}>
    <path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V11" />
    <path d="M12 11V4.5a1.5 1.5 0 0 1 3 0V11" />
    <path d="M15 11V6.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-.5A6.5 6.5 0 0 1 4 14.5V12a1.5 1.5 0 0 1 3 0" />
    <path d="M6 11V9" />
  </Svg>
);
