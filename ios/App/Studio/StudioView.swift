import SwiftUI
import KaleidoEngine

/// The drawing studio: a full-bleed canvas with the blueprint-instrument chrome
/// floating over it (DESIGN.md §2).
///
/// The canvas is the whole screen and the chrome is an overlay, not a sibling in
/// a VStack. That is the load-bearing change from 1.1, where a fixed controls
/// panel took 42% of the height: the drawing is the product, and a panel that
/// permanently occupies a third of an iPad is a panel that is wrong on an iPad.
/// The corollary is the rule the whole layout obeys — **no panel ever covers the
/// drawing's centre**. Popovers hang off the rail, the layers panel docks to a
/// corner, and nothing floats over the middle except the remove-stroke capsule,
/// which is deliberately anchored to what it is about to delete.
///
/// Draw + download are free (no account); Save is provided via `onSave`.
struct StudioView: View {
    @ObservedObject var model: StudioModel
    /// Invoked by the Save button.
    var onSave: () -> Void = {}

    @EnvironmentObject private var router: AppRouter
    @EnvironmentObject private var auth: AuthModel

    @State private var shareItem: ShareItem?
    @State private var customColor = Color(hex: "#E84A27")
    /// The rail-anchored card. Only ONE of brush / colour / symmetry at a time —
    /// two floating cards over a drawing is two things covering the art.
    @State private var panel: StudioPanel?
    /// The layers panel is a SEPARATE slot, not another `panel` case, because
    /// `IPadLayers` shows it open beside the symmetry popover: tapping a row's
    /// sym line opens the dial for that layer without closing the list it was
    /// tapped in. Folding it into `panel` made that tap dismiss its own context.
    @State private var showLayers = false
    @State private var showClearConfirm = false
    @State private var showHelp = false
    /// Measured natural heights of the two card slots — see `scrollableCard`.
    @State private var leadingCardHeight: CGFloat = 0
    @State private var layersCardHeight: CGFloat = 0
    @StateObject private var nudges = NudgeCenter()


    @Environment(\.horizontalSizeClass) private var hSize
    @Environment(\.verticalSizeClass) private var vSize
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var layout: StudioLayout { StudioLayout(horizontal: hSize, vertical: vSize) }

    /// At accessibility text sizes the rail's glyphs and captions grow, so the
    /// rail itself has to. Capped: past ~76pt the rail stops being a rail and
    /// starts being a sidebar that eats the canvas.
    private var metrics: StudioMetrics {
        var m = layout.metrics
        guard dynamicTypeSize.isAccessibilitySize else { return m }
        m.railWidth = min(m.railWidth * 1.35, 76)
        m.railButton = min(m.railButton * 1.35, 60)
        m.dockHeight = m.dockHeight * 1.2
        return m
    }

    /// The edge sliders are a look-free shortcut, not the only way to set size and
    /// opacity — the Brush popover always carries both. At accessibility sizes
    /// they are suppressed: a 10pt label and a 4pt track cannot scale, and a
    /// control that a user cannot read is worse than one they must open a panel
    /// to reach.
    private var showsEdgeSliders: Bool {
        layout.showsEdgeSliders && !dynamicTypeSize.isAccessibilitySize
    }

