import UIKit
import SwiftUI
import KaleidoEngine

/// The interactive drawing surface. Committed content is rasterized into a
/// cached bitmap (rebuilt only when the drawing/settings/size/view change); the
/// live in-progress stroke is painted on top each frame, so ongoing drawing
/// stays cheap regardless of how many strokes are already down.
///
/// Note: tilt/altitude is intentionally not stored — the shared vector format is
/// [x, y, pressure] only, so pressure alone drives width and (with `po`) alpha.
final class KaleidoCanvasView: UIView {
    weak var model: StudioModel?

    private var liveStroke: Stroke?
    /// Predicted points from `UIEvent.predictedTouches`. Drawn but NEVER
    /// committed: they are the system's guess at where the pencil is heading,
    /// which hides input latency at the tip. Storing them would put invented
    /// geometry into the file.
    private var predictedPts: [StrokePoint] = []
    private var activeTouch: UITouch?
    /// Set when a multi-finger gesture claims the touch sequence, so the stroke
    /// that was starting is discarded rather than committed on lift.
    private var strokeCancelled = false
    private var committedImage: UIImage?
    private var cacheSignature: Int = .min

    /// Pencil hover position in normalized coords, or nil when nothing hovers.
    private var hoverPoint: CGPoint?

    /// Default when a device reports no force (finger without pressure).
    private let defaultPressure = 0.5

    /// Minimum normalized move to record a point. Divided by the view scale:
    /// at 8× a 1.1 px screen move is an eighth of the drawing-space distance it
    /// is at 1×, so a fixed threshold would quietly coarsen every zoomed stroke.
    private var minMoveNorm: CGFloat {
        let scale = model?.viewScale ?? 1
        return 1.1 / max(1, half * scale)
    }

    /// Extra hit-test slack in px, so a hairline is still tappable.
    private let hitSlackPx: CGFloat = 8

    /// Revision last spoken via a VoiceOver announcement + the time it was made,
    /// so we announce committed-content changes once and throttle bursts.
    private var lastAnnouncedRevision = 0
    private var lastAnnouncement = Date.distantPast
    private let announceMinInterval: TimeInterval = 0.6

    // Gesture state
    private var pinchStartScale: CGFloat = 1
    private var panStartOffset: CGSize = .zero
    private weak var panGesture: UIPanGestureRecognizer?

