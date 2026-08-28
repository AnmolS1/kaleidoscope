import SwiftUI
import KaleidoEngine

// The tool rail, the phone dock and the phone strip (DESIGN.md §2).
//
// The organising rule, which is why these three live together: the rail/dock is
// TOOLS YOU SWITCH BETWEEN; popovers are SETTINGS YOU TUNE; the edge sliders are
// the two values you change without looking. Nothing that is a setting goes on
// the rail. Colour, Symmetry and Layers are on it because each one OPENS a
// surface — they are entry points, not switches.

/// Which settings surface is open. One at a time: two floating cards over a
/// drawing is two things covering the art.
enum StudioPanel: Equatable {
    case brush
    case color
    /// Scoped to a layer id — the symmetry popover always names what it edits.
    case symmetry(String)
}

// MARK: - Regular-width rail

struct StudioRail: View {
    @ObservedObject var model: StudioModel
    let metrics: StudioMetrics
    @Binding var panel: StudioPanel?
    /// The layers panel has its own slot: it stays open beside the symmetry
    /// popover a row opened (DESIGN.md's `IPadLayers`).
    @Binding var showLayers: Bool
    /// Actions that live in the More menu.
    let onClear: () -> Void
    let onDownload: () -> Void

    var body: some View {
        VStack(spacing: 2) {
            BrandMark()
                .frame(width: 16, height: 16)
                .padding(.top, 6)
                .padding(.bottom, 10)

            toolTrio

            Hairline().frame(width: 28).padding(.vertical, 6)

            colorButton
            symmetryButton
            layersButton

            Spacer(minLength: 8)

            IconButton(systemImage: "arrow.uturn.backward", label: "Undo",
                       isEnabled: model.canUndo, size: metrics.railButton) { model.undo() }
            IconButton(systemImage: "arrow.uturn.forward", label: "Redo",
                       isEnabled: model.canRedo, size: metrics.railButton) { model.redo() }

            Hairline().frame(width: 28).padding(.vertical, 6)

            MoreMenu(model: model, onClear: onClear, onDownload: onDownload,
                     buttonSize: metrics.railButton)
        }
        .padding(.vertical, 6)
        .frame(width: metrics.railWidth)
        .chromeBackground()
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Drawing tools")
        .accessibilityIdentifier("studio-rail")
    }

    @ViewBuilder
    private var toolTrio: some View {
        // The rail carries no separate "brush settings" button — DESIGN.md's rail
        // anatomy has three tools and no fourth. So selecting a brush that is
        // ALREADY selected opens its popover, which is what `IPadBrush` shows
        // (the brush tool active, its card open beside it). Without this there is
        // no way to reach pressure or smoothing on an iPad at all.
        IconButton(systemImage: "paintbrush.pointed", label: "Solid brush",
                   hint: "Tap again for brush settings",
                   isActive: model.tool == .solid && !model.removeStrokeMode,
                   size: metrics.railButton) { select(.solid) }
        IconButton(systemImage: "sparkle", label: "Glow brush",
                   hint: "Draws with a soft luminous halo. Tap again for brush settings",
                   isActive: model.tool == .glow && !model.removeStrokeMode,
                   size: metrics.railButton) { select(.glow) }
        IconButton(systemImage: "scissors", label: "Remove stroke",
                   hint: "Tap a stroke to highlight it, tap again to delete",
                   isActive: model.removeStrokeMode, size: metrics.railButton) {
            model.removeStrokeMode.toggle()
            model.pendingHit = nil
            panel = nil
        }
    }

    private func select(_ tool: BrushTool) {
        if model.tool == tool && !model.removeStrokeMode {
            panel = panel == .brush ? nil : .brush
        } else {
            model.tool = tool
            model.removeStrokeMode = false
            panel = nil
        }
    }

