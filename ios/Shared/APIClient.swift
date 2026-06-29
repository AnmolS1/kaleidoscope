import Foundation

enum APIError: Error { case badResponse }

/// Thin async wrapper over `GET /api/gallery/random?count=`.
struct APIClient {
    var baseURL: URL = Config.baseURL
    var session: URLSession = .shared

    func randomItems(count: Int) async throws -> [GalleryItem] {
        let endpoint = baseURL.appendingPathComponent("api/gallery/random")
        var comps = URLComponents(url: endpoint, resolvingAgainstBaseURL: false)!
        comps.queryItems = [URLQueryItem(name: "count", value: String(count))]

        var req = URLRequest(url: comps.url!)
        // The selection must be fresh every reload (the server also sends Cache-Control: no-store).
        req.cachePolicy = .reloadIgnoringLocalCacheData

        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw APIError.badResponse
        }
        return try JSONDecoder().decode(GalleryResponse.self, from: data).items
    }
}
