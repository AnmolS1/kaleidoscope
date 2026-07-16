import Foundation

/// One public artwork as returned by `GET /api/gallery/random`.
struct GalleryItem: Codable, Identifiable, Hashable {
    let id: String
    let title: String
    let author: String?
    let imageUrl: String
    let permalink: String
    /// AI alt text for the artwork image (VoiceOver, widget). Optional so a
    /// response predating the alt-text backend still decodes.
    let altText: String?
}

/// `{ "items": [ … ] }`
struct GalleryResponse: Codable {
    let items: [GalleryItem]
}

/// A non-empty accessibility description for an artwork image. Prefers the
/// backend's AI alt text; falls back to a title-based label when it's missing
/// (older responses) or blank, so VoiceOver always announces something useful.
/// Lives in Shared so both the app and the widget extension can use it.
func accessibleAltText(_ altText: String?, title: String) -> String {
    if let altText, !altText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        return altText
    }
    let name = title.trimmingCharacters(in: .whitespacesAndNewlines)
    return name.isEmpty ? "Kaleidoscope artwork" : "Kaleidoscope artwork: \(name)"
}

extension GalleryItem {
    /// Synthesize an item from just an id (used when a deep link names a piece we haven't
    /// fetched). URLs are built against the public website, not the local test base.
    static func fromId(_ id: String) -> GalleryItem {
        let base = Config.webURL.absoluteString
        return GalleryItem(
            id: id,
            title: "Shared piece",
            author: nil,
            imageUrl: "\(base)/api/artworks/\(id)/image",
            permalink: "\(base)/p/\(id)",
            altText: nil
        )
    }
}
