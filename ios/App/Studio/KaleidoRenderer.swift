import UIKit
import KaleidoEngine

/// Core Graphics renderer for kaleidoscope drawings — the native mirror of the
/// web `paintDrawing`/`paintStrokes` (scene.ts) + `drawStroke` (brush.ts). It
/// paints into any CGContext (a live layer or an offscreen export bitmap). The
/// renderer is purely visual; the vector serializer (KaleidoEngine) is what must
/// match byte-for-byte.
///
/// Contexts here are UIKit-flipped (y-down), matching the web canvas convention,
/// so the symmetry reflection is `scale(x: 1, y: -1)` exactly as on the web.
enum KaleidoRenderer {
    /// Paint all strokes of one layer's symmetry group. Does NOT fill the
    /// background (callers do). `half` is the shorter half-axis in px.
    ///
    /// This is the operation sequence the web's `render-trace` snapshot freezes,
    /// and the reason every existing gallery piece still rasterizes to the PNG it
    /// was saved as: stroke-outer, image-inner, in the engine's canonical image
    /// order. Change the order and additive `glow` produces a different picture.
    static func paint(_ strokes: [Stroke], sym: Symmetry, in ctx: CGContext,
                      size: CGSize, half: CGFloat) {
        let cx = size.width / 2
        let cy = size.height / 2
        let images = symmetryImages(segments: sym.segments, mirror: sym.mirror)
        for stroke in strokes {
            // Smoothing is a property of the stroke, not of the image, so it is
            // built ONCE and reused across all 2n copies. Rebuilding it per image
            // would make a 24-fold mirrored glow stroke 48× more expensive to
            // draw than to store, which the live canvas cannot afford.
            let cubics = stroke.sm ? smoothStroke(stroke.pts) : nil
            for image in images {
                ctx.saveGState()
                ctx.translateBy(x: cx, y: cy)
                ctx.rotate(by: CGFloat(image.angle))
                if image.mirror { ctx.scaleBy(x: 1, y: -1) }
                drawStroke(stroke, cubics: cubics, in: ctx, half: half)
                ctx.restoreGState()
            }
        }
    }

    /// An in-progress stroke to render as if it were already in its layer.
    struct LiveStroke {
        let stroke: Stroke
        let layerId: String
        init(_ stroke: Stroke, layerId: String) {
            self.stroke = stroke
            self.layerId = layerId
        }
    }

    /// Paint a whole v2 drawing: visible layers bottom → top, each under its own
    /// symmetry, each flattened and then composited at its layer opacity.
    ///
    /// THE ONE RULE THAT MATTERS: a single visible layer at opacity 1 bypasses
    /// the offscreen buffer entirely and paints straight into `ctx`. This is not
    /// an optimization. `glow` uses `.plusLighter`, so it blends additively
    /// against whatever is already on the destination — the export's background
    /// fill, or ink from an earlier stroke. Routed through an offscreen buffer it
    /// would instead blend against transparent black and come out a different
    /// picture. Every piece in the live gallery is a single-layer v1 drawing
    /// whose stored PNG came off the direct path, so the bypass is what keeps
    /// them all rendering as they were saved.
    ///
    /// A consequence worth knowing rather than smoothing over: hiding one of two
    /// layers moves a drawing onto the bypass path, so a glow stroke can shift
    /// slightly when you toggle the other layer's eye. That falls out of the rule.
    ///
    /// `pixelSize` is the DESTINATION's backing store in device pixels. It is
    /// passed rather than derived from the CTM because the live canvas paints
    /// under a zoom transform: deriving it would size the buffer by the zoom
    /// (64× the pixels at 8×) when the buffer only ever needs to cover what the
    /// destination can actually hold.
    static func paintDrawing(_ drawing: DrawingV2, in ctx: CGContext,
                             size: CGSize, half: CGFloat, pixelSize: CGSize,
                             live: LiveStroke? = nil) {
        let visible = drawing.layers.filter(\.visible)
        guard !visible.isEmpty else { return }
        // Computed once over the whole drawing, not per layer.
        let bypass = visible.count == 1 && visible[0].opacity == 1

        for layer in visible {
            let strokes = strokesFor(layer, live: live)
            if strokes.isEmpty { continue }

            if bypass {
                paint(strokes, sym: layer.sym, in: ctx, size: size, half: half)
                continue
            }
            compositeLayer(strokes, layer: layer, into: ctx,
                           size: size, half: half, pixelSize: pixelSize)
        }
    }

    private static func strokesFor(_ layer: Layer, live: LiveStroke?) -> [Stroke] {
        guard let live, live.layerId == layer.id else { return layer.strokes }
        return layer.strokes + [live.stroke]
    }

