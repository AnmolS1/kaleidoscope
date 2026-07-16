import SwiftUI
import KaleidoEngine

/// Observable state for the drawing studio: current brush settings, symmetry, the
/// committed strokes, and undo/redo history. Mirrors the web studio controls.
@MainActor
final class StudioModel: ObservableObject {
    // Brush
    @Published var tool: BrushTool = .solid
    /// Selected solid color (used when `useSpectrum` is off).
    @Published var color: String = "#E84A27" // crane
    @Published var useSpectrum: Bool = false
    @Published var size: Double = 14
    @Published var opacity: Double = 1

    // Symmetry / canvas
    @Published var segments: Int = 8
    @Published var mirror: Bool = true
    @Published var background: Background = .light
    @Published var showGuides: Bool = true

    /// Set when the current drawing was loaded from an existing piece (remix), so
    /// Save can record `remixOf`. Cleared when the canvas is reset/loaded fresh.
    @Published var remixSourceId: String?

    // Strokes + history (snapshots; committed strokes are never mutated).
    @Published private(set) var strokes: [Stroke] = []
    private var undoStack: [[Stroke]] = []
    private var redoStack: [[Stroke]] = []
    private let maxHistory = 250

    /// A monotonically-increasing token so the canvas knows when committed
    /// content changed (commit/undo/redo/clear/load) and must re-rasterize.
    @Published private(set) var revision = 0

    var canUndo: Bool { !undoStack.isEmpty }
    var canRedo: Bool { !redoStack.isEmpty }
    var isEmpty: Bool { strokes.isEmpty }

    /// The color a new stroke should use given the spectrum toggle.
    var effectiveColor: String { useSpectrum ? "spectrum" : color }

    var symmetry: Symmetry { Symmetry(segments: segments, mirror: mirror) }

    /// Snapshot the current drawing (for export / save / preview).
    func currentDrawing() -> Drawing {
        Drawing(bg: background, sym: symmetry, strokes: strokes)
    }

    // ---- editing --------------------------------------------------------

    func commit(_ stroke: Stroke) {
        guard stroke.pts.count >= 1 else { return }
        pushHistory()
        strokes.append(stroke)
        redoStack.removeAll()
        revision += 1
    }

    func undo() {
        guard let prev = undoStack.popLast() else { return }
        redoStack.append(strokes)
        strokes = prev
        revision += 1
    }

    func redo() {
        guard let next = redoStack.popLast() else { return }
        undoStack.append(strokes)
        strokes = next
        revision += 1
    }

    func clear() {
        guard !strokes.isEmpty else { return }
        pushHistory()
        strokes = []
        redoStack.removeAll()
        remixSourceId = nil
        revision += 1
    }

    /// Load a drawing (e.g. remix): replaces content + settings, resets history.
    /// Clears any prior remix source; the caller sets `remixSourceId` after if this
    /// load is itself a remix.
    func load(_ drawing: Drawing) {
        strokes = drawing.strokes
        background = drawing.bg
        segments = clampSegments(drawing.sym.segments)
        mirror = drawing.sym.mirror
        remixSourceId = nil
        undoStack.removeAll()
        redoStack.removeAll()
        revision += 1
    }

    private func pushHistory() {
        undoStack.append(strokes)
        if undoStack.count > maxHistory { undoStack.removeFirst(undoStack.count - maxHistory) }
    }

    /// Mock-data mode: load a sample mandala so the studio (and the renderer) can
    /// be exercised with no drawing input — used for screenshots / smoke tests.
    /// Enabled when the app is launched with KALEIDO_DEMO=1.
    static var demoRequested: Bool {
        ProcessInfo.processInfo.environment["KALEIDO_DEMO"] == "1"
    }

    func loadDemo() {
        var demoStrokes: [Stroke] = []
        // A spectrum glow ribbon spiraling outward.
        demoStrokes.append(Stroke(tool: .glow, color: "spectrum", size: 26, opacity: 0.85,
            pts: (0..<40).map { i in
                let t = Double(i) / 39
                let r = 0.12 + 0.72 * t
                let a = t * 3.4
                return StrokePoint(x: r * cos(a), y: r * sin(a), pressure: 0.4 + 0.5 * sin(t * 3))
            }))
        // A solid crane stroke.
        demoStrokes.append(Stroke(tool: .solid, color: "#E84A27", size: 12, opacity: 1,
            pts: (0..<20).map { i in
                let t = Double(i) / 19
                return StrokePoint(x: 0.2 + 0.55 * t, y: -0.15 + 0.1 * sin(t * 8), pressure: 0.7)
            }))
        // A gold dot cluster.
        demoStrokes.append(Stroke(tool: .solid, color: "#D9A521", size: 30, opacity: 0.9,
            pts: [StrokePoint(x: 0.55, y: 0.2, pressure: 1)]))
        load(Drawing(bg: background, sym: symmetry, strokes: demoStrokes))
    }
}
