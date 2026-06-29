import Foundation

/// One public artwork as returned by `GET /api/gallery/random`.
struct GalleryItem: Codable, Identifiable, Hashable {
    let id: String
    let title: String
    let author: String?
    let imageUrl: String
    let permalink: String
}

/// `{ "items": [ … ] }`
struct GalleryResponse: Codable {
    let items: [GalleryItem]
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
            permalink: "\(base)/p/\(id)"
        )
    }
}
