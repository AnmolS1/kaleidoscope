import SwiftUI
import KaleidoEngine

// The undoable document + the studio's observable state.
//
// This is the native mirror of the web's `src/client/engine/history.ts`
// (`DrawingDoc`) plus the tool-state half of `scene.ts`. The two clients write
// the same file format, so they must also agree on what an edit MEANS — which
// layer a stroke lands on, what a "clear" keeps, and above all which edits are
// undoable. Those rules are duplicated here deliberately rather than being left
// to each platform's taste, because a user who draws on the web and remixes on
// iPad must not find the undo stack behaving differently.
//
// What is and is not undoable (PLAN §4/T03, matched line for line):
//
//   in history      stroke commit, stroke delete, clear, add/remove/reorder/
//                   duplicate layer, layer opacity (COALESCED per gesture),
//                   layer symmetry change
//   not in history  layer visibility toggle, layer rename, background,
//                   active-layer change
//
// Visibility and rename are label/view edits a user flips constantly while
// working; burying real work under twenty eye-toggles is worse than not being
// able to undo them. Remove-layer IS undoable, which is why the UI needs no
// confirm dialog for it.

// MARK: - Pure drawing operations
//
// Each returns a NEW drawing and never touches its input, so a history snapshot
// is a shallow copy: Swift arrays are copy-on-write, so an 8-layer piece plus
// one stroke costs one layer array and one stroke array, not a copy of the ink.

func layerIndex(_ d: DrawingV2, _ id: String) -> Int? {
    d.layers.firstIndex { $0.id == id }
}

func findLayer(_ d: DrawingV2, _ id: String) -> Layer? {
    d.layers.first { $0.id == id }
}

/// Replace one layer via a mapper, leaving the rest untouched.
func withLayer(_ d: DrawingV2, _ id: String, _ fn: (Layer) -> Layer) -> DrawingV2? {
    guard let i = layerIndex(d, id) else { return nil }
    var out = d
    out.layers[i] = fn(out.layers[i])
    return out
}

/// Default name for a layer, derived from its positional id ("l3" → "Layer 3").
func defaultLayerName(_ id: String) -> String {
    "Layer \(id.dropFirst())"
}

/// A duplicate's name, truncated to whatever the shared validator accepts, so a
/// 40-unit name duplicated repeatedly can never produce an unsaveable drawing.
///
/// The web slices by UTF-16 code unit and leans on its `normalizeLayerName`
/// rejecting lone surrogates to skip a cut through the middle of a pair. Swift's
/// `normalizeLayerName` has no lone-surrogate clause (it cannot need one — see
/// its doc comment), so a literal port of that loop would ACCEPT a half pair the
/// web rejects. Dropping whole `Character`s instead is provably the same result:
/// every cut the web rejects is a mid-pair cut, and the cut below it is a
/// grapheme boundary, so both loops converge on the same string.
func copyName(_ name: String) -> String {
    var candidate = "\(name) copy"
    while !candidate.isEmpty {
        if let n = normalizeLayerName(candidate) { return n }
        candidate = String(candidate.dropLast())
    }
    return ""
}

func addStrokeTo(_ d: DrawingV2, layerId: String, stroke: Stroke) -> DrawingV2? {
    withLayer(d, layerId) { var l = $0; l.strokes.append(stroke); return l }
}

func deleteStrokeFrom(_ d: DrawingV2, layerId: String, index: Int) -> DrawingV2? {
    guard let layer = findLayer(d, layerId), index >= 0, index < layer.strokes.count else { return nil }
    return withLayer(d, layerId) { var l = $0; l.strokes.remove(at: index); return l }
}

/// Empty every layer's strokes, keeping the layer structure.
///
/// "Clear canvas" is about the ink, not the document: a user who has set up four
/// layers with different symmetries and wants a blank start keeps that setup.
/// Nil when there is nothing to clear, so the caller can skip the history entry.
func clearStrokesIn(_ d: DrawingV2) -> DrawingV2? {
    if d.layers.allSatisfy({ $0.strokes.isEmpty }) { return nil }
    var out = d
    for i in out.layers.indices where !out.layers[i].strokes.isEmpty {
        out.layers[i].strokes = []
    }
    return out
}

/// Insert a new empty layer directly above `aboveId`, inheriting its symmetry.
func addLayerAbove(_ d: DrawingV2, aboveId: String) -> (drawing: DrawingV2, id: String)? {
    guard d.layers.count < MAX_LAYERS, let id = try? nextLayerId(d.layers) else { return nil }
    let at = layerIndex(d, aboveId) ?? d.layers.count - 1
    var out = d
    out.layers.insert(
        Layer(id: id, name: defaultLayerName(id), visible: true, opacity: 1,
              sym: d.layers[at].sym, strokes: []),
        at: at + 1
    )
    return (out, id)
}

func duplicateLayerIn(_ d: DrawingV2, id: String) -> (drawing: DrawingV2, id: String)? {
    guard d.layers.count < MAX_LAYERS,
          let i = layerIndex(d, id),
          let newId = try? nextLayerId(d.layers) else { return nil }
    var copy = d.layers[i]
    copy.id = newId
    copy.name = copyName(d.layers[i].name)
    var out = d
    out.layers.insert(copy, at: i + 1)
    return (out, newId)
}

