import UIKit
import KaleidoEngine

/// Offscreen rasterization of a drawing to PNG, for upload + local download.
/// Sizes mirror the web exporter (export.ts): image 1024², thumb 512², OG
/// 1200×630 with half = (h/2)·0.82.
enum StudioExport {
    static let imageSize: CGFloat = 1024
    static let thumbSize: CGFloat = 512
    static let ogWidth: CGFloat = 1200
    static let ogHeight: CGFloat = 630

    /// Square render — background filled, half = size/2 (matches `renderSquare`).
    static func renderSquare(_ drawing: Drawing, size: CGFloat) -> UIImage {
        render(drawing, width: size, height: size, half: size / 2)
    }

    /// Non-square OG card — half = (height/2)·0.82 (matches `exportOG`).
    static func renderOG(_ drawing: Drawing) -> UIImage {
        render(drawing, width: ogWidth, height: ogHeight, half: (ogHeight / 2) * 0.82)
    }

    private static func render(_ drawing: Drawing, width: CGFloat, height: CGFloat, half: CGFloat) -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1 // 1 pt == 1 px, so the output is exactly width×height
        format.opaque = true
        let size = CGSize(width: width, height: height)
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        return renderer.image { rendererCtx in
            let ctx = rendererCtx.cgContext
            KaleidoRenderer.fillBackground(drawing.bg, in: ctx, size: size)
            KaleidoRenderer.paint(drawing.strokes, sym: drawing.sym, in: ctx, size: size, half: half)
        }
    }

    /// The three PNGs the save flow uploads. Returns nil if any encode fails.
    static func exportSet(_ drawing: Drawing) -> (image: Data, thumb: Data, og: Data)? {
        guard let image = renderSquare(drawing, size: imageSize).pngData(),
              let thumb = renderSquare(drawing, size: thumbSize).pngData(),
              let og = renderOG(drawing).pngData()
        else { return nil }
        return (image, thumb, og)
    }
}