    var body: some View {
        GeometryReader { geo in
            ZStack {
                DrawingCanvas(model: model)
                    .ignoresSafeArea()
                chrome(in: geo)
            }
        }
        .background(Blueprint.graph.ignoresSafeArea())
        // The chrome follows the CANVAS, not the system. Every `Blueprint` token
        // is a light/dark pair, so without this a dark canvas kept light chrome:
        // graphite-ink slider labels on a near-black ground, which measured out
        // at roughly 1.2:1 and is exactly what `IPadDark` shows must not happen.
        // The canvas background is the studio's ground, so it is the thing the
        // surfaces sitting on it have to agree with.
        .environment(\.colorScheme, model.background == .dark ? .dark : .light)
        .overlay(alignment: .topLeading) { exportProbe }
        .sheet(item: $shareItem) { item in ShareSheet(items: [item.url]) }
        .sheet(isPresented: $showHelp) { StudioHelpSheet() }
        // Compact width gets bottom sheets rather than floating cards: a 280pt
        // card on a 390pt-wide screen is a modal wearing a popover's clothes.
        .sheet(isPresented: sheetBinding) { panelSheet }
        .alert("Clear the canvas?", isPresented: $showClearConfirm) {
            Button("Clear strokes", role: .destructive) { model.clear() }
            Button("Keep drawing", role: .cancel) {}
        } message: {
            // DESIGN.md's copy is written for the 3-layer case; a fresh canvas
            // has one, and "Your 1 layers" is not a sentence.
            Text(model.layers.count == 1
                 ? "Removes every stroke. Your layer, its name and symmetry stay. You can undo this."
                 : "Removes every stroke. Your \(model.layers.count) layers, their names and symmetry stay. You can undo this.")
        }
        .onChange(of: model.showPencilBanner) { _, shown in
            guard shown else { return }
            // T11's canvas raises its own inline banner. Dismiss it and show the
            // spec's toast instead, so the copy and the CTA match DESIGN.md §3
            // without editing the canvas.
            model.dismissPencilBanner()
            nudges.show(.pencilDetected, atRevision: model.revision)
        }
        .onChange(of: model.refusedHiddenLayer) { _, refusal in
            // The stroke was refused, so `revision` did NOT move — which is
            // exactly why this nudge is safe to dismiss on the next edit: the
            // next edit is a real one.
            guard let refusal else { return }
            nudges.show(.hiddenLayer(id: refusal.id, name: refusal.name),
                        atRevision: model.revision)
            model.clearHiddenLayerRefusal()
        }
        .onChange(of: model.drawWithFinger) { _, canDraw in
            if !canDraw { nudges.show(.fingersPan, atRevision: model.revision) }
        }
        .onChange(of: model.activeLayerId) { _, id in
            // Remove-stroke retargets the active layer to whatever it hit. Say so
            // — a silent active-layer change is how the next stroke lands
            // somewhere the user did not expect.
            guard model.removeStrokeMode,
                  let name = model.layers.first(where: { $0.id == id })?.name else { return }
            nudges.show(.switchedLayer(name), atRevision: model.revision)
        }
        .onChange(of: model.revision) { _, revision in
            // "Dismiss on the next stroke" (DESIGN.md §3). `revision` moves on
            // every pixel-affecting edit, which is the closest signal the studio
            // has to "the user got on with it". `NudgeCenter` decides which
            // nudges that applies to — a nudge the in-flight stroke raised is not
            // one of them.
            nudges.dismissOnEdit(revision: revision)
        }
    }

    // MARK: Chrome

    @ViewBuilder
    private func chrome(in geo: GeometryProxy) -> some View {
        switch layout {
        case .rail: regularChrome(in: geo)
        case .dock: dockChrome(in: geo)
        case .compactRail: compactRailChrome(in: geo)
        }
    }

    // MARK: Regular width (iPad)

    private func regularChrome(in geo: GeometryProxy) -> some View {
        ZStack(alignment: .topLeading) {
            // Rail, full height, inset from every edge.
            StudioRail(model: model, metrics: metrics, panel: $panel, showLayers: $showLayers,
                       onClear: { showClearConfirm = true }, onDownload: download)
                .padding(.vertical, metrics.railInset)
                .padding(.leading, metrics.railInset)
                .frame(maxHeight: .infinity, alignment: .top)

            // Top bar: readout leading, actions trailing, clear of the rail.
            HStack(alignment: .top) {
                readout
                Spacer(minLength: 12)
                topActions
            }
            .padding(.leading, metrics.popoverAnchor)
            .padding(.trailing, metrics.railInset)
            .padding(.top, metrics.railInset)

            if showsEdgeSliders {
                EdgeSliders(model: model)
                    .padding(.trailing, metrics.edgeInset)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .trailing)
            }

            ZoomBadge(scale: model.viewScale) { model.resetView() }
                .padding(.trailing, metrics.edgeInset)
                .padding(.bottom, 20)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)

