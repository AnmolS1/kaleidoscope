import SwiftUI
import KaleidoEngine

/// The save flow: title (with AI-suggested chips), visibility, then upload.
/// Rendering + name suggestions run on appear; a slow/failed suggestion simply
/// shows nothing and never blocks the save.
struct SaveSheet: View {
    let drawing: Drawing
    var remixOf: String?
    var onSaved: (String) -> Void

    @EnvironmentObject var auth: AuthModel
    @Environment(\.dismiss) private var dismiss

    @State private var title = ""
    @State private var visibility: Visibility = .public
    @State private var suggestions: [String] = []
    @State private var saving = false
    @State private var errorText: String?

    private let client = AuthClient()

    var body: some View {
        NavigationStack {
            Form {
                Section("Title") {
                    TextField("Untitled", text: $title)
                    if !suggestions.isEmpty {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) {
                                ForEach(suggestions, id: \.self) { name in
                                    Button { title = name } label: {
                                        Text(name).font(.caption).lineLimit(1)
                                    }
                                    .buttonStyle(.bordered)
                                    .tint(Blueprint.sax)
                                }
                            }
                        }
                        .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 8, trailing: 16))
                    }
                }

                Section("Visibility") {
                    Picker("Visibility", selection: $visibility) {
                        ForEach(Visibility.allCases) { v in Text(v.label).tag(v) }
                    }
                    .pickerStyle(.segmented)
                    Text(visibility.caption).font(.caption).foregroundStyle(.secondary)
                }

                if let errorText {
                    Section { Text(errorText).font(.footnote).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Save piece")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }
                        .disabled(saving)
                        .fontWeight(.semibold)
                }
            }
            .overlay { if saving { ProgressView("Saving…").padding().background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12)) } }
            .task { await loadSuggestions() }
        }
    }

    private func loadSuggestions() async {
        guard let token = auth.session?.token else { return }
        guard let thumb = StudioExport.renderSquare(drawing, size: StudioExport.thumbSize).pngData() else { return }
        let names = try? await client.suggestNames(
            thumbPNG: thumb,
            segments: drawing.sym.segments,
            mirror: drawing.sym.mirror,
            palette: paletteOf(drawing),
            token: token
        )
        suggestions = names ?? []
    }

    private func save() async {
        guard let session = auth.session else { errorText = "Please sign in again."; return }
        guard let renders = StudioExport.exportSet(drawing) else {
            errorText = "Couldn't render the image."
            return
        }
        saving = true
        defer { saving = false }
        let payload = AuthClient.SavePayload(
            drawing: serialize(drawing),
            image: renders.image,
            thumb: renders.thumb,
            og: renders.og,
            title: title.trimmingCharacters(in: .whitespacesAndNewlines),
            visibility: visibility.rawValue,
            width: Int(StudioExport.imageSize),
            height: Int(StudioExport.imageSize),
            remixOf: remixOf
        )
        do {
            let result = try await client.saveArtwork(payload, token: session.token, csrf: session.csrf)
            onSaved(result.id)
            dismiss()
        } catch {
            errorText = "Couldn't save. Please try again."
        }
    }
}