    /// The current colour AS the button — a 22pt swatch with the active ring.
    private var colorButton: some View {
        Button { toggle(.color) } label: {
            ZStack {
                Circle()
                    .fill(model.useSpectrum
                          ? AnyShapeStyle(AngularGradient(
                              colors: [.red, .yellow, .green, .cyan, .blue, .purple, .red],
                              center: .center))
                          : AnyShapeStyle(Color(hex: model.color)))
                    .frame(width: 22, height: 22)
                Circle().stroke(Blueprint.crane, lineWidth: 2).frame(width: 28, height: 28)
            }
            .frame(width: metrics.railButton, height: metrics.railButton)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Color")
        .accessibilityValue(model.useSpectrum ? "Rainbow spectrum"
                                              : Blueprint.colorName(forHex: model.color))
        .accessibilityHint("Opens the color palette")
    }

    private var symmetryButton: some View {
        IconButton(systemImage: "asterisk", label: "Symmetry",
                   hint: "Opens the symmetry dial for the active layer",
                   isActive: isOpen(.symmetry(model.activeLayerId)),
                   size: metrics.railButton,
                   caption: Readout.sym(model.symmetry)) {
            toggle(.symmetry(model.activeLayerId))
        }
        .accessibilityValue(Readout.spokenSym(model.symmetry))
    }

    private var layersButton: some View {
        IconButton(systemImage: "square.3.layers.3d", label: "Layers",
                   hint: "Opens the layers panel",
                   isActive: showLayers, size: metrics.railButton,
                   badge: "\(model.layers.count)") {
            showLayers.toggle()
        }
        .accessibilityValue("\(model.layers.count) layers, \(model.activeLayer.name) active")
    }

    private func isOpen(_ target: StudioPanel) -> Bool {
        switch (panel, target) {
        case (.symmetry, .symmetry): return true
        default: return panel == target
        }
    }

    private func toggle(_ target: StudioPanel) {
        panel = isOpen(target) ? nil : target
    }
}

// MARK: - Compact-height rail (phone landscape)

/// Six 40pt buttons in a 48pt rail, inset from the notch side. No brand mark, no
/// symmetry caption, no undo/redo split — there is 390pt of height to work with
/// and every row costs canvas.
struct CompactRail: View {
    @ObservedObject var model: StudioModel
    let metrics: StudioMetrics
    @Binding var panel: StudioPanel?
    @Binding var showLayers: Bool
    let onClear: () -> Void
    let onDownload: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            IconButton(systemImage: "paintbrush.pointed", label: "Solid brush",
                       hint: "Tap again for brush settings",
                       isActive: model.tool == .solid && !model.removeStrokeMode,
                       size: metrics.railButton) { select(.solid) }
            IconButton(systemImage: "sparkle", label: "Glow brush",
                       hint: "Draws with a soft luminous halo. Tap again for brush settings",
                       isActive: model.tool == .glow && !model.removeStrokeMode,
                       size: metrics.railButton) { select(.glow) }
            IconButton(systemImage: "scissors", label: "Remove stroke",
                       isActive: model.removeStrokeMode, size: metrics.railButton) {
                model.removeStrokeMode.toggle()
                model.pendingHit = nil
            }
            IconButton(systemImage: "square.3.layers.3d", label: "Layers",
                       isActive: showLayers, size: metrics.railButton,
                       badge: "\(model.layers.count)") {
                showLayers.toggle()
            }
            IconButton(systemImage: "arrow.uturn.backward", label: "Undo",
                       isEnabled: model.canUndo, size: metrics.railButton) { model.undo() }
            MoreMenu(model: model, onClear: onClear, onDownload: onDownload,
                     buttonSize: metrics.railButton)
        }
        .frame(width: metrics.railWidth)
        .chromeBackground()
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Drawing tools")
        .accessibilityIdentifier("studio-rail")
    }

    /// Same rule as the wide rail: a second tap on the live brush opens its
    /// settings. On a landscape phone this is the ONLY route to size, opacity and
    /// smoothing — there is no strip down here, only swatches.
    private func select(_ tool: BrushTool) {
        if model.tool == tool && !model.removeStrokeMode {
            panel = panel == .brush ? nil : .brush
        } else {
            model.tool = tool
            model.removeStrokeMode = false
            panel = nil
        }
    }
}

// MARK: - Phone dock + strip

/// The bottom dock: Brush · Glow · Remove · Layers · Undo · More. It never
/// scrolls — a tool row that moves under your thumb is a tool row you have to
/// look at.
struct PhoneDock: View {
    @ObservedObject var model: StudioModel
    let metrics: StudioMetrics
    @Binding var panel: StudioPanel?
    @Binding var showLayers: Bool
    let onClear: () -> Void
    let onDownload: () -> Void