/// Remove a layer. Never goes below one — a drawing always has a layer.
func removeLayerFrom(_ d: DrawingV2, id: String) -> DrawingV2? {
    guard d.layers.count > 1, let i = layerIndex(d, id) else { return nil }
    var out = d
    out.layers.remove(at: i)
    return out
}

/// Move a layer to a new index in the bottom → top order.
func moveLayerIn(_ d: DrawingV2, id: String, toIndex: Int) -> DrawingV2? {
    guard let from = layerIndex(d, id) else { return nil }
    let to = max(0, min(d.layers.count - 1, toIndex))
    if to == from { return nil }
    var out = d
    let layer = out.layers.remove(at: from)
    out.layers.insert(layer, at: to)
    return out
}

/// The layer a freshly loaded drawing should start on: the top-most VISIBLE one.
/// Starting on a hidden layer would silently swallow the user's first stroke.
func topVisibleLayerId(_ d: DrawingV2) -> String {
    for layer in d.layers.reversed() where layer.visible { return layer.id }
    return d.layers[d.layers.count - 1].id
}

/// Upgrade a v1 drawing to the exact single-layer shape §2.1 specifies. The same
/// shape `emptyDrawingV2` produces, so a v1 piece and a fresh canvas are
/// indistinguishable to everything downstream.
func upgradeToV2(_ d: Drawing) -> DrawingV2 {
    DrawingV2(bg: d.bg, layers: [
        Layer(id: "l1", name: "Layer 1", visible: true, opacity: 1, sym: d.sym, strokes: d.strokes)
    ])
}

// MARK: - Snapshot stack

/// Whole-drawing undo. v1 snapshotted a stroke array; v2 cannot, because a layer
/// reorder and an opacity change are both undoable and neither is expressible as
/// a stroke list.
final class DrawingHistory {
    private var past: [DrawingV2] = []
    private var future: [DrawingV2] = []
    private(set) var current: DrawingV2
    private let maxDepth = 250

    /// The gesture the top entry belongs to, or nil. Two commits with the same
    /// key in a row collapse into one undo step — that is what makes an opacity
    /// drag a single undo rather than forty.
    private var coalesceKey: String?

    init(_ initial: DrawingV2) { current = initial }

    var canUndo: Bool { !past.isEmpty }
    var canRedo: Bool { !future.isEmpty }

    func commit(_ next: DrawingV2, coalesceKey key: String? = nil) {
        if let key, key == coalesceKey {
            current = next
            future = []
            return
        }
        past.append(current)
        if past.count > maxDepth { past.removeFirst(past.count - maxDepth) }
        current = next
        future = []
        coalesceKey = key
    }

    /// Seal the current gesture so the next change starts a new undo step.
    func endCoalesce() { coalesceKey = nil }

    /// Change the state WITHOUT an undo entry (visibility, rename, background).
    func replace(_ next: DrawingV2) {
        current = next
        // A non-undoable edit still ends a gesture: coalescing an opacity drag
        // into a state the user has since renamed would undo the rename too.
        coalesceKey = nil
    }

    func undo() -> Bool {
        guard let prev = past.popLast() else { return false }
        future.append(current)
        current = prev
        coalesceKey = nil
        return true
    }

    func redo() -> Bool {
        guard let next = future.popLast() else { return false }
        past.append(current)
        current = next
        coalesceKey = nil
        return true
    }

    /// Replace the document and drop history — loading or remixing.
    func reset(_ d: DrawingV2) {
        past = []
        future = []
        current = d
        coalesceKey = nil
    }
}

// MARK: - The document

/// What a layers panel needs to render a row, without handing out the strokes.
struct LayerSummary: Identifiable, Equatable {
    let id: String
    let name: String
    let visible: Bool
    let opacity: Double
    let sym: Symmetry
    let strokeCount: Int
}

/// Where a hit test landed.
struct StrokeHit: Equatable {
    let layerId: String
    let index: Int
}

/// The drawing plus its history plus the active layer. Headless — no UIKit, no
/// canvas — so every layer rule and undo rule is exercised by the model alone.
///
/// `layerCap` comes from app state (3 free / 8 Plus; T13 wires it from
/// `/api/me.plus`). It gates ADDING layers only: opening, editing and saving a
/// piece that already has more layers than the cap has to keep working, because
/// a free user remixing a Plus piece is an explicitly supported flow (PLAN §1).
final class DrawingDoc {
    private var hist: DrawingHistory
    private(set) var activeLayerId: String
    private(set) var layerCap: Int

    init(_ drawing: DrawingV2? = nil, layerCap: Int = 3) {
        let d = drawing ?? emptyDrawingV2(bg: .light, sym: Symmetry(segments: 8, mirror: true))
        hist = DrawingHistory(d)
        activeLayerId = topVisibleLayerId(d)
        self.layerCap = DrawingDoc.clampCap(layerCap)
    }

    // --- reads ---
    var drawing: DrawingV2 { hist.current }
    var layers: [Layer] { hist.current.layers }
    var activeLayer: Layer { findLayer(hist.current, activeLayerId) ?? hist.current.layers[0] }
    var canUndo: Bool { hist.canUndo }
    var canRedo: Bool { hist.canRedo }

    /// Total strokes across every layer, hidden ones included — the same number
    /// the web reports, so both clients describe a piece identically.
    var totalStrokes: Int { strokeCount(hist.current) }

