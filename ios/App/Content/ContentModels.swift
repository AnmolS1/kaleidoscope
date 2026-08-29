import Foundation

struct GalleryAuthor: Codable, Equatable {
    let name: String?
    let avatar: String?
}

/// A public gallery card (`GET /api/gallery`).
struct GalleryCard: Codable, Identifiable, Equatable {
    let id: String
    let title: String
    let author: GalleryAuthor?
    let thumb: String
    let likes: Int
    let createdAt: Double
    /// AI alt text for the artwork image (VoiceOver). Optional so responses
    /// predating the alt-text backend still decode; `accessibleAltText` supplies
    /// a synthesized fallback at the call site.
    let altText: String?
}

struct GalleryPage: Codable {
    let items: [GalleryCard]
    let nextCursor: String?
}

/// The caller's own piece (`GET /api/users/me/artworks`).
struct MyArtwork: Codable, Identifiable, Equatable {
    let id: String
    let title: String
    let visibility: String
    let thumb: String
    let likes: Int
    let createdAt: Double
    let altText: String?
}

struct MyArtworksPage: Codable {
    let items: [MyArtwork]
    let nextCursor: String?
}

/// Full artwork metadata (`GET /api/artworks/:id`).
struct ArtworkDetail: Codable, Identifiable {
    let id: String
    let title: String
    let visibility: String
    let author: GalleryAuthor
    let isOwner: Bool
    /// 0 is the contract's "the visible layers disagree" signal — it means
    /// LAYERED, and is never "0-fold". See `ArtworkMeta`.
    let segments: Int
    let mirror: Bool
    let width: Int
    let height: Int
    let palette: [String]
    let remixOf: String?
    let likes: Int
    let createdAt: Double
    let urls: ArtworkURLs
    let altText: String?
    /// Layer count. Optional so rows saved before 1.2 still decode.
    let layers: Int?
    /// NULL on legacy rows until the backfill runs; a missing hash is
    /// "unknown", never "no duplicate".
    let contentHash: String?
}

/// How a piece describes its own symmetry.
///
/// `segments == 0` is the stored signal that the visible layers disagree, so
/// the piece is *layered* — printing "0-fold" there is the bug this type
/// exists to make unrepresentable. Single-layer pieces keep the fold copy.
enum ArtworkMeta {
    /// The one-line summary under the title: "12-fold · mirrored" or
    /// "Layered · 3 layers".
    static func summary(segments: Int, mirror: Bool, layers: Int?) -> String {
        if segments == 0 { return "Layered · \(layerPhrase(layers ?? 0))" }
        return "\(segments)-fold · \(mirror ? "mirrored" : "rotational")"
    }

    /// The sentence form used in the header and in VoiceOver.
    static func headline(author: String?, segments: Int, mirror: Bool, layers: Int?) -> String {
        let by = author.map { " by \($0)" } ?? ""
        if segments == 0 {
            return "A layered kaleidoscope drawing\(by) · \(layerPhrase(layers ?? 0))"
        }
        return "A \(segments)-fold \(mirror ? "mirrored" : "rotational") kaleidoscope drawing\(by)"
    }

    /// Whether the layer chip should show at all — a 1-layer or unknown-layer
    /// piece has nothing to say.
    static func layerChip(_ layers: Int?) -> String? {
        guard let n = layers, n > 1 else { return nil }
        return layerPhrase(n)
    }

    static func layerPhrase(_ n: Int) -> String { n == 1 ? "1 layer" : "\(n) layers" }
}

/// `GET /api/artworks/hash/:sha` — the save dialog's pre-flight.
struct HashLookup: Codable, Equatable {
    /// The caller's own piece with this exact picture.
    let mine: String?
    /// Someone else's, and only when it is VIEWABLE. A private twin comes back
    /// as null here (no leak) and still 409s on POST, which is a different
    /// dialog state — so nil here does not mean "no twin exists".
    let other: HashOther?
}

struct HashOther: Codable, Equatable {
    let id: String
    let title: String
    let author: String?
}

struct ArtworkURLs: Codable {
    let image: String
    let thumb: String
    let vector: String
}

/// `POST /api/artworks` → 201.
///
/// `capReached` is the case that made this more than `{id, url}`: a save that
/// hits the public cap still returns **201 with the piece stored**, unlisted.
/// Decoding only `id`/`url` reports that as an ordinary success and the user is
/// shown a piece they believe is public.
struct SaveResponse: Codable {
    let id: String
    let url: String
    let visibility: String?
    let capReached: Bool?
    let cap: Int?
    let count: Int?
    /// 200, not 201: the same user already had this exact picture.
    let deduped: Bool?
}

struct SuggestNamesResponse: Codable {
    let names: [String]
}

enum Visibility: String, CaseIterable, Identifiable {
    case `public`, unlisted, `private`
    var id: String { rawValue }
    var label: String {
        switch self {
        case .public: return "Public"
        case .unlisted: return "Unlisted"
        case .private: return "Private"
        }
    }
    var caption: String {
        switch self {
        case .public: return "Shown in the public gallery."
        case .unlisted: return "Only people with the link."
        case .private: return "Only you."
        }
    }
}