    override init(frame: CGRect) {
        super.init(frame: frame)
        // Multi-touch ON, with palm rejection done by hand below. With it off the
        // view never sees a second finger, so "two-finger gestures never draw"
        // would be unimplementable in the responder path and a finger landing
        // mid-stroke would keep drawing while the pinch started.
        isMultipleTouchEnabled = true
        backgroundColor = .clear
        contentMode = .redraw
        isOpaque = true
        // Accessibility: one element the user can still finger-draw on directly.
        isAccessibilityElement = true
        accessibilityLabel = "Drawing canvas"
        accessibilityTraits.insert(.allowsDirectInteraction)

        addInteraction(UIPencilInteraction())
        (interactions.compactMap { $0 as? UIPencilInteraction }).forEach { $0.delegate = self }

        let pinch = UIPinchGestureRecognizer(target: self, action: #selector(onPinch))
        pinch.delegate = self
        addGestureRecognizer(pinch)

        let pan = UIPanGestureRecognizer(target: self, action: #selector(onPan))
        pan.minimumNumberOfTouches = 2
        pan.maximumNumberOfTouches = 2
        pan.delegate = self
        addGestureRecognizer(pan)
        panGesture = pan

        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(onDoubleTap))
        doubleTap.numberOfTapsRequired = 2
        doubleTap.delegate = self
        addGestureRecognizer(doubleTap)

        let hover = UIHoverGestureRecognizer(target: self, action: #selector(onHover))
        addGestureRecognizer(hover)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) not used") }

    private var half: CGFloat { min(bounds.width, bounds.height) / 2 }

    /// Called from the SwiftUI representable whenever the model changes.
    func refresh() {
        setNeedsDisplay()
        guard let model else { return }
        // When the finger does not draw, it pans — that is the whole offer the
        // Pencil banner makes ("use fingers to pan and zoom instead"). Leaving
        // the two-finger minimum in place there would make a single finger do
        // nothing at all.
        panGesture?.minimumNumberOfTouches = model.drawWithFinger ? 2 : 1
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
        // Counts every layer, so the spoken description matches the piece rather
        // than the layer that happens to be selected.
        let count = model.strokeCount
        let strokes = count == 1 ? "1 stroke" : "\(count) strokes"
        let layerCount = model.layers.count
        guard layerCount > 1 else { return "\(symmetry), \(strokes)" }
        return "\(symmetry), \(strokes), layer \(model.activeLayer.name) of \(layerCount)"
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
            if model.viewScale != 1 { actions.append(customAction("Reset zoom") { $0.resetView() }) }
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
        guard let model else { return }

        // A second finger landing while a stroke is in flight is a gesture, not
        // ink: drop the stroke rather than letting the pinch draw a streak.
        if activeTouch != nil {
            if (event?.allTouches?.count ?? 1) > 1 { cancelStroke() }
            return
        }
        guard let touch = preferredTouch(touches) else { return }
        if touch.type == .pencil { model.notePencilUsed() }

        // Two fingers down together is a zoom/pan, never a stroke.
        if (event?.allTouches?.count ?? 1) > 1 { return }
        // Finger draws only when the user says it may. A Pencil always draws.
        guard touch.type == .pencil || model.drawWithFinger else { return }

        if model.removeStrokeMode {
            activeTouch = touch
            strokeCancelled = false
            return
        }

        activeTouch = touch
        strokeCancelled = false
        predictedPts = []
        liveStroke = Stroke(
            tool: model.tool,
            color: model.effectiveColor,
            size: model.size,
            opacity: model.opacity,
            // `po` is a PEN capability: a finger's `force` on a non-3D-Touch
            // screen is the flat default, which would render as a uniform alpha
            // shift rather than as pressure.
            po: model.pressureOpacity && touch.type == .pencil,
            // Every stroke authored from here on is smoothed. Existing v1
            // strokes are never retrofitted, which is what pins the gallery.
            sm: model.smoothStrokes,
            pts: []
        )
        appendPoints(for: touch, event: event)
        setNeedsDisplay()
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard let active = activeTouch, touches.contains(active), !strokeCancelled else { return }
        guard liveStroke != nil else { return }
        appendPoints(for: active, event: event)
        setNeedsDisplay()
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard let active = activeTouch, touches.contains(active) else { return }
        defer {
            liveStroke = nil
            predictedPts = []
            activeTouch = nil
            hoverPoint = nil
            setNeedsDisplay()
        }
        guard !strokeCancelled, let model else { return }

        if model.removeStrokeMode {
            handleRemoveTap(active, model: model)
            return
        }
        appendPoints(for: active, event: event)
        if let stroke = liveStroke, !stroke.pts.isEmpty {
            model.commit(stroke) // bumps revision → committed cache rebuilds
        }
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        cancelStroke()
        activeTouch = nil
        setNeedsDisplay()
    }

    private func cancelStroke() {
        strokeCancelled = true
        liveStroke = nil
        predictedPts = []
    }

    /// Prefer an Apple Pencil touch if present (so a resting palm never wins).
    private func preferredTouch(_ touches: Set<UITouch>) -> UITouch? {
        touches.first { $0.type == .pencil } ?? touches.first
    }

    // ---- remove-stroke (two-phase) --------------------------------------

    /// Tap one: highlight every image of the stroke under the finger, switching
    /// the active layer to the one it lives on. Tap two on the same stroke:
    /// remove it. Tapping elsewhere re-targets rather than deleting, which is
    /// what makes an accidental Pencil double-tap into this mode harmless.
    private func handleRemoveTap(_ touch: UITouch, model: StudioModel) {
        let n = normalizedPoint(touch.location(in: self))
        let tolerance = Double(hitSlackPx / max(1, half * model.viewScale))
        guard let hit = model.hitTestStroke(x: n.x, y: n.y, tolerance: tolerance) else {
            model.pendingHit = nil
            if UIAccessibility.isVoiceOverRunning {
                UIAccessibility.post(notification: .announcement, argument: "Nothing here")
            }
            return
        }
        if model.pendingHit == hit {
            model.deleteStroke(layerId: hit.layerId, index: hit.index)
        } else {
            model.pendingHit = hit
            _ = model.setActiveLayer(hit.layerId)
        }
    }

    // ---- point capture ---------------------------------------------------

    /// View pixel → normalized drawing coords, undoing the zoom/pan so a stroke
    /// drawn at 8× lands where the user aimed rather than eight times out.
    private func normalizedPoint(_ loc: CGPoint) -> (x: Double, y: Double) {
        let scale = model?.viewScale ?? 1
        let offset = model?.viewOffset ?? .zero
        let cx = bounds.width / 2
        let cy = bounds.height / 2
        let ux = (loc.x - cx - offset.width) / scale + cx
        let uy = (loc.y - cy - offset.height) / scale + cy
        return toNormalized(px: Double(ux), py: Double(uy),
                            width: Double(bounds.width), height: Double(bounds.height))
    }

    private func strokePoint(_ touch: UITouch, preset: PressurePreset) -> StrokePoint {
        let n = normalizedPoint(touch.location(in: self))
        // The preset is applied AT CAPTURE and the adjusted value is what gets
        // stored, so changing the setting later never repaints an old piece.
        //
        // PENCIL ONLY, like `po`, and matching the web. A finger reports no
        // usable force and falls back to a flat value, which has no dynamics for
        // a gamma to shape — it would just scale every stroke's width by a
        // constant, from a control the brush popover only shows once a Pencil
        // has been seen. Settled with Anmol 2026-08-28.
        guard touch.type == .pencil, touch.force > 0 else {
            return StrokePoint(x: n.x, y: n.y, pressure: defaultPressure)
        }
        let raw = Double(touch.force / max(touch.maximumPossibleForce, 0.0001))
        return StrokePoint(x: n.x, y: n.y, pressure: applyPressureGamma(min(1, raw), preset: preset))
    }

    private func appendPoints(for touch: UITouch, event: UIEvent?) {
        guard liveStroke != nil, let model else { return }
        let preset = model.pressurePreset
        let minDist = Double(minMoveNorm)
        let coalesced = event?.coalescedTouches(for: touch) ?? [touch]
        for t in coalesced {
            let pt = strokePoint(t, preset: preset)
            if shouldKeepPoint(prev: liveStroke!.pts.last, next: pt, minDistNorm: minDist) {
                liveStroke!.pts.append(pt)
            }
        }
        // Predicted touches are rendered ahead of the tip and thrown away on the
        // next move, so the stroke feels attached to the Pencil. They are
        // recomputed (not accumulated) precisely because they are a guess.
        predictedPts = (event?.predictedTouches(for: touch) ?? []).map { strokePoint($0, preset: preset) }
    }

    // ---- gestures --------------------------------------------------------

    @objc private func onPinch(_ g: UIPinchGestureRecognizer) {
        guard let model else { return }
        switch g.state {
        case .began:
            cancelStroke()
            pinchStartScale = model.viewScale
            panStartOffset = model.viewOffset
        case .changed:
            model.setView(scale: pinchStartScale * g.scale, offset: model.viewOffset, in: bounds.size)
        default:
            break
        }
    }

    @objc private func onPan(_ g: UIPanGestureRecognizer) {
        guard let model else { return }
        switch g.state {
        case .began:
            cancelStroke()
            panStartOffset = model.viewOffset
        case .changed:
            let t = g.translation(in: self)
            model.setView(scale: model.viewScale,
                          offset: CGSize(width: panStartOffset.width + t.x,
                                         height: panStartOffset.height + t.y),
                          in: bounds.size)
        default:
            break
        }
    }

    @objc private func onDoubleTap(_ g: UITapGestureRecognizer) {
        model?.resetView()
    }

    @objc private func onHover(_ g: UIHoverGestureRecognizer) {
        switch g.state {
        case .began, .changed:
            let n = normalizedPoint(g.location(in: self))
            hoverPoint = CGPoint(x: n.x, y: n.y)
        default:
            hoverPoint = nil
        }
        setNeedsDisplay()
    }

    // ---- rendering ------------------------------------------------------

    /// The destination backing store, in device pixels. Layer compositing needs
    /// it explicitly — see `KaleidoRenderer.paintDrawing`.
    private var pixelSize: CGSize {
        CGSize(width: bounds.width * contentScaleFactor, height: bounds.height * contentScaleFactor)
    }

    /// The zoom/pan, in point space. Applied to whichever context is painting,
    /// rather than to the view's layer transform, so committed ink is
    /// re-rasterized at the zoomed resolution instead of magnified as pixels.
    private func applyViewTransform(_ ctx: CGContext, model: StudioModel) {
        ctx.translateBy(x: bounds.width / 2 + model.viewOffset.width,
                        y: bounds.height / 2 + model.viewOffset.height)
        ctx.scaleBy(x: model.viewScale, y: model.viewScale)
        ctx.translateBy(x: -bounds.width / 2, y: -bounds.height / 2)
    }

    override func draw(_ rect: CGRect) {
        guard let model, let ctx = UIGraphicsGetCurrentContext() else { return }

        // The cache is rendered at the backing store's exact geometry WITH the
        // view transform already baked in, so it blits 1:1 at `bounds`.
        rebuildCommittedIfNeeded(model: model)
        committedImage?.draw(in: bounds)

        // Overlays are live, so they ride the transform here instead.
        ctx.saveGState()
        applyViewTransform(ctx, model: model)

        // The live stroke can only live on top when the active layer is the
        // top-most VISIBLE one at full opacity; otherwise it has to be rendered
        // in its true place in the stack, which means repainting everything.
        // When the active layer is HIDDEN the stroke is not drawn at all — what
        // you see while drawing is what commits.
        if let stroke = liveStroke, !stroke.pts.isEmpty, liveOnOverlay(model) {
            var shown = stroke
            shown.pts += predictedPts
            KaleidoRenderer.paint([shown], sym: model.activeLayer.sym, in: ctx,
                                  size: bounds.size, half: half)
        }

        if let hit = model.pendingHit,
           let layer = findLayer(model.drawing, hit.layerId),
           hit.index < layer.strokes.count {
            KaleidoRenderer.highlightStroke(layer.strokes[hit.index], sym: layer.sym, in: ctx,
                                            size: bounds.size, half: half,
                                            color: Self.accent(model.background))
        }

        if let hover = hoverPoint {
            let radius = CGFloat(model.size) * (half / CGFloat(REFERENCE_HALF)) / 2
            KaleidoRenderer.drawHoverRing(at: hover, radius: radius, sym: model.activeLayer.sym,
                                          in: ctx, size: bounds.size, half: half,
                                          color: Self.accent(model.background))
        }
        ctx.restoreGState()
    }

    /// See the web's `liveOnOverlay`: painting the stroke separately is only the
    /// same picture as compositing it into its layer when that layer is the top
    /// visible one at opacity 1.
    private func liveOnOverlay(_ model: StudioModel) -> Bool {
        let active = model.activeLayer
        guard active.visible, active.opacity == 1 else { return false }
        return topVisibleLayerId(model.drawing) == active.id
    }

    private static func accent(_ bg: Background) -> UIColor {
        (bg == .dark ? UIColor.white : UIColor.black).withAlphaComponent(0.55)
    }

    private func signature(for model: StudioModel) -> Int {
        var h = Hasher()
        h.combine(model.revision)
        h.combine(Int(bounds.width.rounded()))
        h.combine(Int(bounds.height.rounded()))
        h.combine(contentScaleFactor)
        h.combine(model.showGuides)
        h.combine(model.viewScale)
        h.combine(model.viewOffset.width)
        h.combine(model.viewOffset.height)
        // Layer identity is folded in explicitly: `revision` covers every model
        // mutation, but the cache also has to notice a live-stroke layer switch
        // that did not change the document.
        h.combine(model.activeLayerId)
        return h.finalize()
    }

    /// Rasterize background + guides + the whole layered drawing, INCLUDING the
    /// live stroke when it cannot ride the overlay. The image matches the view's
    /// backing store exactly, so `draw(in: bounds)` is a 1:1 blit.
    private func rebuildCommittedIfNeeded(model: StudioModel) {
        // A stroke rendered inside the stack changes the picture every frame, so
        // it can never be cached — the whole point of the cache is that it does
        // not move. Force a miss for as long as one is in flight.
        let inStack = liveStroke != nil && !liveOnOverlay(model)
        let sig = signature(for: model)
        if !inStack, sig == cacheSignature, committedImage != nil { return }
        cacheSignature = inStack ? .min : sig

        let size = bounds.size
        guard size.width > 0, size.height > 0 else { committedImage = nil; return }
        let format = UIGraphicsImageRendererFormat()
        format.opaque = true
        format.scale = contentScaleFactor
        let px = pixelSize
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        committedImage = renderer.image { rendererCtx in
            let c = rendererCtx.cgContext
            // Background fills the whole view; only the art is zoomed, so the
            // fill happens before the transform.
            KaleidoRenderer.fillBackground(model.background, in: c, size: size)
            applyViewTransform(c, model: model)
            if model.showGuides {
                drawGuides(in: c, size: size, sym: model.activeLayer.sym, bg: model.background)
            }
            let live = inStack && liveStroke != nil
                ? KaleidoRenderer.LiveStroke(withPredicted(liveStroke!), layerId: model.activeLayerId)
                : nil
            KaleidoRenderer.paintDrawing(model.drawing, in: c, size: size, half: half,
                                         pixelSize: px, live: live)
        }
    }

    private func withPredicted(_ stroke: Stroke) -> Stroke {
        var s = stroke
        s.pts += predictedPts
        return s
    }

    /// Faint wedge guides for the ACTIVE layer's symmetry — they are an aid for
    /// the stroke about to be made, not a description of the whole piece.
    private func drawGuides(in ctx: CGContext, size: CGSize, sym: Symmetry, bg: Background) {
        let cx = size.width / 2, cy = size.height / 2
        let radius = min(size.width, size.height) / 2
        let ink = (bg == .dark ? UIColor.white : UIColor.black).withAlphaComponent(0.10)
        ctx.saveGState()
        ctx.setStrokeColor(ink.cgColor)
        ctx.setLineWidth(1)
        let step = (CGFloat.pi * 2) / CGFloat(sym.segments)
        for i in 0..<sym.segments {
            let a = CGFloat(i) * step
            ctx.beginPath()
            ctx.move(to: CGPoint(x: cx, y: cy))
            ctx.addLine(to: CGPoint(x: cx + cos(a) * radius, y: cy + sin(a) * radius))
            ctx.strokePath()
            if sym.mirror {
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

// MARK: - Apple Pencil

extension KaleidoCanvasView: UIPencilInteractionDelegate {
    /// Both delegate methods are implemented on purpose. UIKit calls the newer
    /// one when it exists and falls back to the deprecated one otherwise, and
    /// Swift does NOT warn on implementing a deprecated protocol requirement —
    /// so relying on the old one alone would be an unverifiable bet on the
    /// deployment SDK. The deployment target is 17.0, which is below the newer
    /// method's availability.
    @available(iOS 17.5, *)
    func pencilInteraction(_ interaction: UIPencilInteraction, didReceiveTap tap: UIPencilInteraction.Tap) {
        handlePencilTap()
    }

    func pencilInteractionDidTap(_ interaction: UIPencilInteraction) {
        handlePencilTap()
    }

    /// The system preference is honored, not overridden: a user who set the
    /// double-tap to "Off" in Settings gets nothing, and one who chose the color
    /// palette gets the color palette. Every other setting — including the two
    /// switch actions, which have no literal equivalent here — maps onto the app
    /// default, Remove-stroke ↔ previous tool. That default is only safe because
    /// Remove-stroke is two-phase: an accidental double-tap deletes nothing.
    private func handlePencilTap() {
        guard let model else { return }
        MainActor.assumeIsolated {
            switch UIPencilInteraction.preferredTapAction {
            case .ignore:
                return
            case .showColorPalette:
                NotificationCenter.default.post(name: .kaleidoShowColorPalette, object: nil)
            default:
                model.togglePencilAction()
            }
            refresh()
        }
    }
}

extension Notification.Name {
    /// Posted when the Pencil double-tap is configured (system-wide) to show the
    /// color palette. The studio UI owns the popover, so the canvas only asks.
    static let kaleidoShowColorPalette = Notification.Name("kaleido.showColorPalette")
}

// MARK: - Gesture arbitration

extension KaleidoCanvasView: UIGestureRecognizerDelegate {
    /// Pinch and two-finger pan must run together, or a zoom cannot be re-centred
    /// without lifting off.
    func gestureRecognizer(_ g: UIGestureRecognizer,
                           shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        !(g is UITapGestureRecognizer) && !(other is UITapGestureRecognizer)
    }

    /// A Pencil never zooms, pans or double-tap-resets: those are finger
    /// gestures, so the Pencil can keep drawing while a hand rests on the glass.
    ///
    /// The double-tap is additionally live ONLY while zoomed. A tap recognizer
    /// holds `touchesEnded` back until it fails, which delayed every tapped dot
    /// by the double-tap interval — measured, not assumed. At 1× there is nothing
    /// to reset, so refusing the touch there removes the delay from the case that
    /// is almost always the live one, and keeps the reset working where it means
    /// something. The alternative (`delaysTouchesEnded = false`) would let a real
    /// double-tap stamp two stray dots before resetting.
    func gestureRecognizer(_ g: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        // Hover is a Pencil-only signal, so it must be exempted from the
        // no-pencil rule EXPLICITLY. It has no delegate today, which means this
        // method is not consulted for it — but that is incidental, and a future
        // `hover.delegate = self` would otherwise silently kill the hover ring,
        // the one requirement here that no simulator can catch.
        if g is UIHoverGestureRecognizer { return true }
        guard touch.type != .pencil else { return false }
        if g is UITapGestureRecognizer { return (model?.viewScale ?? 1) != 1 }
        return true
    }
}

/// SwiftUI wrapper for the canvas, plus the one-time Pencil banner.
struct DrawingCanvas: View {
    @ObservedObject var model: StudioModel

    var body: some View {
        ZStack(alignment: .top) {
            CanvasRepresentable(model: model)
            if model.showPencilBanner {
                pencilBanner
                    .padding(12)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
    }

    /// Shown once, ever, the first time a Pencil is used: the moment the offer to
    /// stop drawing with fingers is actually useful. Never inferred per session —
    /// the toggle it sets is persisted (PLAN §1).
    private var pencilBanner: some View {
        HStack(spacing: 10) {
            Image(systemName: "applepencil.tip")
                .accessibilityHidden(true)
            Text("Use fingers to pan and zoom instead?")
                .font(.footnote)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 4)
            Button("Turn off") {
                model.drawWithFinger = false
                model.dismissPencilBanner()
            }
            .font(.footnote.weight(.semibold))
            Button {
                model.dismissPencilBanner()
            } label: {
                Image(systemName: "xmark")
            }
            .accessibilityLabel("Dismiss")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .shadow(radius: 6, y: 2)
    }
}

private struct CanvasRepresentable: UIViewRepresentable {
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
