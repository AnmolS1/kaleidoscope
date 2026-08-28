import SwiftUI
import UIKit
import KaleidoEngine

/// A hidden, launch-gated element that publishes export fingerprints to the UI
/// tests. Mounted only when the app is launched with `KALEIDO_EXPORT_PROBE=1`,
/// so it costs a shipping build nothing but the type.
///
/// Why it exists: the natural acceptance test for the PNG download is "the
/// exported image is not blank" — and that test PASSES on the bug it is meant
/// to catch. The download used to render `currentDrawing()`, a v1 projection
/// that flattens every layer under one symmetry, drops per-layer opacity and
/// strips smoothing. A flattened layered piece is still full of ink, so a
/// non-blank assertion cannot tell the two pictures apart.
///
/// So the probe reports three fingerprints and the test asserts a RELATIONSHIP:
///
/// - `v2` — what the Download button actually renders (`StudioView.exportImage`)
/// - `v1` — the same document through the deprecated v1 projection
/// - `empty` — an empty document through the same renderer
///
/// `empty` is the live control: it proves a blank render really does report as
/// blank, so `v2ink > 0` is an assertion and not a tautology. `v2hash != v1hash`
/// is the mutation guard: point the download back at `currentDrawing()` and the
/// two fingerprints collapse onto each other and the test goes red. The demo
/// fixture is what makes that gap exist — three layers at 6/12/9-fold with the
/// middle one at 0.75 opacity, so flattening changes both symmetry and alpha.
enum ExportProbe {
    /// Small enough that three renders + three full-buffer walks stay cheap.
    static let probeSize: CGFloat = 256

    static var enabled: Bool {
        ProcessInfo.processInfo.environment["KALEIDO_EXPORT_PROBE"] == "1"
    }

    struct Fingerprint {
        /// Pixels differing from the background (sampled at the top-left corner,
        /// which the square export always fills with `drawing.bg`).
        let ink: Int
        /// FNV-1a over the RGB bytes — sensitive to WHERE the ink is, not just
        /// how much of it there is, which is what distinguishes two drawings
        /// that happen to cover the same number of pixels.
        let hash: UInt64
    }

    static func fingerprint(_ image: UIImage) -> Fingerprint {
        guard let cg = image.cgImage else { return Fingerprint(ink: 0, hash: 0) }
        let w = cg.width, h = cg.height
        guard w > 0, h > 0 else { return Fingerprint(ink: 0, hash: 0) }
        var buf = [UInt8](repeating: 0, count: w * h * 4)
        let ok: Bool = buf.withUnsafeMutableBytes { raw -> Bool in
            guard let ctx = CGContext(data: raw.baseAddress, width: w, height: h,
                                      bitsPerComponent: 8, bytesPerRow: w * 4,
                                      space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
            else { return false }
            ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
            return true
        }
        guard ok else { return Fingerprint(ink: 0, hash: 0) }

        let bgR = buf[0], bgG = buf[1], bgB = buf[2]
        var ink = 0
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for i in stride(from: 0, to: buf.count, by: 4) {
            let r = buf[i], g = buf[i + 1], b = buf[i + 2]
            if r != bgR || g != bgG || b != bgB { ink += 1 }
            hash = (hash ^ UInt64(r)) &* 0x100_0000_01b3
            hash = (hash ^ UInt64(g)) &* 0x100_0000_01b3
            hash = (hash ^ UInt64(b)) &* 0x100_0000_01b3
        }
        return Fingerprint(ink: ink, hash: hash)
    }

    /// `v2ink=… v2hash=… v1ink=… v1hash=… emptyink=… emptyhash=…`
    ///
    /// `image` is the caller's real export — passed in rather than recomputed so
    /// the probe can never fingerprint a different code path than the button.
    /// It MUST be rendered at `probeSize`: fingerprints of two differently-sized
    /// buffers always differ, which would make `v2hash != v1hash` true for a
    /// reason that has nothing to do with the document.
    @MainActor
    static func report(exported image: UIImage, model: StudioModel) -> String {
        let v2 = fingerprint(image)
        let v1 = fingerprint(StudioExport.renderSquare(legacyProjection(model), size: probeSize))
        let blank = fingerprint(StudioExport.renderSquare(
            emptyDrawingV2(bg: model.background, sym: model.symmetry), size: probeSize))
        return "v2ink=\(v2.ink) v2hash=\(v2.hash) "
             + "v1ink=\(v1.ink) v1hash=\(v1.hash) "
             + "emptyink=\(blank.ink) emptyhash=\(blank.hash)"
    }

    /// The deprecated projection, called in one place so the deprecation warning
    /// is silenced exactly here — where using it is the POINT — and stays loud
    /// everywhere else.
    @MainActor
    @available(*, deprecated)
    private static func legacyProjection(_ model: StudioModel) -> Drawing {
        model.currentDrawing()
    }
}

/// The probe's carrier: a zero-visual `Text` whose accessibility label is the
/// report. A `Text` (rather than a bare accessibility element) is deliberate —
/// its label is its string, so there is nothing to keep in sync.
struct ExportProbeView: View {
    let report: String

    var body: some View {
        Text(report)
            .font(.system(size: 1))
            .foregroundStyle(.clear)
            .frame(width: 2, height: 2)
            .clipped()
            .allowsHitTesting(false)
            .accessibilityIdentifier("export-probe")
    }
}
