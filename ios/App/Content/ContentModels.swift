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
    let segments: Int
    let mirror: Bool
    let width: Int
    let height: Int
    let palette: [String]
    let remixOf: String?
    let likes: Int
    let createdAt: Double
    let urls: ArtworkURLs
}

struct ArtworkURLs: Codable {
    let image: String
    let thumb: String
    let vector: String
}

struct SaveResponse: Codable {
    let id: String
    let url: String
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
