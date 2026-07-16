import UIKit
import SwiftUI
import KaleidoEngine

/// The interactive drawing surface. Committed strokes are rasterized into a
/// cached bitmap (rebuilt only when the drawing/settings/size change); the live
/// in-progress stroke is painted on top each frame, so ongoing drawing stays
/// cheap regardless of how many strokes are already down.
///
/// Note: tilt/altitude is intentionally not stored — the shared vector format is
/// [x, y, pressure] only, so pressure alone drives width to keep web interop.
final class KaleidoCanvasView: UIView {
    weak var model: StudioModel?

    private var liveStroke: Stroke?
    private var activeTouch: UITouch?
    private var committedImage: UIImage?
    private var cacheSignature: Int = .min

    /// Default when a device reports no force (finger without pressure).
    private let defaultPressure = 0.5
    /// Minimum normalized move to record a point (keeps payloads small).
    private var minMoveNorm: CGFloat { 1.1 / max(1, half) }

    /// Revision last spoken via a VoiceOver announcement + the time it was made,
    /// so we announce committed-content changes once and throttle bursts.
    private var lastAnnouncedRevision = 0
    private var lastAnnouncement = Date.distantPast
    private let announceMinInterval: TimeInterval = 0.6

    override init(frame: CGRect) {
        super.init(frame: frame)
        isMultipleTouchEnabled = false // palm rejection: one active touch at a time
        backgroundColor = .clear
        contentMode = .redraw
        isOpaque = true
        // Accessibility: one element the user can still finger-draw on directly.
        isAccessibilityElement = true
        accessibilityLabel = "Drawing canvas"
        accessibilityTraits.insert(.allowsDirectInteraction)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) not used") }

    private var half: CGFloat { min(bounds.width, bounds.height) / 2 }

    /// Called from the SwiftUI representable whenever the model changes.
    func refresh() {
        setNeedsDisplay()
        guard let model else { return }
        if model.revision != lastAnnouncedRevision {
            lastAnnouncedRevision = model.revision
            announceStateChange(model: model)
        }
    }

    // ---- accessibility --------------------------------------------------

    /// e.g. "12-fold mirror symmetry, 3 strokes" — recomputed on each read so it
    /// always reflects the live model state.
    override var accessibilityValue: String? {
        get { model.map { m in MainActor.assumeIsolated { stateDescription(m) } } }
        set {}
    }

    override var accessibilityCustomActions: [UIAccessibilityCustomAction]? {
        get { buildCustomActions() }
        set {}
    }

    private func stateDescription(_ model: StudioModel) -> String {
        let symmetry = model.mirror ? "\(model.segments)-fold mirror symmetry" : "\(model.segments)-fold rotational symmetry"
        let count = model.strokes.count
        let strokes = count == 1 ? "1 stroke" : "\(count) strokes"
        return "\(symmetry), \(strokes)"
    }

    private func buildCustomActions() -> [UIAccessibilityCustomAction] {
        guard let model else { return [] }
        return MainActor.assumeIsolated {
            var actions: [UIAccessibilityCustomAction] = []
            if model.canUndo { actions.append(customAction("Undo") { $0.undo() }) }
            if model.canRedo { actions.append(customAction("Redo") { $0.redo() }) }
            if !model.isEmpty { actions.append(customAction("Clear canvas") { $0.clear() }) }
            actions.append(customAction(model.mirror ? "Turn off mirror symmetry" : "Turn on mirror symmetry") {
                $0.mirror.toggle()
            })
            return actions
        }
    }

    private func customAction(_ name: String, _ perform: @escaping (StudioModel) -> Void) -> UIAccessibilityCustomAction {
        UIAccessibilityCustomAction(name: name) { [weak self] _ in
            guard let self, let model = self.model else { return false }
            MainActor.assumeIsolated { perform(model) }
            self.refresh()
            return true
        }
    }

    /// Announce committed-content changes (commit / undo / redo / clear) to
    /// VoiceOver, throttled so a burst doesn't flood the user.
    private func announceStateChange(model: StudioModel) {
        guard UIAccessibility.isVoiceOverRunning else { return }
        let now = Date()
        guard now.timeIntervalSince(lastAnnouncement) >= announceMinInterval else { return }
        lastAnnouncement = now
        let message = model.isEmpty ? "Canvas cleared" : stateDescription(model)
        UIAccessibility.post(notification: .announcement, argument: message)
    }