    /// Strokes on VISIBLE layers only. See `StudioModel.isEmpty`.
    var visibleStrokes: Int {
        hist.current.layers.reduce(0) { $0 + ($1.visible ? $1.strokes.count : 0) }
    }

    var canAddLayer: Bool { hist.current.layers.count < min(layerCap, MAX_LAYERS) }

    func summaries() -> [LayerSummary] {
        hist.current.layers.map {
            LayerSummary(id: $0.id, name: $0.name, visible: $0.visible,
                         opacity: $0.opacity, sym: $0.sym, strokeCount: $0.strokes.count)
        }
    }

    // --- document-level ---
    func setLayerCap(_ n: Int) { layerCap = DrawingDoc.clampCap(n) }

    func load(_ d: DrawingV2) {
        hist.reset(d)
        activeLayerId = topVisibleLayerId(d)
    }

    /// Background is a property of the drawing but not an ink edit; it rides
    /// outside history the same way the theme toggle always has.
    @discardableResult
    func setBackground(_ bg: Background) -> Bool {
        guard hist.current.bg != bg else { return false }
        var next = hist.current
        next.bg = bg
        hist.replace(next)
        return true
    }

    func undo() -> Bool {
        guard hist.undo() else { return false }
        reseatActive()
        return true
    }

    func redo() -> Bool {
        guard hist.redo() else { return false }
        reseatActive()
        return true
    }

    // --- strokes ---
    func commitStroke(_ stroke: Stroke) -> Bool {
        guard let next = addStrokeTo(hist.current, layerId: activeLayerId, stroke: stroke) else { return false }
        hist.commit(next)
        return true
    }

    func deleteStroke(layerId: String, index: Int) -> Bool {
        guard let next = deleteStrokeFrom(hist.current, layerId: layerId, index: index) else { return false }
        hist.commit(next)
        return true
    }

    func clearStrokes() -> Bool {
        guard let next = clearStrokesIn(hist.current) else { return false }
        hist.commit(next)
        return true
    }

    // --- layers ---
    /// Add a layer above the active one, inheriting its symmetry. Nil at the cap.
    func addLayer() -> String? {
        guard canAddLayer, let r = addLayerAbove(hist.current, aboveId: activeLayerId) else { return nil }
        hist.commit(r.drawing)
        activeLayerId = r.id
        return r.id
    }

    func duplicateLayer(_ id: String? = nil) -> String? {
        guard canAddLayer, let r = duplicateLayerIn(hist.current, id: id ?? activeLayerId) else { return nil }
        hist.commit(r.drawing)
        activeLayerId = r.id
        return r.id
    }

    func removeLayer(_ id: String? = nil) -> Bool {
        let target = id ?? activeLayerId
        let i = layerIndex(hist.current, target)
        guard let next = removeLayerFrom(hist.current, id: target) else { return false }
        hist.commit(next)
        if activeLayerId == target, let i {
            // Fall to whatever now occupies that slot, or the new top.
            activeLayerId = next.layers[min(i, next.layers.count - 1)].id
        }
        return true
    }

    func moveLayer(_ id: String, toIndex: Int) -> Bool {
        guard let next = moveLayerIn(hist.current, id: id, toIndex: toIndex) else { return false }
        hist.commit(next)
        return true
    }

    func setActiveLayer(_ id: String) -> Bool {
        guard id != activeLayerId, layerIndex(hist.current, id) != nil else { return false }
        activeLayerId = id
        return true
    }

    /// Visibility is deliberately NOT undoable — see the file header.
    func setLayerVisible(_ id: String, _ visible: Bool) -> Bool {
        guard let layer = findLayer(hist.current, id), layer.visible != visible,
              let next = withLayer(hist.current, id, { var l = $0; l.visible = visible; return l })
        else { return false }
        hist.replace(next)
        return true
    }

    /// Rename is deliberately NOT undoable. Rejects names the format won't store.
    ///
    /// `normalizeLayerName` is called HERE, where the user commits the name, and
    /// not on the parse path. `serialize` emits `layer.name` verbatim, so a name
    /// held in decomposed form would serialize to bytes that re-parse as NFC —
    /// different bytes, different content hash, and dedupe silently stops
    /// recognizing the piece as itself. Normalizing at the commit point is what
    /// keeps the stored bytes and the re-read bytes identical.
    func setLayerName(_ id: String, _ raw: String) -> Bool {
        guard let name = normalizeLayerName(raw),
              let layer = findLayer(hist.current, id), layer.name != name,
              let next = withLayer(hist.current, id, { var l = $0; l.name = name; return l })
        else { return false }
        hist.replace(next)
        return true
    }

    /// Layer opacity. `coalesce` merges consecutive changes to the same layer
    /// into one undo step, so a slider drag is one entry; call
    /// `endOpacityGesture` on release to seal it.
    func setLayerOpacity(_ id: String, _ value: Double, coalesce: Bool = false) -> Bool {
        let opacity = max(0, min(1, value))
        guard let layer = findLayer(hist.current, id), layer.opacity != opacity,
              let next = withLayer(hist.current, id, { var l = $0; l.opacity = opacity; return l })
        else { return false }
        hist.commit(next, coalesceKey: coalesce ? "opacity:\(id)" : nil)
        return true
    }

    func endOpacityGesture() { hist.endCoalesce() }