            floatingPanels(in: geo)
            removeStrokeBar
            toast
                .padding(.leading, metrics.popoverAnchor)
                // In portrait the layers panel occupies this same corner, so the
                // toast rides above it. `layersCardHeight` is already measured
                // for the card's own frame, so this is not a second guess at it.
                .padding(.bottom, 20 + (layersDocksBottomLeading(in: geo) && showLayers
                                        ? layersCardHeight + 12 : 0))
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
        }
    }

    private func layersDocksBottomLeading(in geo: GeometryProxy) -> Bool {
        geo.size.height > geo.size.width
    }

    /// Rail-anchored cards. The layers panel docks top-right and everything else
    /// hangs off the rail on the left, so the centre stays clear in every
    /// combination — including both open at once, which `IPadLayers` shows.
    @ViewBuilder
    private func floatingPanels(in geo: GeometryProxy) -> some View {
        let maxCardHeight = max(200, geo.size.height - metrics.railInset * 2 - 56)
        // The layers panel is top-anchored on the trailing side and the edge
        // sliders are vertically centred there, so an unbounded panel grows into
        // them. Capping it at the midline keeps both usable; a taller stack
        // scrolls, which is the right answer anyway.
        let maxLayersHeight = max(200, geo.size.height / 2 - 64 - 24)

        if showLayers {
            let card = scrollableCard(maxHeight: maxLayersHeight, measured: $layersCardHeight) {
                LayersPanel(model: model,
                            onEditSymmetry: { panel = .symmetry($0) },
                            onNudge: { nudges.show($0, atRevision: model.revision) })
                    // Injected explicitly. The panel reads `auth` (for the Plus
                    // surface gate) and `router` (to ask the You tab to open the
                    // sheet), and a missing EnvironmentObject is a CRASH at the
                    // moment the view renders, not a compile error. RootView
                    // already re-injects `auth` on the save sheet for the same
                    // reason, which is this codebase recording that it has been
                    // bitten by a presentation boundary here before.
                    .environmentObject(auth)
                    .environmentObject(router)
            }
            // DESIGN.md §2: top-right on a landscape regular-width screen,
            // bottom-left in portrait (frame `IPadPortrait`). Portrait has the
            // height to spare down there and none to spare beside the edge
            // sliders, which are vertically centred.
            if geo.size.height > geo.size.width {
                card
                    .padding(.leading, metrics.popoverAnchor)
                    .padding(.bottom, 20)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
                    .transition(cardTransition)
            } else {
                card
                    .padding(.trailing, 80)
                    .padding(.top, 64)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                    .transition(cardTransition)
            }
        }

        if hasLeadingPanel {
            scrollableCard(maxHeight: maxCardHeight, measured: $leadingCardHeight) { leadingPanel }
                .padding(.leading, metrics.popoverAnchor)
                .padding(.top, 64)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .transition(cardTransition)
        }
    }

    /// Everything except the layers panel hangs off the rail on the left. Split
    /// out as a Bool because a `@ViewBuilder` returns `some View`, never an
    /// optional — `if let` on one silently does not compile.
    private var hasLeadingPanel: Bool { panel != nil }

    @ViewBuilder
    private var leadingPanel: some View {
        switch panel {
        case .brush: BrushPopover(model: model, pencilSeen: model.pencilSeen)
        case .color: ColorPopover(model: model, customColor: $customColor)
        case .symmetry(let id): SymmetryPopover(model: model, layerId: id) { panel = nil }
        default: EmptyView()
        }
    }

    /// Cards scroll rather than clip. On a landscape phone the brush card is
    /// taller than the screen; clipping it would put "Smooth strokes" somewhere
    /// no gesture can reach.
    ///
    /// The height is MEASURED rather than inferred. A `ScrollView` claims every
    /// point of height it is offered and its ideal height is unbounded, so
    /// neither `.frame(maxHeight:)` nor `.fixedSize()` shrinks it — both were
    /// tried, and both produced a full-height card with a 280pt panel floating in
    /// the middle of it (and, on the iPad, a card that reached across the SIZE
    /// edge slider). Measuring the content and pinning the frame to
    /// `min(content, max)` is the only version that both fits the content and
    /// still scrolls when the content is genuinely taller than the screen.
    private func scrollableCard<Content: View>(maxHeight: CGFloat,
                                               measured: Binding<CGFloat>,
                                               @ViewBuilder content: () -> Content) -> some View {
        ScrollView {
            content()
                .background(GeometryReader { g in
                    Color.clear.preference(key: CardHeightKey.self, value: g.size.height)
                })
        }
        .scrollBounceBehavior(.basedOnSize)
        .fixedSize(horizontal: true, vertical: false) // width comes from the card
        .frame(height: min(max(measured.wrappedValue, 1), maxHeight))
        .onPreferenceChange(CardHeightKey.self) { measured.wrappedValue = $0 }
        .cardBackground()
    }

    private var cardTransition: AnyTransition {
        // DESIGN.md §7: 120ms fade + a 4px rise, none under reduced motion.
        reduceMotion ? .opacity : .opacity.combined(with: .offset(y: 4))
    }

    // MARK: Compact width (phone portrait)

    private func dockChrome(in geo: GeometryProxy) -> some View {
        VStack(spacing: 0) {
            HStack(alignment: .top) {
                readout
                Spacer(minLength: 8)
                topActions
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)

            Spacer(minLength: 0)

            toast.padding(.horizontal, 16).padding(.bottom, 8)
            removeStrokeBar.padding(.horizontal, 16).padding(.bottom, 8)

            PhoneStrip(model: model, customColor: $customColor, panel: $panel)
                .padding(.bottom, 8)

            PhoneDock(model: model, metrics: metrics, panel: $panel, showLayers: $showLayers,
                      onClear: { showClearConfirm = true }, onDownload: download)
                .padding(.horizontal, metrics.dockInset)
        }
    }

    // MARK: Compact height (phone landscape)

    private func compactRailChrome(in geo: GeometryProxy) -> some View {
        ZStack(alignment: .topLeading) {
            CompactRail(model: model, metrics: metrics, panel: $panel, showLayers: $showLayers,
                        onClear: { showClearConfirm = true }, onDownload: download)
                .padding(.leading, metrics.railInset)
                .frame(maxHeight: .infinity, alignment: .center)

            // Save only, top-right (DESIGN.md §2).
            PrimaryAction(title: "Save", systemImage: "sparkles",
                          height: metrics.actionHeight, isEnabled: !model.isEmpty, action: onSave)
                .padding(.trailing, metrics.railInset)
                .padding(.top, metrics.railInset)
                .frame(maxWidth: .infinity, alignment: .trailing)

            VStack(alignment: .trailing, spacing: 8) {
                SwatchRow(model: model, customColor: $customColor, swatchSize: 22)
                readout
            }
            .padding(.trailing, metrics.railInset)
            .padding(.bottom, 12)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)

            floatingPanels(in: geo)
            removeStrokeBar
            toast
                .padding(.leading, metrics.popoverAnchor)
                .padding(.bottom, 12)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
        }
    }

    // MARK: Shared pieces

    private var readout: some View {
        ReadoutCapsule(
            text: Readout.capsule(layerIndex: activeIndex, sym: model.symmetry,
                                  brushSize: model.size, zoom: model.viewScale,
                                  removeMode: model.removeStrokeMode, layout: layout),
            spoken: Readout.spokenCapsule(layerName: model.activeLayer.name, sym: model.symmetry,
                                          brushSize: model.size, zoom: model.viewScale,
                                          removeMode: model.removeStrokeMode),
            height: metrics.readoutHeight)
    }

    private var activeIndex: Int {
        model.layers.firstIndex { $0.id == model.activeLayerId } ?? 0
    }

    /// Download · Save · Gallery · Help on regular width; the phone keeps only
    /// Download (icon) and Save, because the tab bar already reaches the gallery.
    @ViewBuilder
    private var topActions: some View {
        HStack(spacing: 8) {
            GhostAction(title: "Download", systemImage: "square.and.arrow.down",
                        height: metrics.actionHeight, compact: layout != .rail,
                        isEnabled: !model.isEmpty,
                        accessibilityLabelText: "Download PNG", action: download)

            PrimaryAction(title: "Save", systemImage: "sparkles",
                          height: metrics.actionHeight, compact: false,
                          isEnabled: !model.isEmpty, action: onSave)

            if layout == .rail {
                GhostAction(title: "Gallery", systemImage: "square.grid.2x2",
                            height: metrics.actionHeight, compact: true,
                            accessibilityLabelText: "Gallery") {
                    router.tab = AppRouter.galleryTab
                }
                GhostAction(title: "Help", systemImage: "questionmark",
                            height: metrics.actionHeight, compact: true,
                            accessibilityLabelText: "Help") { showHelp = true }
            }
        }
    }

    @ViewBuilder
    private var removeStrokeBar: some View {
        if let hit = model.pendingHit {
            RemoveStrokeBar(model: model, hit: hit)
                .padding(.top, 64)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                .transition(cardTransition)
        }
    }

    @ViewBuilder
    private var toast: some View {
        if let nudge = nudges.current {
            StudioToast(systemImage: nudge.systemImage, message: nudge.message,
                        actionTitle: nudge.actionTitle,
                        action: nudgeAction(nudge),
                        onDismiss: { nudges.dismiss() })
                .transition(cardTransition)
        }
    }

    private func nudgeAction(_ nudge: StudioNudge) -> (() -> Void)? {
        switch nudge {
        case .pencilDetected:
            return { panel = .brush; nudges.dismiss() }
        case .hiddenLayer(let id, _):
            // By ID, never by name. Names are user-editable and need not be
            // unique, so a name lookup can unhide a layer the user never drew
            // on while the one that actually refused stays hidden — and the
            // next stroke is refused again, with the CTA still not working.
            return {
                model.setLayerVisible(id, true)
                nudges.dismiss()
            }
        default:
            return nil
        }
    }

    // MARK: Sheets (compact width)

    private var sheetBinding: Binding<Bool> {
        Binding(
            get: { (panel != nil || showLayers) && !layout.usesPopovers },
            set: { if !$0 { panel = nil; showLayers = false } }
        )
    }

    @ViewBuilder
    private var panelSheet: some View {
        Group {
            switch panel {
            case .brush: BrushPopover(model: model, pencilSeen: model.pencilSeen)
            case .color: ColorPopover(model: model, customColor: $customColor)
            case .symmetry(let id): SymmetryPopover(model: model, layerId: id) { panel = nil }
            case nil:
                if showLayers {
                    LayersPanel(model: model,
                                onEditSymmetry: { showLayers = false; panel = .symmetry($0) },
                                onNudge: { nudges.show($0, atRevision: model.revision) })
                        // The phone path, and the one that actually needs this:
                        // a `.sheet` is a separate presentation, so inheritance
                        // is the thing not to rely on.
                        .environmentObject(auth)
                        .environmentObject(router)
                }
            }
        }
        .frame(maxWidth: .infinity)
        // Clear of the drag indicator. The indicator is drawn INSIDE the sheet's
        // top inset, so a card whose own padding starts at 14pt has its title row
        // struck through by it — the Brush sheet's "Brush" / "TOUCH" header was
        // sitting underneath the grabber. The popover presentation has no
        // indicator, so this padding belongs here and not in the card.
        .padding(.top, 18)
        // DESIGN.md §2: a phone sheet never exceeds a third of the height at
        // rest. `.large` stays available because the brush card is taller than
        // a third of a phone and its last row must still be reachable.
        .presentationDetents([.fraction(0.34), .large])
        .presentationDragIndicator(.visible)
        .presentationBackground(Blueprint.graphCard)
    }

    // MARK: Export

    /// The image the Download button shares. **v2, not v1**: `currentDrawing()`
    /// projects the document down to a single layer under one symmetry and
    /// strips per-layer opacity and stroke smoothing, so a layered piece
    /// downloaded through it is provably not the picture on screen. Exported
    /// through `currentDrawingV2()` the download and the canvas render from one
    /// document. (`KaleidoRenderer.paintDrawing` paints visible layers only,
    /// which is the same rule `model.isEmpty` gates the button on, so no ink can
    /// reach the file that was not on screen.)
    ///
    /// `size` exists so the export probe can fingerprint this exact function at
    /// a cheap resolution. Rendering the probe's "what the button produces" at a
    /// DIFFERENT size than its "what v1 would produce" comparison makes the two
    /// fingerprints differ for the trivial reason that the buffers are different
    /// shapes — which silently turns the whole test vacuous. (It did: the first
    /// version of this passed with `currentDrawing()` restored.)
    private func exportImage(size: CGFloat = StudioExport.imageSize) -> UIImage {
        StudioExport.renderSquare(model.currentDrawingV2(), size: size)
    }

    private func download() {
        guard let png = exportImage().pngData() else { return }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("kaleidoscope.png")
        do {
            try png.write(to: url)
            shareItem = ShareItem(url: url)
        } catch {
            // Non-fatal: sharing simply won't open.
        }
    }

    /// Launch-gated export fingerprints for the UI tests (KALEIDO_EXPORT_PROBE=1).
    /// Fingerprints the SAME `exportImage()` the Download button shares, so the
    /// test can never pass against a code path the button does not take.
    @ViewBuilder
    private var exportProbe: some View {
        if ExportProbe.enabled {
            ExportProbeView(report: ExportProbe.report(
                exported: exportImage(size: ExportProbe.probeSize), model: model))
        }
    }
}

