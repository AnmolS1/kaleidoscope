import SwiftUI
import KaleidoEngine

/// The remove-stroke confirm capsule (DESIGN.md §3, frame IPadRemoveStroke).
///
/// `Stroke on **Ribbons** · 6 images` · **Delete** · Cancel. The image count is
/// the point of the sentence: a user about to delete one arc needs to know that
/// twelve of them will disappear, and that number comes from the layer's own
/// symmetry, not the drawing's.
///
/// The capsule is the SECOND half of a two-phase gesture — the first tap already
/// highlighted the stroke on the canvas — which is what makes an accidental
/// Pencil double-tap into this mode harmless.
struct RemoveStrokeBar: View {
    @ObservedObject var model: StudioModel
    let hit: StrokeHit

    private var layer: LayerSummary? {
        model.layers.first { $0.id == hit.layerId }
    }

    private var images: Int {
        guard let sym = layer?.sym else { return 0 }
        return KaleidoEngine.imageCount(segments: sym.segments, mirror: sym.mirror)
    }

    var body: some View {
        HStack(spacing: 8) {
            (Text("Stroke on ") + Text(layer?.name ?? "").bold()
                + Text(" · \(images) images"))
                .font(.footnote)
                .foregroundStyle(Blueprint.graphite)

            PrimaryAction(title: "Delete", systemImage: "trash", height: 30) {
                model.deleteStroke(layerId: hit.layerId, index: hit.index)
            }
            Button { model.pendingHit = nil } label: {
                Chip { Text("Cancel") }
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Cancel")
        }
        .padding(.leading, 12)
        .padding(.trailing, 8)
        .padding(.vertical, 8)
        .cardBackground()
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Stroke on \(layer?.name ?? ""), \(images) images")
        .accessibilityIdentifier("remove-stroke-bar")
    }
}