    func setLayerSym(_ id: String, _ sym: Symmetry) -> Bool {
        let segments = clampSegments(sym.segments)
        guard let layer = findLayer(hist.current, id),
              layer.sym != Symmetry(segments: segments, mirror: sym.mirror),
              let next = withLayer(hist.current, id, {
                  var l = $0; l.sym = Symmetry(segments: segments, mirror: sym.mirror); return l
              })
        else { return false }
        hist.commit(next)
        return true
    }

    /// Apply one symmetry to every layer (the popover's "Apply to all layers").
    func setAllSym(_ sym: Symmetry) -> Bool {
        let target = Symmetry(segments: clampSegments(sym.segments), mirror: sym.mirror)
        var next = hist.current
        guard !next.layers.allSatisfy({ $0.sym == target }) else { return false }
        for i in next.layers.indices { next.layers[i].sym = target }
        hist.commit(next)
        return true
    }

    /// After undo/redo the active layer may no longer exist.
    private func reseatActive() {
        if layerIndex(hist.current, activeLayerId) == nil {
            activeLayerId = topVisibleLayerId(hist.current)
        }
    }

    private static func clampCap(_ n: Int) -> Int { max(1, min(MAX_LAYERS, n)) }
}

// MARK: - Studio state

/// Observable state for the drawing studio: brush settings, the layered document
/// with its undo history, capture preferences, and the view transform. Mirrors
/// the web studio's `state.ts` + `Scene.toolState`.
@MainActor
final class StudioModel: ObservableObject {
    // Brush
    @Published var tool: BrushTool = .solid
    /// Selected solid color (used when `useSpectrum` is off).
    @Published var color: String = "#E84A27" // crane
    @Published var useSpectrum: Bool = false
    @Published var size: Double = 14
    @Published var opacity: Double = 1

    // Canvas chrome
    @Published var showGuides: Bool = true

    /// Remove-stroke: a two-phase eraser. The first tap highlights every image of
    /// the stroke it hit; the second (or Delete) removes it. Two-phase is why the
    /// Pencil double-tap can safely default to toggling it — an accidental
    /// double-tap followed by an accidental tap still deletes nothing.
    @Published var removeStrokeMode: Bool = false
    @Published var pendingHit: StrokeHit?

    /// Set when the current drawing was loaded from an existing piece (remix), so
    /// Save can record `remixOf`. Cleared when the canvas is reset/loaded fresh.
    @Published var remixSourceId: String?

    // Capture preferences — persisted, and keyed identically to the web's
    // localStorage so the two clients read as one product.
    @Published var pressurePreset: PressurePreset = .normal {
        didSet { UserDefaults.standard.set(pressurePreset.rawValue, forKey: Keys.pressurePreset) }
    }
    /// `po`: pressure also scales alpha. Pen input only, and off by default —
    /// on is a change from v1 behavior, so the user opts in.
    @Published var pressureOpacity: Bool = false {
        didSet { UserDefaults.standard.set(pressureOpacity, forKey: Keys.pressureOpacity) }
    }
    /// When off, a finger pans and zooms and only a Pencil draws. Persisted and
    /// never inferred per session (PLAN §1).
    /// Whether NEW strokes are smoothed. Default on, mirroring the web.
    ///
    /// Per-stroke rather than per-document: turning it off makes later strokes
    /// omit `sm` and render as polylines, exactly as every v1 stroke does, so
    /// both kinds coexist in one drawing. It never alters a committed stroke —
    /// the stored PNG of a saved piece has to keep matching it.
    @Published var smoothStrokes: Bool = true {
        didSet { UserDefaults.standard.set(smoothStrokes, forKey: Keys.smoothStrokes) }
    }

    @Published var drawWithFinger: Bool = true {
        didSet { UserDefaults.standard.set(drawWithFinger, forKey: Keys.drawWithFinger) }
    }
    /// Shown once, the first time a Pencil touches the canvas, offering to turn
    /// `drawWithFinger` off. Dismissal is persisted.
    /// Whether a Pencil has ever been used on this device.
    ///
    /// The brush popover keeps its pressure controls hidden until this is true:
    /// the preset and `po` are both pencil-only, so on a finger those controls
    /// would be settings that shape nothing.
    ///
    /// Deliberately SEPARATE from `pencilBannerSeen`, which means "we have shown
    /// the one-time banner". The two happen to latch at the same moment today,
    /// and conflating them would break the first time either grows a reason to
    /// reset — and the banner only ever fires on a touch, where this must also
    /// catch a hover. Same key as the web's `kal.penSeen`.
    @Published private(set) var pencilSeen: Bool = false {
        didSet { UserDefaults.standard.set(pencilSeen, forKey: Keys.pencilSeen) }
    }

    /// Latch the Pencil. Safe to call on every pencil touch AND hover.
    func notePencilSeen() {
        guard !pencilSeen else { return }
        pencilSeen = true
    }

    @Published var showPencilBanner: Bool = false

