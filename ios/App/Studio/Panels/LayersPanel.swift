import SwiftUI
import KaleidoEngine

// The layers panel (DESIGN.md §3, frames IPadLayers / LayersStates / IPadDark).
//
// 264pt wide. Rows are listed top layer FIRST, which is the reverse of the
// document's bottom→top array — a stack is read from the top down, and getting
// this backwards silently inverts every drag.

struct LayersPanel: View {
    @ObservedObject var model: StudioModel
    @EnvironmentObject private var auth: AuthModel
    @EnvironmentObject private var router: AppRouter
    /// Opens the symmetry popover scoped to a specific layer (tapping its sym line).
    var onEditSymmetry: (String) -> Void
    /// Fired when a nudge should be shown (e.g. a new layer inheriting symmetry).
    var onNudge: (StudioNudge) -> Void

    // `renaming` / `draftName` now live on the model — see StudioModel. A card
    // rebuild on iPad was discarding them.
    /// Which row has its opacity slider disclosed, if any. One at a time: the
    /// slider is a second line inside the row, and eight open at once would push
    /// the footer and the cap footnote off the panel.
    @State private var opacityFor: String?
    @FocusState private var nameFieldFocused: Bool

    /// Top layer first.
    private var rows: [LayerSummary] { model.layers.reversed() }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            VStack(spacing: 2) {
                ForEach(rows) { row in
                    LayerRow(
                        layer: row,
                        isActive: row.id == model.activeLayerId,
                        isRenaming: model.renamingLayerId == row.id,
                        isOpacityOpen: opacityFor == row.id,
                        draftName: $model.renameDraft,
                        nameFieldFocused: $nameFieldFocused,
                        onSelect: { model.setActiveLayer(row.id) },
                        onToggleVisible: { model.setLayerVisible(row.id, !row.visible) },
                        onEditSymmetry: { onEditSymmetry(row.id) },
                        onToggleOpacity: {
                            if opacityFor == row.id {
                                // Closing seals the gesture. A VoiceOver
                                // adjustment ends no drag, so without this the
                                // coalesce key stays live and the NEXT change to
                                // this layer merges into the same undo entry —
                                // minutes later, invisibly.
                                model.endLayerOpacityGesture()
                                opacityFor = nil
                            } else {
                                opacityFor = row.id
                            }
                        },
                        onSetOpacity: { value, coalesce in
                            model.setLayerOpacity(row.id, value, coalesce: coalesce)
                        },
                        onEndOpacityGesture: { model.endLayerOpacityGesture() },
                        onBeginRename: {
                            model.beginRename(row.id, current: row.name)
                            // Focus lands on both device classes. It used to be
                            // lost on iPad: focus DID land, then the keyboard it
                            // summoned shrank `StudioView`'s geometry until the
                            // card flipped to its landscape branch, recreating
                            // this view and its `@FocusState`. `StudioView` now
                            // ignores the keyboard safe area — see the comment
                            // there before changing that.
                            nameFieldFocused = true
                        },
                        onCommitRename: { model.commitRename() },
                        didFocus: model.renameDidFocus,
                        onDidFocus: { model.renameDidFocus = true },
                        onMove: { delta in move(row, by: delta) },
                        canMoveUp: model.layers.last?.id != row.id,
                        canMoveDown: model.layers.first?.id != row.id
                    )
                }
            }
            Hairline().padding(.vertical, 8)
            footer
            if let note = capNote {
                Group {
                    switch note {
                    case .full:
                        Text("All \(MAX_LAYERS) layers in use")
                    case let .capped(count, cap, offersPlus):
                        if offersPlus {
                            // A real Button, not `.onTapGesture` on a Text
                            // (REVIEW.md minor mI9). The mention read as a link
                            // on the web and as inert prose here, so the one
                            // place a user meets the layer cap named the way out
                            // and did not offer it.
                            //
                            // The tap gesture version was WORSE than useless:
                            // XCUITest reported the element as existing and NOT
                            // hittable, because a Text's bounds are the glyphs
                            // and nothing else. `contentShape` gives the row a
                            // rectangle to be tapped on, which is the same
                            // reason this panel's controls are measured for a
                            // 44pt target elsewhere.
                            Button {
                                router.openPlus()
                            } label: {
                                Text("Layers: \(count) of \(cap) · ")
                                    + Text("Kaleidoscope Plus").foregroundColor(Blueprint.craneText)
                                    + Text(" unlocks \(MAX_LAYERS)")
                            }
                            .buttonStyle(.plain)
                            .contentShape(Rectangle())
                            .accessibilityHint("Opens Kaleidoscope Plus")
                        } else {
                            Text("Layers: \(count) of \(cap)")
                        }
                    }
                }
                .font(Blueprint.mono(.caption2))
                .textCase(nil)
                .foregroundStyle(Blueprint.graphite.opacity(0.7))
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 6)
            }
        }
        .padding(10)
        // 264 is the CARD width (DESIGN.md §3), which is right when the panel is
        // a popover beside the rail on iPad. In the phone's sheet it is a 264pt
        // island in a full-width presentation — wasted room, and the reason each
        // row had to stack its chips onto a second line. `maxWidth` lets the
        // sheet give the row enough width to lay out on ONE line, which is what
        // "we have extra horizontal space" was pointing at; `ViewThatFits` in
        // the row picks per row, so nothing here has to know which is which.
        .frame(maxWidth: 420)
        .frame(minWidth: 264)
        .accessibilityIdentifier("layers-panel")
    }

    // MARK: Header / footer

    private var header: some View {
        HStack {
            Text("Layers").font(Blueprint.display(.subheadline))
            Spacer()
            Text("\(model.layers.count) of \(model.layerCap)")
                .font(Blueprint.mono(.caption2))
                .foregroundStyle(Blueprint.graphite.opacity(0.7))
        }
        .padding(.horizontal, 6)
        .padding(.bottom, 8)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Layers, \(model.layers.count) of \(model.layerCap)")
    }

    private var footer: some View {
        HStack(spacing: 4) {
            Button {
                let before = model.activeLayer.sym
                if model.addLayer() != nil {
                    onNudge(.newLayerSymmetry(Readout.spokenSym(before)))
                }
            } label: {
                Chip(isEnabled: model.canAddLayer) {
                    Label("Add", systemImage: model.canAddLayer ? "plus" : "lock")
                }
            }
            .buttonStyle(.plain)
            .disabled(!model.canAddLayer)
            .accessibilityLabel(model.canAddLayer ? "Add layer" : "Add layer, locked at the layer limit")

            Button { model.duplicateLayer() } label: {
                Chip(isEnabled: model.canAddLayer) { Image(systemName: "plus.square.on.square") }
            }
            .buttonStyle(.plain)
            .disabled(!model.canAddLayer)
            .accessibilityLabel("Duplicate layer")

            Button { model.removeLayer() } label: {
                Chip(isEnabled: model.layers.count > 1) { Image(systemName: "trash") }
            }
            .buttonStyle(.plain)
            .disabled(model.layers.count <= 1)
            .accessibilityLabel("Delete layer")
        }
    }

    /// DESIGN.md §3: the cap is a state, not a punishment — the free string names
    /// the way out, and the Plus string just says the stack is full.
    ///
    /// 🔴 GATED ON THE SURFACE, exactly as the web is (S14). The mention only
    /// becomes a BUTTON when `PlusSheet` would actually render — an ungated one
    /// is a control that visibly does nothing, which is precisely what a user at
    /// the cap would tap. That state is reachable: `/api/me` degrades to a plus
    /// block with the surface off, and the free layer cap still applies. With
    /// the surface off the user gets the count and no offer.
    private var capNote: LayerCapNote? {
        guard !model.canAddLayer else { return nil }
        guard model.layerCap < MAX_LAYERS else { return .full }
        return PlusSheetInput.surfaceVisible(auth.plus)
            ? .capped(count: model.layers.count, cap: model.layerCap, offersPlus: true)
            : .capped(count: model.layers.count, cap: model.layerCap, offersPlus: false)
    }

    /// Reorder by one place. A drag would be the frame's gesture, but a
    /// keyboard/VoiceOver user needs an equivalent, and one implementation that
    /// both the custom actions and the grip buttons call is one set of index
    /// arithmetic to get wrong instead of two.
    private func move(_ row: LayerSummary, by delta: Int) {
        guard let from = model.layers.firstIndex(where: { $0.id == row.id }) else { return }
        model.moveLayer(row.id, toIndex: from + delta)
    }
}