    var body: some View {
        HStack(spacing: 0) {
            Group {
                IconButton(systemImage: "paintbrush.pointed", label: "Solid brush",
                           hint: "Tap again for brush settings",
                           isActive: model.tool == .solid && !model.removeStrokeMode) {
                    select(.solid)
                }
                IconButton(systemImage: "sparkle", label: "Glow brush",
                           hint: "Draws with a soft luminous halo. Tap again for brush settings",
                           isActive: model.tool == .glow && !model.removeStrokeMode) {
                    select(.glow)
                }
                IconButton(systemImage: "scissors", label: "Remove stroke",
                           isActive: model.removeStrokeMode) {
                    model.removeStrokeMode.toggle()
                    model.pendingHit = nil
                }
                IconButton(systemImage: "square.3.layers.3d", label: "Layers",
                           isActive: showLayers, badge: "\(model.layers.count)") {
                    showLayers.toggle()
                }
                IconButton(systemImage: "arrow.uturn.backward", label: "Undo",
                           isEnabled: model.canUndo) { model.undo() }
                MoreMenu(model: model, onClear: onClear, onDownload: onDownload, buttonSize: 44)
            }
            .frame(maxWidth: .infinity)
        }
        .frame(height: metrics.dockHeight)
        .chromeBackground(cornerRadius: 12)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Drawing tools")
        .accessibilityIdentifier("studio-dock")
    }

    private func select(_ tool: BrushTool) {
        if model.tool == tool && !model.removeStrokeMode {
            panel = panel == .brush ? nil : .brush
        } else {
            model.tool = tool
            model.removeStrokeMode = false
            panel = nil
        }
    }
}

/// The scrolling strip above the dock: swatches, then the value chips. It scrolls
/// precisely so it can hold everything without shrinking a 44pt target.
struct PhoneStrip: View {
    @ObservedObject var model: StudioModel
    @Binding var customColor: Color
    @Binding var panel: StudioPanel?

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                SwatchRow(model: model, customColor: $customColor, swatchSize: 24)
                Button { panel = .symmetry(model.activeLayerId) } label: {
                    Chip { Label(Readout.sym(model.symmetry), systemImage: "asterisk") }
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Symmetry")
                .accessibilityValue(Readout.spokenSym(model.symmetry))
                .accessibilityHint("Opens the symmetry dial for the active layer")

                Button { panel = .brush } label: {
                    Chip { Text("\(Int(model.size.rounded())) px") }
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Brush size")
                .accessibilityValue("\(Int(model.size.rounded())) points")
                .accessibilityHint("Opens brush settings")

                Button { panel = .brush } label: {
                    Chip { Text(Readout.percent(model.opacity)) }
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Opacity")
                .accessibilityValue("\(Int((model.opacity * 100).rounded())) percent")
                .accessibilityHint("Opens brush settings")
            }
            .padding(.horizontal, 16)
        }
        .frame(height: 44)
        .accessibilityIdentifier("studio-strip")
    }
}

// MARK: - Shared bits

/// The rosette, small. Same mark as the widget and the About screen.
struct BrandMark: View {
    var body: some View {
        RosetteMark(lineWidth: 1.5).accessibilityHidden(true)
    }
}

/// Everything that is neither a tool nor a tuned setting: theme, guides, the
/// download, clear, and help. DESIGN.md leaves the ordering open (§7); this is
/// grouped view-affecting → document-affecting → destructive, so Clear is never
/// adjacent to a toggle a user is flicking.
struct MoreMenu: View {
    @ObservedObject var model: StudioModel
    let onClear: () -> Void
    let onDownload: () -> Void
    var buttonSize: CGFloat = 44

    var body: some View {
        Menu {
            Toggle(isOn: Binding(get: { model.background == .dark },
                                 set: { model.background = $0 ? .dark : .light })) {
                Label("Dark canvas", systemImage: "moon")
            }
            .accessibilityLabel("Dark canvas")
            .accessibilityHint("Switches the canvas background between light and dark")

            Toggle(isOn: $model.showGuides) {
                Label("Symmetry guides", systemImage: "grid")
            }
            .accessibilityLabel("Symmetry guides")
            .accessibilityHint("Shows faint wedge guide lines")

            Divider()

            Button { onDownload() } label: { Label("Download PNG", systemImage: "square.and.arrow.down") }
                .disabled(model.isEmpty)

            Divider()

            Button(role: .destructive) { onClear() } label: { Label("Clear canvas", systemImage: "trash") }
                .disabled(model.isEmpty)
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: buttonSize * 0.4))
                .foregroundStyle(Blueprint.graphite.opacity(0.72))
                .frame(width: buttonSize, height: buttonSize)
                .contentShape(Rectangle())
        }
        .accessibilityLabel("More")
        .accessibilityHint("Canvas theme, guides, download and clear")
        .accessibilityIdentifier("more-menu")
    }
}