    /// The name of the layer that refused the last stroke because it is hidden,
    /// or nil. The studio raises DESIGN.md §3's nudge from this and clears it.
    ///
    /// A NAME rather than an id: the nudge quotes it (`"Highlights" is hidden…`)
    /// and it is captured before the attempt, so a rename or a reorder between
    /// the refusal and the nudge cannot make the sentence describe a different
    /// layer than the one that refused. Same shape as the web's
    /// `onHiddenLayerRefusal(layerName)`.
    /// The layer that refused the last stroke, or nil.
    ///
    /// Carries the ID as well as the name because the two are used for
    /// different things and only one of them is a key: the nudge QUOTES the
    /// name, captured at the refusal so a later rename cannot make the sentence
    /// describe a different layer — but "Show layer" has to ACT, and looking the
    /// layer up by name would unhide whichever matched first. Rename lives in
    /// the layers panel, so two layers sharing a name is a state the user can
    /// reach. Matches the web's `onHiddenLayerRefusal(layerId, layerName)`.
    struct RefusedLayer: Equatable {
        let id: String
        let name: String
    }

    @Published var refusedHiddenLayer: RefusedLayer?

    // View transform (1–8×). Owned here rather than by the view so an export or
    // a save is never affected by it.
    @Published private(set) var viewScale: CGFloat = 1
    @Published private(set) var viewOffset: CGSize = .zero

    /// A monotonically-increasing token so the canvas knows when rendered content
    /// changed and must re-rasterize. Bumped by every mutation that changes
    /// pixels, INCLUDING the ones that are not undoable — an eye toggle is out of
    /// history but is emphatically not invisible.
    @Published private(set) var revision = 0

    private var doc: DrawingDoc

    private enum Keys {
        static let pressurePreset = "kal.pressurePreset"
        static let pressureOpacity = "kal.pressureOpacity"
        static let drawWithFinger = "kal.drawWithFinger"
        static let smoothStrokes = "kal.smoothStrokes"
        static let pencilBannerSeen = "kal.pencilBannerSeen"
        static let pencilSeen = "kal.penSeen"
    }

    init(layerCap: Int = 3) {
        // A launch-env override, so the layers panel can be driven at either cap
        // without pretending the free cap is something it is not. T12 needs both
        // states: the locked Add with the Plus footnote at 3, and the unlocked
        // panel at 8 for the App Store screenshots. Inert unless injected, like
        // the other KALEIDO_* test hooks, so it cannot affect a real launch.
        //
        // T13 replaces the DEFAULT with the value from /api/me.plus; this
        // override stays useful for tests either way.
        let cap = ProcessInfo.processInfo.environment["KALEIDO_LAYER_CAP"].flatMap(Int.init) ?? layerCap
        doc = DrawingDoc(layerCap: cap)
        let defaults = UserDefaults.standard
        if let raw = defaults.string(forKey: Keys.pressurePreset), let p = PressurePreset(rawValue: raw) {
            pressurePreset = p
        }
        if defaults.object(forKey: Keys.pressureOpacity) != nil {
            pressureOpacity = defaults.bool(forKey: Keys.pressureOpacity)
        }
        if defaults.object(forKey: Keys.drawWithFinger) != nil {
            drawWithFinger = defaults.bool(forKey: Keys.drawWithFinger)
        }
        if defaults.object(forKey: Keys.smoothStrokes) != nil {
            smoothStrokes = defaults.bool(forKey: Keys.smoothStrokes)
        }
        pencilSeen = defaults.bool(forKey: Keys.pencilSeen)
    }

    // MARK: Forwarding surface
    //
    // `segments`, `mirror` and `background` read and write the ACTIVE LAYER (or
    // the drawing) rather than living as their own stored state. StudioView binds
    // to them through `$model.segments` etc., which works because a settable
    // computed property on a class is still a writable key path.

    var segments: Int {
        get { doc.activeLayer.sym.segments }
        set {
            let s = clampSegments(newValue)
            guard s != doc.activeLayer.sym.segments else { return }
            mutate { $0.setLayerSym($0.activeLayerId, Symmetry(segments: s, mirror: $0.activeLayer.sym.mirror)) }
        }
    }

    var mirror: Bool {
        get { doc.activeLayer.sym.mirror }
        set {
            guard newValue != doc.activeLayer.sym.mirror else { return }
            mutate { $0.setLayerSym($0.activeLayerId, Symmetry(segments: $0.activeLayer.sym.segments, mirror: newValue)) }
        }
    }

    var background: Background {
        get { doc.drawing.bg }
        set { mutate { $0.setBackground(newValue) } }
    }

    /// The active layer's committed strokes. Kept for the pre-layers call
    /// surface; panels should use `layers` instead.
    var strokes: [Stroke] { doc.activeLayer.strokes }

    var symmetry: Symmetry { doc.activeLayer.sym }

    var canUndo: Bool { doc.canUndo }
    var canRedo: Bool { doc.canRedo }

    /// Total strokes across every layer, hidden included — mirrors the web's
    /// `strokeCount` so both clients describe the same piece the same way.
    var strokeCount: Int { doc.totalStrokes }

    /// DEVIATION from the web, deliberate. `isEmpty` gates Download and Save, and
    /// the web's equivalent guard counts hidden layers — so a drawing whose only
    /// ink sits on hidden layers passes it and uploads a blank image (recorded as
    /// the open defect owned by T06a). Counting only VISIBLE strokes here means
    /// iOS never grew the same bug. `strokeCount` still mirrors the web.
    var isEmpty: Bool { doc.visibleStrokes == 0 }

    /// The color a new stroke should use given the spectrum toggle.
    var effectiveColor: String { useSpectrum ? "spectrum" : color }

    // MARK: Layers