    /// Render one layer into an offscreen bitmap with the destination's exact
    /// backing-store geometry and transform, then composite it back at 1:1
    /// device pixels. Matching the geometry is what keeps the composite from
    /// resampling: a point-space `draw(in:)` would resample by whatever rounding
    /// difference exists between the buffer's and the destination's pixel grids.
    private static func compositeLayer(_ strokes: [Stroke], layer: Layer,
                                       into ctx: CGContext, size: CGSize,
                                       half: CGFloat, pixelSize: CGSize) {
        let pw = max(1, Int(pixelSize.width.rounded()))
        let ph = max(1, Int(pixelSize.height.rounded()))
        let ctm = ctx.ctm

        guard let buffer = CGContext(
            data: nil, width: pw, height: ph, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
        ) else {
            // No buffer: paint straight through rather than dropping the layer.
            // A slightly wrong composite beats a missing one.
            paint(strokes, sym: layer.sym, in: ctx, size: size, half: half)
            return
        }
        // A fresh bitmap context is y-up with an identity CTM; the destination is
        // UIKit-flipped and may carry a zoom/pan. Replicating the destination's
        // CTM makes a UIKit-space coordinate land on exactly the same device
        // pixel in both, which is what lets the copy back be 1:1.
        buffer.concatenate(ctm)
        paint(strokes, sym: layer.sym, in: buffer, size: size, half: half)
        guard let image = buffer.makeImage() else { return }

        ctx.saveGState()
        // Drop to device pixels so the copy neither scales nor resamples.
        ctx.concatenate(ctm.inverted())
        ctx.setAlpha(CGFloat(layer.opacity))
        ctx.setBlendMode(.normal)
        ctx.interpolationQuality = .none
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: pw, height: ph))
        ctx.restoreGState()
    }

    /// Fill the canvas background for a drawing's theme.
    static func fillBackground(_ bg: Background, in ctx: CGContext, size: CGSize) {
        ctx.setFillColor(UIColor(hex: bg.hex).cgColor)
        ctx.fill(CGRect(origin: .zero, size: size))
    }

    // ---- one stroke (context already centered + image-transformed) ----------

    private static func drawStroke(_ stroke: Stroke, cubics: [Cubic]?,
                                   in ctx: CGContext, half: CGFloat) {
        let pts = stroke.pts
        guard !pts.isEmpty else { return }

        let scale = half / CGFloat(REFERENCE_HALF)
        let isSpectrum = stroke.color == "spectrum"
        let baseColor = isSpectrum ? nil : UIColor(hex: stroke.color)

        ctx.saveGState()
        ctx.setLineCap(.round)
        ctx.setLineJoin(.round)
        // Glow blends additively (like canvas "lighter") at 70% alpha.
        let glow = stroke.tool == .glow
        ctx.setBlendMode(glow ? .plusLighter : .normal)

        // Per-segment alpha. WITHOUT `po` this is the stroke's flat opacity for
        // every segment — bit-for-bit the v1 behavior, which is what keeps every
        // existing gallery piece rendering as its stored PNG.
        func alpha(_ pressure: Double) -> CGFloat {
            let base = stroke.po ? pressureAlpha(opacity: stroke.opacity, pressure: pressure) : stroke.opacity
            return CGFloat(glow ? base * 0.7 : base)
        }

        if pts.count == 1 {
            let p = pts[0]
            let x = CGFloat(p.x) * half
            let y = CGFloat(p.y) * half
            let r = max(0.5, CGFloat(stroke.size) * scale * CGFloat(widthFactor(p.pressure)) / 2)
            let fill = isSpectrum ? uiColor(spectrumRGB(nx: p.x, ny: p.y)) : baseColor!
            ctx.setAlpha(alpha(p.pressure))
            ctx.setFillColor(fill.cgColor)
            ctx.fillEllipse(in: CGRect(x: x - r, y: y - r, width: r * 2, height: r * 2))
            ctx.restoreGState()
            return
        }

        // Segment-by-segment so width, alpha and spectrum hue vary along the
        // stroke. `smoothStroke` deliberately keeps the same segment boundaries,
        // so a smoothed stroke shades identically to the polyline it replaces —
        // only the geometry between two recorded points changes.
        for i in 1..<pts.count {
            let a = pts[i - 1]
            let b = pts[i]
            let meanP = (a.pressure + b.pressure) / 2
            let w = max(0.5, CGFloat(stroke.size) * scale * CGFloat(widthFactor(meanP)))
            ctx.setLineWidth(w)
            ctx.setAlpha(alpha(meanP))
            let color = isSpectrum
                ? uiColor(spectrumRGB(nx: (a.x + b.x) / 2, ny: (a.y + b.y) / 2))
                : baseColor!
            ctx.setStrokeColor(color.cgColor)
            ctx.beginPath()
            ctx.move(to: CGPoint(x: CGFloat(a.x) * half, y: CGFloat(a.y) * half))
            if let c = cubics, i - 1 < c.count {
                let seg = c[i - 1]
                ctx.addCurve(
                    to: CGPoint(x: CGFloat(seg.x) * half, y: CGFloat(seg.y) * half),
                    control1: CGPoint(x: CGFloat(seg.c1x) * half, y: CGFloat(seg.c1y) * half),
                    control2: CGPoint(x: CGFloat(seg.c2x) * half, y: CGFloat(seg.c2y) * half)
                )
            } else {
                ctx.addLine(to: CGPoint(x: CGFloat(b.x) * half, y: CGFloat(b.y) * half))
            }
            ctx.strokePath()
        }
        ctx.restoreGState()
    }

    // ---- overlays ----------------------------------------------------------

    /// The Pencil hover ring, stamped at every image of `sym` so the user can see
    /// where the brush will land in each wedge, not just under the tip.
    ///
    /// Three things here were wrong against the web and DESIGN.md (S19):
    ///
    /// 1. The PRIMARY image — the one actually under the pen — is opaque, and
    ///    only its reflections are at 55%. Every ring used to be 55%, which
    ///    removed the single thing the ring exists to tell you: which of the N
    ///    marks is the one you are making.
    /// 2. The colour is the crane accent, as on the web, not black/white.
    /// 3. `viewScale` divides the line width. This is drawn INSIDE the view
    ///    transform, so a 1pt line rendered 8pt thick at 8x zoom — the ring got
    ///    heavier the further you zoomed in, which is exactly backwards.
    static func drawHoverRing(at point: CGPoint, radius: CGFloat, sym: Symmetry,
                              in ctx: CGContext, size: CGSize, half: CGFloat,
                              color: UIColor, viewScale: CGFloat = 1) {
        let cx = size.width / 2
        let cy = size.height / 2
        let r = max(2, radius)
        ctx.saveGState()
        // 1pt ON SCREEN whatever the zoom.
        ctx.setLineWidth(1 / max(0.0001, viewScale))
        for image in symmetryImages(segments: sym.segments, mirror: sym.mirror) {
            ctx.saveGState()
            // `index == 0` is the image under the pen; the rest are reflections.
            ctx.setStrokeColor(color.withAlphaComponent(image.index == 0 ? 1 : 0.55).cgColor)
            ctx.translateBy(x: cx, y: cy)
            ctx.rotate(by: CGFloat(image.angle))
            if image.mirror { ctx.scaleBy(x: 1, y: -1) }
            ctx.strokeEllipse(in: CGRect(x: point.x * half - r, y: point.y * half - r,
                                         width: r * 2, height: r * 2))
            ctx.restoreGState()
        }
        ctx.restoreGState()
    }

    /// Highlight every image of one stroke — phase one of Remove-stroke.
    static func highlightStroke(_ stroke: Stroke, sym: Symmetry, in ctx: CGContext,
                                size: CGSize, half: CGFloat, color: UIColor) {
        guard !stroke.pts.isEmpty else { return }
        let cx = size.width / 2
        let cy = size.height / 2
        let scale = half / CGFloat(REFERENCE_HALF)
        let width = max(3, CGFloat(stroke.size) * scale + 4)
        let cubics = stroke.sm ? smoothStroke(stroke.pts) : nil
        ctx.saveGState()
        ctx.setBlendMode(.normal)
        ctx.setStrokeColor(color.cgColor)
        ctx.setLineCap(.round)
        ctx.setLineJoin(.round)
        ctx.setLineWidth(width)
        for image in symmetryImages(segments: sym.segments, mirror: sym.mirror) {
            ctx.saveGState()
            ctx.translateBy(x: cx, y: cy)
            ctx.rotate(by: CGFloat(image.angle))
            if image.mirror { ctx.scaleBy(x: 1, y: -1) }
            ctx.beginPath()
            if stroke.pts.count == 1 {
                let p = stroke.pts[0]
                ctx.addEllipse(in: CGRect(x: CGFloat(p.x) * half - width / 2,
                                          y: CGFloat(p.y) * half - width / 2,
                                          width: width, height: width))
                ctx.strokePath()
            } else {
                ctx.move(to: CGPoint(x: CGFloat(stroke.pts[0].x) * half,
                                     y: CGFloat(stroke.pts[0].y) * half))
                for i in 1..<stroke.pts.count {
                    if let c = cubics, i - 1 < c.count {
                        let seg = c[i - 1]
                        ctx.addCurve(
                            to: CGPoint(x: CGFloat(seg.x) * half, y: CGFloat(seg.y) * half),
                            control1: CGPoint(x: CGFloat(seg.c1x) * half, y: CGFloat(seg.c1y) * half),
                            control2: CGPoint(x: CGFloat(seg.c2x) * half, y: CGFloat(seg.c2y) * half)
                        )
                    } else {
                        ctx.addLine(to: CGPoint(x: CGFloat(stroke.pts[i].x) * half,
                                                y: CGFloat(stroke.pts[i].y) * half))
                    }
                }
                ctx.strokePath()
            }
            ctx.restoreGState()
        }
        ctx.restoreGState()
    }

    private static func uiColor(_ rgb: RGB) -> UIColor {
        UIColor(red: CGFloat(rgb.r), green: CGFloat(rgb.g), blue: CGFloat(rgb.b), alpha: 1)
    }
}
