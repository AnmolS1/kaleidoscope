import SwiftUI

// The studio's nudges (DESIGN.md §3, frames FirstRun / Nudges / IPadBrush).
//
// Copy is VERBATIM from the spec — em dashes, the "▸" in the finger-pan string,
// the curly quotes around a layer name. These strings also ship on the web, and a
// nudge that says something slightly different on each platform is a nudge a user
// cannot learn.
//
// One at a time, bottom-leading, dismissed by the next stroke or after 6 seconds.

enum StudioNudge: Equatable {
    /// First Pencil touch. Offers the finger-pan switch where it is finally useful.
    case pencilDetected
    /// Confirmation after `drawWithFinger` goes off.
    case fingersPan
    /// A new layer inherited the layer it was added above.
    case newLayerSymmetry(String)
    /// Remove-stroke retargeted the active layer.
    case switchedLayer(String)
    /// A stroke was refused because the active layer is hidden.
    ///
    /// **UNWIRED.** Nothing raises this. The refusal it reports does not exist:
    /// `StudioModel.commit` appends to the active layer whatever its `visible`
    /// flag, and `StudioModel.swift` is T11's file. The copy is kept verbatim
    /// here — with its CTA and its handler in `StudioView.nudgeAction` — so that
    /// adding `guard activeLayer.visible` to `commit` is the only change needed
    /// to switch it on. It is deliberately NOT raised in the meantime: "nothing
    /// was drawn" is a false statement while the stroke is landing, which is
    /// worse than showing no nudge at all.
    case hiddenLayer(String)

    var systemImage: String {
        switch self {
        case .pencilDetected: return "applepencil.tip"
        case .fingersPan: return "hand.draw"
        case .newLayerSymmetry: return "square.3.layers.3d"
        case .switchedLayer: return "square.3.layers.3d"
        case .hiddenLayer: return "eye.slash"
        }
    }

    var message: String {
        switch self {
        case .pencilDetected:
            return "Apple Pencil detected — tune pressure in Brush."
        case .fingersPan:
            return "Finger touches now pan and zoom. Change in Brush ▸ Draw with finger."
        case .newLayerSymmetry:
            return "New layer inherits this layer's symmetry. Tap the badge to change it."
        case .switchedLayer(let name):
            return "Switched to \(name)"
        case .hiddenLayer(let name):
            return "\u{201C}\(name)\u{201D} is hidden, so nothing was drawn."
        }
    }

    /// The chip CTA, if this nudge has one.
    var actionTitle: String? {
        switch self {
        case .pencilDetected: return "Open Brush"
        case .hiddenLayer: return "Show layer"
        default: return nil
        }
    }

    /// Nudges that report a completed action are announced but not dwelt on;
    /// `switchedLayer` in particular fires mid-gesture during remove-stroke.
    var dismissAfter: TimeInterval {
        switch self {
        case .switchedLayer: return 2.5
        default: return 6
        }
    }

    /// Whether "dismiss on the next stroke" applies.
    ///
    /// It cannot apply to a nudge the current stroke RAISED. `pencilDetected`
    /// fires from `touchesBegan`; the same touch then commits, `revision` moves,
    /// and the nudge would dismiss itself before anyone could read it — visible
    /// for the length of one stroke, in the only flow that ever shows it.
    /// `switchedLayer` is the same shape mid-remove-gesture. Both fall back to
    /// their timer, which DESIGN.md §3 offers as the alternative ("dismiss on the
    /// next stroke or 6s").
    var dismissesOnEdit: Bool {
        switch self {
        case .pencilDetected, .switchedLayer: return false
        default: return true
        }
    }
}

/// Holds the one visible nudge and its auto-dismiss timer.
///
/// A single slot, not a queue: DESIGN.md says one at a time, and a queue would
/// keep showing a nudge about a state the user has already moved past.
@MainActor
final class NudgeCenter: ObservableObject {
    @Published private(set) var current: StudioNudge?
    private var token = 0
    /// The document revision when the current nudge was shown.
    private var shownAtRevision = 0

    func show(_ nudge: StudioNudge, atRevision revision: Int) {
        current = nudge
        shownAtRevision = revision
        token += 1
        let mine = token
        let delay = nudge.dismissAfter
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard let self, self.token == mine else { return }
            self.current = nil
        }
    }

    func dismiss() {
        token += 1
        current = nil
    }

    /// "Dismiss on the next stroke" (DESIGN.md §3).
    ///
    /// Two guards, for two different races. `dismissesOnEdit` excludes nudges the
    /// in-flight stroke itself raised. The revision comparison excludes the edit
    /// that raised the nudge SYNCHRONOUSLY — adding a layer bumps `revision` and
    /// then shows `newLayerSymmetry`, and SwiftUI may deliver the `onChange` for
    /// that same bump afterwards, which would dismiss a nudge one frame old.
    func dismissOnEdit(revision: Int) {
        guard let nudge = current, nudge.dismissesOnEdit, revision != shownAtRevision else { return }
        dismiss()
    }
}