    var layers: [LayerSummary] { doc.summaries() }
    var activeLayerId: String { doc.activeLayerId }
    var activeLayer: Layer { doc.activeLayer }
    var layerCap: Int { doc.layerCap }
    var canAddLayer: Bool { doc.canAddLayer }
    var drawing: DrawingV2 { doc.drawing }

    /// T13 calls this once `/api/me.plus` lands. Raising the cap never changes an
    /// existing document; it only unlocks the add affordance.
    func setLayerCap(_ n: Int) {
        objectWillChange.send()
        doc.setLayerCap(n)
    }

    @discardableResult func addLayer() -> String? { mutateReturning { $0.addLayer() } }
    @discardableResult func duplicateLayer(_ id: String? = nil) -> String? { mutateReturning { $0.duplicateLayer(id) } }
    @discardableResult func removeLayer(_ id: String? = nil) -> Bool { mutate { $0.removeLayer(id) } }
    @discardableResult func moveLayer(_ id: String, toIndex: Int) -> Bool { mutate { $0.moveLayer(id, toIndex: toIndex) } }
    @discardableResult func setActiveLayer(_ id: String) -> Bool { mutate { $0.setActiveLayer(id) } }
    @discardableResult func setLayerVisible(_ id: String, _ visible: Bool) -> Bool { mutate { $0.setLayerVisible(id, visible) } }
    @discardableResult func setLayerName(_ id: String, _ name: String) -> Bool { mutate { $0.setLayerName(id, name) } }
    @discardableResult func setLayerSym(_ id: String, _ sym: Symmetry) -> Bool { mutate { $0.setLayerSym(id, sym) } }
    @discardableResult func setAllSym(_ sym: Symmetry) -> Bool { mutate { $0.setAllSym(sym) } }

    @discardableResult
    func setLayerOpacity(_ id: String, _ value: Double, coalesce: Bool = false) -> Bool {
        mutate { $0.setLayerOpacity(id, value, coalesce: coalesce) }
    }

    /// Seal an opacity drag so the next change starts a fresh undo step.
    func endLayerOpacityGesture() { doc.endOpacityGesture() }

    // MARK: Strokes

    /// Commit a stroke to the active layer — or refuse it, if that layer is
    /// hidden.
    ///
    /// **A hidden layer refuses ink; it is never auto-unhidden** (PLAN §4,
    /// DESIGN.md §3). Before this guard, a stroke drawn while the active layer
    /// was hidden landed anyway: `KaleidoCanvasView` already declines to draw it
    /// ("what you see while drawing is what commits"), so the user watched
    /// nothing appear while the ink silently entered the document, counted toward
    /// `strokeCount`, and shipped in the saved vector. The web had the same
    /// defect in `history.ts`; both clients now refuse identically.
    ///
    /// Three properties this has to keep, matched to the web's implementation:
    ///
    /// - **No undo step.** Returning early rather than calling `mutate` is what
    ///   guarantees it: a history entry holding no change leaves the user
    ///   pressing undo and watching nothing happen.
    /// - **The stroke is dropped** — not committed and hidden, not deferred.
    /// - **The refusal names the layer**, captured BEFORE the attempt.
    ///
    /// The empty-stroke guard stays FIRST, deliberately: a zero-point stroke is a
    /// stray tap, not a refusal, and firing the nudge for one would make the most
    /// common accidental gesture produce a message about layers.
    func commit(_ stroke: Stroke) {
        guard !stroke.pts.isEmpty else { return }
        let active = doc.activeLayer
        guard active.visible else {
            refusedHiddenLayer = RefusedLayer(id: active.id, name: active.name)
            return
        }
        mutate { $0.commitStroke(stroke) }
    }

    /// Called by the studio once it has raised the refusal nudge.
    func clearHiddenLayerRefusal() { refusedHiddenLayer = nil }

    @discardableResult
    func deleteStroke(layerId: String, index: Int) -> Bool {
        let ok = mutate { $0.deleteStroke(layerId: layerId, index: index) }
        if ok { pendingHit = nil }
        return ok
    }

    /// The stroke under a normalized point, searching visible layers top-first
    /// and, within a layer, the newest stroke first — the order a user reads the
    /// stack. `tolerance` is extra slack in normalized units.
    func hitTestStroke(x: Double, y: Double, tolerance: Double) -> StrokeHit? {
        hitTestDrawing(doc.drawing, x: x, y: y, tolerance: tolerance)
    }

    func undo() { _ = mutate { $0.undo() } }
    func redo() { _ = mutate { $0.redo() } }

    func clear() {
        _ = mutate { $0.clearStrokes() }
    }

    // MARK: Loading

    /// Load a v2 drawing (remix or restore): replaces content + settings, resets
    /// history. Clears any prior remix source; the caller sets `remixSourceId`
    /// after if this load is itself a remix.
    func load(_ drawing: DrawingV2) {
        objectWillChange.send()
        doc.load(drawing)
        remixSourceId = nil
        resetView()
        pendingHit = nil
        revision += 1
    }

    /// v1 entry point — upgrades to the single-layer v2 shape §2.1 specifies.
    func load(_ drawing: Drawing) {
        load(upgradeToV2(drawing))
    }

    /// Snapshot the current drawing as the v2 vector model. This is what saves,
    /// hashes and exports should use.
    func currentDrawingV2() -> DrawingV2 { doc.drawing }

