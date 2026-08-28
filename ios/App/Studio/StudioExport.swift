import UIKit
import KaleidoEngine

/// Offscreen rasterization of a drawing to PNG, for upload + local download.
/// Sizes mirror the web exporter (export.ts): image 1024², thumb 512², OG
/// 1200×630 with half = (h/2)·0.82.
///
/// Both the v1 and the v2 shapes are exported, deliberately. v2 is what the
/// studio renders and what T13's save flow will use; the v1 overloads stay so
/// the not-yet-migrated save sheet keeps compiling and keeps producing the same
/// picture it always did. A v1 drawing goes through the single-layer upgrade, so
/// there is exactly ONE painting path and the two can never drift.
enum StudioExport {
    static let imageSize: CGFloat = 1024
    static let thumbSize: CGFloat = 512
    static let ogWidth: CGFloat = 1200
    static let ogHeight: CGFloat = 630

    /// Square render — background filled, half = size/2 (matches `renderSquare`).
    static func renderSquare(_ drawing: DrawingV2, size: CGFloat) -> UIImage {
        render(drawing, width: size, height: size, half: size / 2)
    }

    /// Non-square OG card — half = (height/2)·0.82 (matches `exportOG`).
    static func renderOG(_ drawing: DrawingV2) -> UIImage {
        render(drawing, width: ogWidth, height: ogHeight, half: (ogHeight / 2) * 0.82)
    }

    static func renderSquare(_ drawing: Drawing, size: CGFloat) -> UIImage {
        renderSquare(upgradeToV2(drawing), size: size)
    }

    static func renderOG(_ drawing: Drawing) -> UIImage {
        renderOG(upgradeToV2(drawing))
    }

    private static func render(_ drawing: DrawingV2, width: CGFloat, height: CGFloat, half: CGFloat) -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1 // 1 pt == 1 px, so the output is exactly width×height
        format.opaque = true
        let size = CGSize(width: width, height: height)
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        return renderer.image { rendererCtx in
            let ctx = rendererCtx.cgContext
            KaleidoRenderer.fillBackground(drawing.bg, in: ctx, size: size)
            // Exports ignore the studio's zoom/pan, so the backing store and the
            // logical size are the same thing here.
            KaleidoRenderer.paintDrawing(drawing, in: ctx, size: size, half: half, pixelSize: size)
        }
    }

    /// The three PNGs the save flow uploads. Returns nil if any encode fails.
    static func exportSet(_ drawing: DrawingV2) -> (image: Data, thumb: Data, og: Data)? {
        guard let image = renderSquare(drawing, size: imageSize).pngData(),
              let thumb = renderSquare(drawing, size: thumbSize).pngData(),
              let og = renderOG(drawing).pngData()
        else { return nil }
        return (image, thumb, og)
    }

    static func exportSet(_ drawing: Drawing) -> (image: Data, thumb: Data, og: Data)? {
        exportSet(upgradeToV2(drawing))
    }
}
