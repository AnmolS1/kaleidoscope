import UIKit
import KaleidoEngine

/// Core Graphics renderer for kaleidoscope drawings — the native mirror of the
/// web `paintStrokes` (scene.ts) + `drawStroke` (brush.ts). It paints into any
/// CGContext (a live layer or an offscreen export bitmap). The renderer is purely
/// visual; the vector serializer (KaleidoEngine) is what must match byte-for-byte.
///
/// Contexts here are UIKit-flipped (y-down), matching the web canvas convention,
/// so the symmetry reflection is `scale(x: 1, y: -1)` exactly as on the web.
enum KaleidoRenderer {
    /// Paint all strokes of a drawing, centered, with full symmetry. Does NOT
    /// fill the background (callers do). `half` is the shorter half-axis in px.
    static func paint(_ strokes: [Stroke], sym: Symmetry, in ctx: CGContext,
                      size: CGSize, half: CGFloat) {
        let cx = size.width / 2
        let cy = size.height / 2
        let images = symmetryImages(segments: sym.segments, mirror: sym.mirror)
        // Stroke-outer, image-inner (matches scene.ts): each stroke is stamped
        // into every symmetry image in turn.
        for stroke in strokes {
            for image in images {
                ctx.saveGState()
                ctx.translateBy(x: cx, y: cy)
                ctx.rotate(by: CGFloat(image.angle))
                if image.mirror { ctx.scaleBy(x: 1, y: -1) }
                drawStroke(stroke, in: ctx, half: half)
                ctx.restoreGState()
            }
        }
    }

    /// Fill the canvas background for a drawing's theme.
    static func fillBackground(_ bg: Background, in ctx: CGContext, size: CGSize) {
        ctx.setFillColor(UIColor(hex: bg.hex).cgColor)
        ctx.fill(CGRect(origin: .zero, size: size))
    }

    // ---- one stroke (context already centered + image-transformed) ----------

    private static func drawStroke(_ stroke: Stroke, in ctx: CGContext, half: CGFloat) {
        let pts = stroke.pts
        guard !pts.isEmpty else { return }

        let scale = half / CGFloat(REFERENCE_HALF)
        let isSpectrum = stroke.color == "spectrum"
        let baseColor = isSpectrum ? nil : UIColor(hex: stroke.color)

        ctx.saveGState()
        ctx.setLineCap(.round)
        ctx.setLineJoin(.round)
        // Glow blends additively (like canvas "lighter") at 70% alpha.
        if stroke.tool == .glow {
            ctx.setBlendMode(.plusLighter)
            ctx.setAlpha(CGFloat(stroke.opacity * 0.7))
        } else {
            ctx.setBlendMode(.normal)
            ctx.setAlpha(CGFloat(stroke.opacity))
        }

        if pts.count == 1 {
            let p = pts[0]
            let x = CGFloat(p.x) * half
            let y = CGFloat(p.y) * half
            let r = max(0.5, CGFloat(stroke.size) * scale * CGFloat(widthFactor(p.pressure)) / 2)
            let fill = isSpectrum ? uiColor(spectrumRGB(nx: p.x, ny: p.y)) : baseColor!
            ctx.setFillColor(fill.cgColor)
            ctx.fillEllipse(in: CGRect(x: x - r, y: y - r, width: r * 2, height: r * 2))
            ctx.restoreGState()
            return
        }

        // Segment-by-segment so width and spectrum hue vary along the stroke.
        for i in 1..<pts.count {
            let a = pts[i - 1]
            let b = pts[i]
            let w = max(0.5, CGFloat(stroke.size) * scale * CGFloat(widthFactor((a.pressure + b.pressure) / 2)))
            ctx.setLineWidth(w)
            let color = isSpectrum
                ? uiColor(spectrumRGB(nx: (a.x + b.x) / 2, ny: (a.y + b.y) / 2))
                : baseColor!
            ctx.setStrokeColor(color.cgColor)
            ctx.beginPath()
            ctx.move(to: CGPoint(x: CGFloat(a.x) * half, y: CGFloat(a.y) * half))
            ctx.addLine(to: CGPoint(x: CGFloat(b.x) * half, y: CGFloat(b.y) * half))
            ctx.strokePath()
        }
        ctx.restoreGState()
    }

    private static func uiColor(_ rgb: RGB) -> UIColor {
        UIColor(red: CGFloat(rgb.r), green: CGFloat(rgb.g), blue: CGFloat(rgb.b), alpha: 1)
    }
}