    /// A v1 projection of the current drawing, for the callers not yet migrated
    /// to v2 (the save sheet and the remix loader — T13 owns both).
    ///
    /// `flattenToV1` is used when the drawing has a faithful v1 form. Otherwise
    /// this returns a best-effort flatten that concatenates the VISIBLE layers'
    /// strokes under the top visible layer's symmetry AND STRIPS `sm`/`po`.
    /// Stripping is not a detail: `deserialize` (the v1-facing read this app's
    /// own remix path uses) routes through `flattenToV1`, which refuses any
    /// stroke carrying either flag — so a v1 document that kept them would be one
    /// this app could save and then never open again. Dropping them also keeps
    /// the uploaded PNG and the stored vector describing the same picture, since
    /// the PNG would be rendered from the same projection.
    ///
    /// The cost is that saves made before T13 lands are unsmoothed and lose
    /// per-layer opacity. That is the honest v1 answer; T13 replaces this call
    /// with `currentDrawingV2()`.
    @available(*, deprecated, message: "v1 projection: drops layers, per-layer opacity and stroke smoothing. Use currentDrawingV2() — T13 for the save flow, T12 for the PNG download.")
    func currentDrawing() -> Drawing {
        let d = doc.drawing
        if let v1 = flattenToV1(d) { return v1 }
        let visible = d.layers.filter(\.visible)
        let sym = visible.last?.sym ?? d.layers[0].sym
        let strokes = visible.flatMap(\.strokes).map { s -> Stroke in
            Stroke(tool: s.tool, color: s.color, size: s.size, opacity: s.opacity,
                   po: false, sm: false, pts: s.pts)
        }
        return Drawing(bg: d.bg, sym: sym, strokes: strokes)
    }

    // MARK: View transform

    static let minZoom: CGFloat = 1
    static let maxZoom: CGFloat = 8

    /// Set zoom + pan together. The view clamps the offset so the canvas can
    /// never be dragged entirely off screen; at 1× the offset is pinned to zero.
    func setView(scale: CGFloat, offset: CGSize, in size: CGSize) {
        let s = min(Self.maxZoom, max(Self.minZoom, scale))
        let maxX = size.width * (s - 1) / 2
        let maxY = size.height * (s - 1) / 2
        let clamped = CGSize(width: min(maxX, max(-maxX, offset.width)),
                             height: min(maxY, max(-maxY, offset.height)))
        guard s != viewScale || clamped != viewOffset else { return }
        viewScale = s
        viewOffset = clamped
        revision += 1
    }

    func resetView() {
        guard viewScale != 1 || viewOffset != .zero else { return }
        viewScale = 1
        viewOffset = .zero
        revision += 1
    }

    // MARK: Pencil

    /// Called the first time a Pencil touch reaches the canvas. Shows the
    /// finger-pan banner once, ever.
    func notePencilUsed() {
        guard !UserDefaults.standard.bool(forKey: Keys.pencilBannerSeen) else { return }
        UserDefaults.standard.set(true, forKey: Keys.pencilBannerSeen)
        showPencilBanner = true
    }

    func dismissPencilBanner() { showPencilBanner = false }

    /// The Pencil double-tap default: Remove-stroke ↔ whatever was active before.
    /// Safe as a default precisely because Remove-stroke is two-phase.
    func togglePencilAction() {
        removeStrokeMode.toggle()
        pendingHit = nil
    }

    // MARK: Demo

    /// Mock-data mode: load a sample drawing so the studio (and the renderer) can
    /// be exercised with no drawing input — used for screenshots / UI tests.
    /// Enabled when the app is launched with KALEIDO_DEMO=1.
    static var demoRequested: Bool {
        ProcessInfo.processInfo.environment["KALEIDO_DEMO"] == "1"
    }

    /// A 3-layer, mixed-symmetry demo. Mixed on purpose: it is the only seeded
    /// state that exercises per-layer symmetry, the offscreen composite (the
    /// middle layer sits below 1) and the layers panel at once.
    func loadDemo() {
        let ribbon = Stroke(tool: .glow, color: "spectrum", size: 26, opacity: 0.85, sm: true,
            pts: (0..<40).map { i in
                let t = Double(i) / 39
                let r = 0.12 + 0.72 * t
                let a = t * 3.4
                return StrokePoint(x: r * cos(a), y: r * sin(a), pressure: 0.4 + 0.5 * sin(t * 3))
            })
        let ribbonLayer = Layer(id: "l1", name: "Glow", visible: true, opacity: 1,
                                sym: Symmetry(segments: 6, mirror: false), strokes: [ribbon])

        let crane = Stroke(tool: .solid, color: "#E84A27", size: 12, opacity: 1, po: true, sm: true,
            pts: (0..<20).map { i in
                let t = Double(i) / 19
                return StrokePoint(x: 0.2 + 0.55 * t, y: -0.15 + 0.1 * sin(t * 8), pressure: 0.25 + 0.7 * t)
            })
        let craneLayer = Layer(id: "l2", name: "Ink", visible: true, opacity: 0.75,
                               sym: Symmetry(segments: 12, mirror: true), strokes: [crane])

        let dot = Stroke(tool: .solid, color: "#D9A521", size: 30, opacity: 0.9,
                         pts: [StrokePoint(x: 0.55, y: 0.2, pressure: 1)])
        let dotLayer = Layer(id: "l3", name: "Gold", visible: true, opacity: 1,
                             sym: Symmetry(segments: 9, mirror: true), strokes: [dot])

        load(DrawingV2(bg: background, layers: [ribbonLayer, craneLayer, dotLayer]))
    }