/// Gestures a user cannot discover by looking. Deliberately short: this is a
/// reference for the things with no on-screen affordance, not a manual.
struct StudioHelpSheet: View {
    @Environment(\.dismiss) private var dismiss

    private let rows: [(String, String, String)] = [
        ("hand.pinch", "Pinch to zoom", "Up to 8×. Double-tap the canvas to snap back to 100%."),
        ("hand.draw", "Two fingers pan", "One finger draws unless you turn that off in Brush."),
        ("applepencil.tip", "Pencil double-tap", "Switches to Remove stroke and back."),
        ("scissors", "Remove a stroke", "Tap it once to highlight every image of it, again to delete."),
        ("square.3.layers.3d", "Layers", "Each layer keeps its own symmetry. Hiding one is not an undo step.")
    ]

    var body: some View {
        NavigationStack {
            List(rows, id: \.1) { row in
                Label {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.1).font(.subheadline.weight(.medium))
                        Text(row.2).font(.footnote).foregroundStyle(Blueprint.graphite.opacity(0.72))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                } icon: {
                    Image(systemName: row.0).foregroundStyle(Blueprint.craneStrong)
                }
                .padding(.vertical, 2)
            }
            .navigationTitle("Gestures")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

private struct ShareItem: Identifiable {
    let id = UUID()
    let url: URL
}

/// UIActivityViewController bridge for sharing/saving the exported PNG.
struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

/// A button-style toggle whose **selected** state uses an explicit, WCAG-tuned
/// fill + a pinned label color, so the label clears 4.5:1 against the fill in
/// both themes. `.toggleStyle(.button)` instead fills the selected state with the
/// raw tint and lets the *system* pick the label color, which is not statically
/// verifiable and drops below 4.5:1 on light tints (white on gold `sax` ~1.6:1;
/// white on `graphite` in dark mode). The **off** state renders the label in
/// neutral `graphite` on a faint fill — also deterministic, and it fixes the old
/// tinted-off labels (gold `sax` off-label was 1.96:1). See
/// ios/ACCESSIBILITY_CONTRAST.md.
struct ContrastToggleStyle: ToggleStyle {
    /// Fill behind the label when selected (a dark-enough `*Button` token, or a
    /// gold/graphite fill paired with a dark/flipping `onLabel`).
    var onFill: Color
    /// Label color when selected — pinned so it is never system-chosen.
    var onLabel: Color

    func makeBody(configuration: Configuration) -> some View {
        Button {
            configuration.isOn.toggle()
        } label: {
            configuration.label
                .foregroundStyle(configuration.isOn ? onLabel : Blueprint.graphite)
                .padding(.horizontal, 14)
                .padding(.vertical, 7)
                .background {
                    let shape = RoundedRectangle(cornerRadius: 8, style: .continuous)
                    if configuration.isOn {
                        shape.fill(onFill)
                    } else {
                        // Faint neutral fill echoes the unselected bordered look.
                        shape.fill(Blueprint.graphite.opacity(0.10))
                    }
                }
                .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .buttonStyle(.plain)
        // Preserve the "selected" trait the system button-toggle exposes when on.
        .accessibilityAddTraits(configuration.isOn ? .isSelected : [])
    }
}

/// Natural height of a popover card's content — see `StudioView.scrollableCard`.
private struct CardHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}