// MARK: - Row

private struct LayerRow: View {
    let layer: LayerSummary
    let isActive: Bool
    let isRenaming: Bool
    let isOpacityOpen: Bool
    @Binding var draftName: String
    var nameFieldFocused: FocusState<Bool>.Binding
    let onSelect: () -> Void
    let onToggleVisible: () -> Void
    let onEditSymmetry: () -> Void
    let onToggleOpacity: () -> Void
    /// `(value, coalesce)` — coalesce is true only while a DRAG is in flight.
    let onSetOpacity: (Double, Bool) -> Void
    let onEndOpacityGesture: () -> Void
    let onBeginRename: () -> Void
    let onCommitRename: () -> Void
    /// Whether the field has held focus — see `StudioModel.renameDidFocus`.
    let didFocus: Bool
    let onDidFocus: () -> Void
    let onMove: (Int) -> Void
    let canMoveUp: Bool
    let canMoveDown: Bool

    @Environment(\.accessibilityDifferentiateWithoutColor) private var differentiateWithoutColor

    /// True between the slider's editing-began and editing-ended. It is the only
    /// thing that turns coalescing on.
    @State private var draggingOpacity = false

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            // ONE LINE WHERE IT FITS, two where it does not.
            //
            // One line keeps a row at ~48pt; two lines are ~92pt. Which one fits
            // depends on the width, the name and whether the row carries the
            // pencil — since every control became a 44pt target, a 393pt phone
            // usually wraps and a wider sheet or the iPad card often does not.
            // `ViewThatFits` picks per row rather than per platform, so a Split
            // View iPad or a large Dynamic Type size gets the right one too. A
            // tall stack scrolls (the phone sheet and the iPad card both wrap
            // the panel in a ScrollView).
            if isRenaming {
                // 🔴 RENAMING GETS ITS OWN ROW, outside `ViewThatFits`.
                //
                // A `TextField` inside a `ViewThatFits` candidate does not
                // survive the measurement pass on the branch the iPad picks: the
                // pencil reported hittable, the tap registered, and no field
                // ever entered the tree. It works on the phone, which picks the
                // other branch — so this looked device-specific and is really
                // about being measured.
                //
                // A dedicated line is simpler anyway: while you are typing, the
                // field wants the width more than the chips do.
                renameLine
            } else {
                ViewThatFits(in: .horizontal) {
                    oneLine
                    twoLines
                }
            }
            // The slider is a second line INSIDE the row, not a popover: the
            // panel is 264pt wide with nothing beside a row, and keeping it
            // in the row keeps it inside the row's accessibility container,
            // next to the number it edits.
            if isOpacityOpen { opacitySlider }
        }
        // Small: the 44pt targets already carry the breathing room.
        .padding(.horizontal, 2)
        .padding(.vertical, 2)
        .background {
            let shape = RoundedRectangle(cornerRadius: Blueprint.rSm, style: .continuous)
            if isActive {
                shape.fill(Blueprint.crane.opacity(0.10))
                    .overlay(shape.stroke(Blueprint.crane.opacity(0.35), lineWidth: 1))
            }
        }
        // A hidden layer reads at 55%. Under Differentiate Without Color the
        // eye-off glyph is already a non-colour signal, so nothing extra is
        // needed here — but the opacity must not be the ONLY signal, which is
        // why the glyph swaps rather than just dimming.
        .opacity(layer.visible ? 1 : 0.55)
        // 🔴 RENAME NEEDED AN AFFORDANCE. It was once a double-tap on a
        // background layer and nothing else — no glyph, no menu, nothing on
        // screen saying the name could be changed. Reported as "there's no way
        // to rename layers on iPad". That gesture is gone.
        //
        // Rename now has three routes: the pencil beside the ACTIVE row's name
        // (`renameButton`; one row rather than eight so the panel does not turn
        // into a wall of icons), this context menu — the standard iOS place to
        // look for row actions — and the VoiceOver "Rename" action.
        .contextMenu {
            Button { onBeginRename() } label: { Label("Rename", systemImage: "pencil") }
            Button { onToggleVisible() } label: {
                Label(layer.visible ? "Hide" : "Show",
                      systemImage: layer.visible ? "eye.slash" : "eye")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(rowLabel)
        .accessibilityAddTraits(isActive ? [.isSelected] : [])
        .modifier(ReorderActions(canMoveUp: canMoveUp, canMoveDown: canMoveDown,
                                 onMove: onMove, onRename: onBeginRename))
    }

    /// Row anatomy, rebuilt around what a finger can actually hit.
    ///
    /// 🔴 WHAT WAS WRONG, TWICE. First, selecting a layer had no target of its
    /// own: the tap lived on a `Color.clear` behind the content and fired only
    /// in the slivers the controls left over. The fix for that made thumbnail +
    /// name a Select button — but the flexible space between the name and the
    /// trailing controls stayed OUTSIDE the button, so the widest part of the
    /// row was still dead. Reported, again, as "I have to tap exactly in the
    /// empty space between the layer name and the visibility toggle... these
    /// locations are both too small and not clear". And every control was under
    /// 44pt: chevrons 28x22, eye and pencil 32x32, chips 30pt tall.
    ///
    /// WHAT IT IS NOW. Every region is a real button with its own bounds, and
    /// between them they tile the row:
    ///
    ///  - SELECT is thumbnail + name + ALL the free width, at least 44pt tall.
    ///    The flexible space is inside its label; there is no Spacer between it
    ///    and the trailing controls, so there is no dead strip to hunt for.
    ///  - every other control has a 44x44pt hit frame around a smaller glyph or
    ///    chip. The glyphs did not grow; the targets did.
    ///  - nothing is emergent: no background gestures, no invisible targets.
    ///
    /// The `Spacer` is INSIDE Select's label, so the button takes every point
    /// the trailing controls do not. Its `minLength` is small and fixed, so the
    /// IDEAL width is still thumbnail + name + a few points and `ViewThatFits`
    /// measures the row honestly.
    private var selectButton: some View {
        Button(action: onSelect) {
            HStack(spacing: 8) {
                LayerThumbnail(layer: layer)
                nameOrField
                Spacer(minLength: 4)
            }
            .frame(minHeight: Self.hit)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // The label is STABLE and the state is a trait. Putting "selected" in
        // the label made the button a different element depending on which row
        // was active — awkward for VoiceOver (state read as if it were a name)
        // and it silently halved a query that expected both rows.
        .accessibilityLabel("Select \(layer.name)")
        .accessibilityAddTraits(isActive ? [.isSelected] : [])
    }

    /// DESIGN.md §2's minimum target, applied to every row control.
    static let hit: CGFloat = 44

    /// A glyph button with a full 44pt target around a smaller drawn glyph.
    private func glyphButton(_ systemName: String, font: Font = .body,
                             color: Color = Blueprint.graphite.opacity(0.72),
                             action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(font)
                .foregroundStyle(color)
                .frame(width: Self.hit, height: Self.hit)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var renameButton: some View {
        glyphButton("pencil", font: .caption, color: Blueprint.craneText, action: onBeginRename)
            .accessibilityLabel("Rename \(layer.name)")
    }

    private var visibilityButton: some View {
        glyphButton(layer.visible ? "eye" : "eye.slash", action: onToggleVisible)
            .accessibilityLabel(layer.visible ? "Hide \(layer.name)" : "Show \(layer.name)")
    }

    /// A value chip with a 44pt-tall target. The chip draws at its usual 30pt
    /// (the footer's buttons share `Chip`, so the style itself is unchanged);
    /// the button's label is the chip plus the padding that makes the target,
    /// and 3pt either side puts two chips 6pt apart with no dead gap between.
    private func chipButton<L: View>(action: @escaping () -> Void,
                                     @ViewBuilder chip: () -> L) -> some View {
        Button(action: action) {
            chip()
                .padding(.horizontal, 3)
                .frame(minHeight: Self.hit)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var symmetryChip: some View {
        chipButton(action: onEditSymmetry) {
            Chip {
                Label(Readout.sym(layer.sym), systemImage: "asterisk")
                    .font(Blueprint.mono(.caption2))
                    .labelStyle(.titleAndIcon)
            }
        }
        .accessibilityLabel("Symmetry for \(layer.name)")
        .accessibilityValue(Readout.spokenSym(layer.sym))
        .accessibilityHint("Opens the symmetry dial for this layer")
    }

    private var opacityChip: some View {
        chipButton(action: onToggleOpacity) {
            Chip(isActive: isOpacityOpen) {
                Label(Readout.percent(layer.opacity), systemImage: "circle.lefthalf.filled")
                    .font(Blueprint.mono(.caption2))
                    .labelStyle(.titleAndIcon)
            }
        }
        .accessibilityLabel("Opacity for \(layer.name)")
        .accessibilityValue(Readout.percent(layer.opacity))
        .accessibilityHint(isOpacityOpen
                           ? "Hides this layer's opacity slider"
                           : "Shows this layer's opacity slider")
    }

    /// The row while its name is being edited: chevrons, thumbnail, field, eye.
    ///
    /// 🔴 THE FIELD IS NOT IN A BUTTON. A `TextField` inside a `Button` is inert
    /// — the button swallows the touch — so the field appeared, could be
    /// focused by code, and could not be typed into.
    private var renameLine: some View {
        HStack(spacing: 0) {
            reorderControls(.horizontal)
            HStack(spacing: 8) {
                LayerThumbnail(layer: layer)
                nameOrField
            }
            .frame(maxWidth: .infinity, minHeight: Self.hit, alignment: .leading)
            visibilityButton
        }
    }

    /// Everything on a single line — chips beside the name. Chevrons sit side
    /// by side here, so the row stays one 44pt line tall.
    private var oneLine: some View {
        HStack(spacing: 0) {
            reorderControls(.horizontal)
            selectButton
            if isActive { renameButton }
            symmetryChip
            opacityChip
            visibilityButton
        }
    }

    /// The narrow arrangement: name on top, chips beneath, and the chevrons
    /// stacked in a leading column that spans both lines — two 44pt targets
    /// stacked are exactly two 44pt lines tall.
    private var twoLines: some View {
        HStack(alignment: .top, spacing: 0) {
            reorderControls(.vertical)
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 0) {
                    selectButton
                    if isActive { renameButton }
                    visibilityButton
                }
                HStack(spacing: 0) {
                    symmetryChip
                    opacityChip
                    Spacer(minLength: 0)
                }
                // Line up under the name, past the thumbnail, less the chip's
                // own 3pt target padding.
                .padding(.leading, 39)
            }
        }
    }

    private enum ChevronAxis { case horizontal, vertical }

    /// Chevrons rather than a drag handle — see the commit that replaced the
    /// decorative `line.3.horizontal`; a drag cannot win the vertical gesture
    /// inside the iPad panel's scroll view. Each is a full 44pt target; the
    /// glyph stays small.
    @ViewBuilder
    private func reorderControls(_ axis: ChevronAxis) -> some View {
        let up = glyphButton("chevron.up", font: .system(size: 10, weight: .semibold),
                             color: Blueprint.graphite.opacity(0.7)) { onMove(1) }
            .disabled(!canMoveUp)
            .accessibilityLabel("Move \(layer.name) up")
        let down = glyphButton("chevron.down", font: .system(size: 10, weight: .semibold),
                               color: Blueprint.graphite.opacity(0.7)) { onMove(-1) }
            .disabled(!canMoveDown)
            .accessibilityLabel("Move \(layer.name) down")
        switch axis {
        case .horizontal: HStack(spacing: 0) { up; down }
        case .vertical: VStack(spacing: 0) { up; down }
        }
    }

    @ViewBuilder
    private var nameOrField: some View {
        if isRenaming {
            TextField("Layer name", text: $draftName)
                .font(.footnote.weight(.medium))
                .textFieldStyle(.plain)
                .focused(nameFieldFocused)
                .submitLabel(.done)
                .onSubmit(onCommitRename)
                // ALSO COMMIT ON LOSING FOCUS. `onSubmit` alone means a rename
                // is thrown away by tapping anywhere else — you type a name, the
                // field closes, and the old one is still there with nothing
                // saying why. Caught by a test that types for real and then
                // looked for the name on the row: the field still held
                // "Layer 1Petals" and the row still said "Layer 1".
                //
                // `commitRename` clears `renamingLayerId`, so the submit path
                // and this one cannot both write.
                .onChange(of: nameFieldFocused.wrappedValue) { _, focused in
                    if focused { onDidFocus() } else if didFocus { onCommitRename() }
                }
        } else {
            Text(layer.name)
                .font(.footnote.weight(.medium))
                .lineLimit(1)
                .truncationMode(.tail)
        }
    }

    /// The disclosed opacity slider.
    ///
    /// **`coalesce` is the point.** A drag emits a continuous stream of values;
    /// committing each one is how a single gesture becomes forty undo entries.
    /// So every value set DURING a drag is coalesced into one entry, and the
    /// gesture is sealed when the drag ends. `draggingOpacity` is what separates
    /// a drag from a VoiceOver adjustment, which begins and ends no drag and
    /// must therefore be its own step rather than merging into the last one.
    private var opacitySlider: some View {
        HStack(spacing: 8) {
            Slider(
                value: Binding(
                    get: { layer.opacity },
                    // 0...1 IS THE ENGINE'S SCALE. It clamps, so a whole percent
                    // handed over raw would pin every layer at 1 and read as a
                    // slider that does nothing.
                    set: { onSetOpacity($0, draggingOpacity) }
                ),
                in: 0...1,
                onEditingChanged: { editing in
                    draggingOpacity = editing
                    if !editing { onEndOpacityGesture() }
                }
            )
            .tint(Blueprint.crane)
            // DESIGN.md §2's 44pt, spent on the TARGET: a Slider's own intrinsic
            // height is under it, and a control that only misses the rule inside
            // a panel is still a control that misses it.
            .frame(minHeight: 44)
            .accessibilityLabel("Opacity for \(layer.name)")
            .accessibilityValue(Readout.percent(layer.opacity))

            Text(Readout.percent(layer.opacity))
                .font(Blueprint.mono(.caption2))
                .foregroundStyle(Blueprint.graphite.opacity(0.7))
                .frame(width: 40, alignment: .trailing)
                .accessibilityHidden(true)
        }
        .padding(.top, 2)
    }

    private var rowLabel: String {
        var parts = ["Layer \(layer.name)", Readout.spokenSym(layer.sym),
                     "\(Readout.percent(layer.opacity)) opacity"]
        if !layer.visible { parts.append("hidden") }
        if isActive { parts.append("active") }
        return parts.joined(separator: ", ")
    }

}

/// A 34pt well showing that layer alone, in its own symmetry — the design's
/// per-layer thumbnail. Strokes are not scaled down into it; the renderer draws
/// the layer at the well's size, which is what makes a 24-fold layer read as
/// dense and a 3-fold one as sparse at a glance.
private struct LayerThumbnail: View {
    let layer: LayerSummary

    var body: some View {
        RoundedRectangle(cornerRadius: 4, style: .continuous)
            .fill(Blueprint.inset)
            .overlay(RoundedRectangle(cornerRadius: 4, style: .continuous)
                .stroke(Blueprint.creaseLine, lineWidth: 1))
            .overlay {
                // Spokes standing in for the layer's symmetry. Rendering the real
                // ink at 34pt costs a full offscreen composite per row per frame
                // and reads as a smudge at that size; the spoke count is the
                // information a user is actually reading off the thumbnail.
                Canvas { ctx, size in
                    let c = CGPoint(x: size.width / 2, y: size.height / 2)
                    let r = min(size.width, size.height) / 2 - 3
                    var path = Path()
                    for i in 0..<layer.sym.segments {
                        let a = Double(i) / Double(layer.sym.segments) * 2 * .pi - .pi / 2
                        path.move(to: c)
                        path.addLine(to: CGPoint(x: c.x + cos(a) * r, y: c.y + sin(a) * r))
                    }
                    ctx.stroke(path, with: .color(Blueprint.crane.opacity(
                        layer.strokeCount > 0 ? 0.55 : 0.18)), lineWidth: 1)
                }
                .padding(2)
            }
            .frame(width: 34, height: 34)
            .accessibilityHidden(true)
    }
}

/// Reordering is a drag in the frames; these are the same operations offered as
/// VoiceOver rotor actions, because a drag is not an interaction a screen-reader
/// user has. Guarded so the top layer is never offered "Move up".
private struct ReorderActions: ViewModifier {
    let canMoveUp: Bool
    let canMoveDown: Bool
    let onMove: (Int) -> Void
    let onRename: () -> Void

    func body(content: Content) -> some View {
        content
            .accessibilityAction(named: Text("Move up")) { if canMoveUp { onMove(1) } }
            .accessibilityAction(named: Text("Move down")) { if canMoveDown { onMove(-1) } }
            .accessibilityAction(named: Text("Rename"), onRename)
    }
}

/// What the layers panel's cap footnote says.
///
/// A type rather than a String so the "and here is the way out" half can be a
/// control, and so the surface gate is a value the panel carries rather than a
/// condition re-derived at the point of rendering.
enum LayerCapNote: Equatable {
    case full
    case capped(count: Int, cap: Int, offersPlus: Bool)
}