    // ---- touch handling -------------------------------------------------

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard activeTouch == nil, let model, let touch = preferredTouch(touches) else { return }
        activeTouch = touch
        liveStroke = Stroke(
            tool: model.tool,
            color: model.effectiveColor,
            size: model.size,
            opacity: model.opacity,
            pts: []
        )
        appendPoints(for: touch, event: event)
        setNeedsDisplay()
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard let active = activeTouch, touches.contains(active) else { return }
        appendPoints(for: active, event: event)
        setNeedsDisplay()
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard let active = activeTouch, touches.contains(active) else { return }
        appendPoints(for: active, event: event)
        if let stroke = liveStroke, !stroke.pts.isEmpty {
            model?.commit(stroke) // bumps revision → committed cache rebuilds
        }
        liveStroke = nil
        activeTouch = nil
        setNeedsDisplay()
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        liveStroke = nil
        activeTouch = nil
        setNeedsDisplay()
    }

    /// Prefer an Apple Pencil touch if present (so a resting palm never wins).
    private func preferredTouch(_ touches: Set<UITouch>) -> UITouch? {
        touches.first { $0.type == .pencil } ?? touches.first
    }

    private func appendPoints(for touch: UITouch, event: UIEvent?) {
        guard liveStroke != nil else { return }
        let coalesced = event?.coalescedTouches(for: touch) ?? [touch]
        for t in coalesced {
            let loc = t.location(in: self)
            let pressure = t.force > 0 ? Double(t.force / max(t.maximumPossibleForce, 0.0001)) : defaultPressure
            let n = toNormalized(px: Double(loc.x), py: Double(loc.y),
                                 width: Double(bounds.width), height: Double(bounds.height))
            let pt = StrokePoint(x: n.x, y: n.y, pressure: min(1, pressure))
            if let last = liveStroke!.pts.last {
                let dx = CGFloat(pt.x - last.x), dy = CGFloat(pt.y - last.y)
                if hypot(dx, dy) < minMoveNorm { continue }
            }
            liveStroke!.pts.append(pt)
        }
    }

    // ---- rendering ------------------------------------------------------

    override func draw(_ rect: CGRect) {
        guard let model, let ctx = UIGraphicsGetCurrentContext() else { return }
        rebuildCommittedIfNeeded(model: model)
        committedImage?.draw(in: bounds)
        if let live = liveStroke {
            KaleidoRenderer.paint([live], sym: model.symmetry, in: ctx, size: bounds.size, half: half)
        }
    }

    private func signature(for model: StudioModel) -> Int {
        var h = Hasher()
        h.combine(model.revision)
        h.combine(Int(bounds.width.rounded()))
        h.combine(Int(bounds.height.rounded()))
        h.combine(model.segments)
        h.combine(model.mirror)
        h.combine(model.background)
        h.combine(model.showGuides)
        return h.finalize()
    }

    private func rebuildCommittedIfNeeded(model: StudioModel) {
        let sig = signature(for: model)
        if sig == cacheSignature, committedImage != nil { return }
        cacheSignature = sig

        let size = bounds.size
        guard size.width > 0, size.height > 0 else { committedImage = nil; return }
        let format = UIGraphicsImageRendererFormat()
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        committedImage = renderer.image { rendererCtx in
            let ctx = rendererCtx.cgContext
            KaleidoRenderer.fillBackground(model.background, in: ctx, size: size)
            if model.showGuides {
                drawGuides(in: ctx, size: size, model: model)
            }
            KaleidoRenderer.paint(model.strokes, sym: model.symmetry, in: ctx, size: size, half: half)
        }
    }

    /// Faint wedge guides: radial spokes at each segment boundary, plus the
    /// mirror axis (wedge bisector) when dihedral, and a boundary circle.
    private func drawGuides(in ctx: CGContext, size: CGSize, model: StudioModel) {
        let cx = size.width / 2, cy = size.height / 2
        let radius = min(size.width, size.height) / 2
        let ink = (model.background == .dark ? UIColor.white : UIColor.black).withAlphaComponent(0.10)
        ctx.saveGState()
        ctx.setStrokeColor(ink.cgColor)
        ctx.setLineWidth(1)
        let step = (CGFloat.pi * 2) / CGFloat(model.segments)
        for i in 0..<model.segments {
            let a = CGFloat(i) * step
            ctx.beginPath()
            ctx.move(to: CGPoint(x: cx, y: cy))
            ctx.addLine(to: CGPoint(x: cx + cos(a) * radius, y: cy + sin(a) * radius))
            ctx.strokePath()
            if model.mirror {
                let bis = a + step / 2
                ctx.saveGState()
                ctx.setLineDash(phase: 0, lengths: [3, 4])
                ctx.beginPath()
                ctx.move(to: CGPoint(x: cx, y: cy))
                ctx.addLine(to: CGPoint(x: cx + cos(bis) * radius, y: cy + sin(bis) * radius))
                ctx.strokePath()
                ctx.restoreGState()
            }
        }
        ctx.strokeEllipse(in: CGRect(x: cx - radius, y: cy - radius, width: radius * 2, height: radius * 2))
        ctx.restoreGState()
    }
}

/// SwiftUI wrapper for the canvas.
struct DrawingCanvas: UIViewRepresentable {
    @ObservedObject var model: StudioModel

    func makeUIView(context: Context) -> KaleidoCanvasView {
        let view = KaleidoCanvasView()
        view.model = model
        return view
    }

    func updateUIView(_ view: KaleidoCanvasView, context: Context) {
        view.model = model
        view.refresh()
    }
}