    // MARK: Plumbing

    /// Run a document mutation and, if it changed anything, publish + re-render.
    @discardableResult
    private func mutate(_ body: (DrawingDoc) -> Bool) -> Bool {
        objectWillChange.send()
        let changed = body(doc)
        if changed { revision += 1 }
        return changed
    }

    private func mutateReturning<T>(_ body: (DrawingDoc) -> T?) -> T? {
        objectWillChange.send()
        let result = body(doc)
        if result != nil { revision += 1 }
        return result
    }
}

// MARK: - Hit testing

/// The inverse of the engine's `transformPoint`: map a point in the drawing
/// frame back into the base (un-imaged) frame.
///
/// Forward is R(angle) · S and S is its own inverse, so this is S · R(-angle).
/// Lives here rather than in the engine because it is a renderer/input concern:
/// hit testing has a tap in canvas space and needs to know whether it landed on
/// ANY of a stroke's N images, and inverting each image once is N cheap
/// transforms instead of expanding every stroke into N polylines.
func inverseTransformPoint(x: Double, y: Double, angle: Double, mirror: Bool) -> (x: Double, y: Double) {
    let c = cos(angle)
    let s = sin(angle)
    let rx = x * c + y * s
    let ry = -x * s + y * c
    return (rx, mirror ? -ry : ry)
}

/// The stroke under a normalized point, or nil. Visible layers top-first,
/// newest stroke first within a layer.
func hitTestDrawing(_ drawing: DrawingV2, x: Double, y: Double, tolerance: Double) -> StrokeHit? {
    for layer in drawing.layers.reversed() where layer.visible {
        // Precompute the point in every image frame once for the whole layer.
        let probes = symmetryImages(segments: layer.sym.segments, mirror: layer.sym.mirror).map {
            inverseTransformPoint(x: x, y: y, angle: $0.angle, mirror: $0.mirror)
        }
        for si in stride(from: layer.strokes.count - 1, through: 0, by: -1) {
            let stroke = layer.strokes[si]
            let reach = stroke.size / 2 / REFERENCE_HALF + tolerance
            for p in probes where strokeContains(stroke, x: p.x, y: p.y, reach: reach) {
                return StrokeHit(layerId: layer.id, index: si)
            }
        }
    }
    return nil
}

/// Subdivisions per curved segment when hit-testing. A segment spans one
/// captured move — capture drops anything under ~1.1px — so the curve across it
/// is short and shallow, and eight chords put the sampling error far below
/// `reach` (at least the stroke's half-width plus a finger's tolerance).
/// Mirrors HIT_CURVE_SAMPLES on the web.
private let hitCurveSamples = 8

/// Is (x, y) within `reach` of this stroke, in the stroke's own frame?
///
/// A smoothed stroke is DRAWN as Béziers, so measuring against the raw polyline
/// tests a shape that is not on screen: on a tight curl the ink bows away from
/// its chord and a tap that visibly lands on the stroke misses. This walks the
/// same curve the renderer builds, via the engine's `smoothStroke`.
private func strokeContains(_ stroke: Stroke, x: Double, y: Double, reach: Double) -> Bool {
    let pts = stroke.pts
    if pts.isEmpty { return false }
    if pts.count == 1 { return hypot(x - pts[0].x, y - pts[0].y) <= reach }

    guard stroke.sm, let cubics = smoothStroke(pts) else {
        for i in 1..<pts.count where distToSegment(x, y, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y) <= reach {
            return true
        }
        return false
    }

    for seg in cubics {
        let a = pts[seg.i]
        // A cubic lies inside the convex hull of its four control points, so the
        // hull's bounding box grown by `reach` is an exact reject — and far
        // cheaper than sampling. Most segments of most strokes fail it.
        if x < min(a.x, seg.c1x, seg.c2x, seg.x) - reach { continue }
        if x > max(a.x, seg.c1x, seg.c2x, seg.x) + reach { continue }
        if y < min(a.y, seg.c1y, seg.c2y, seg.y) - reach { continue }
        if y > max(a.y, seg.c1y, seg.c2y, seg.y) + reach { continue }

        var px = a.x
        var py = a.y
        for k in 1...hitCurveSamples {
            let t = Double(k) / Double(hitCurveSamples)
            let u = 1 - t
            let w0 = u * u * u
            let w1 = 3 * u * u * t
            let w2 = 3 * u * t * t
            let w3 = t * t * t
            let qx = w0 * a.x + w1 * seg.c1x + w2 * seg.c2x + w3 * seg.x
            let qy = w0 * a.y + w1 * seg.c1y + w2 * seg.c2y + w3 * seg.y
            if distToSegment(x, y, px, py, qx, qy) <= reach { return true }
            px = qx
            py = qy
        }
    }
    return false
}

private func distToSegment(_ px: Double, _ py: Double,
                           _ ax: Double, _ ay: Double,
                           _ bx: Double, _ by: Double) -> Double {
    let dx = bx - ax
    let dy = by - ay
    let len2 = dx * dx + dy * dy
    if len2 == 0 { return hypot(px - ax, py - ay) }
    let t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / len2))
    return hypot(px - (ax + t * dx), py - (ay + t * dy))
}
