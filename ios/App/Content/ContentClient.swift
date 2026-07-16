import Foundation

/// Gallery / artwork / save calls, layered on AuthClient's request helpers.
extension AuthClient {
    private func absolute(_ path: String) -> URL {
        if path.hasPrefix("http") { return URL(string: path)! }
        return URL(string: baseURL.absoluteString + path)!
    }

    /// Absolute URL for a relative media path returned by the API.
    func mediaURL(_ path: String) -> URL { absolute(path) }

    // MARK: Reads (public; Bearer sent when available so `isOwner` is correct)

    func gallery(cursor: String?, token: String?) async throws -> GalleryPage {
        var comps = URLComponents(url: url("api/gallery"), resolvingAgainstBaseURL: false)!
        if let cursor { comps.queryItems = [URLQueryItem(name: "cursor", value: cursor)] }
        var req = URLRequest(url: comps.url!)
        if let token { authorized(&req, token: token, csrf: nil) }
        return try decode(GalleryPage.self, await send(req))
    }

    func myArtworks(cursor: String?, token: String) async throws -> MyArtworksPage {
        var comps = URLComponents(url: url("api/users/me/artworks"), resolvingAgainstBaseURL: false)!
        if let cursor { comps.queryItems = [URLQueryItem(name: "cursor", value: cursor)] }
        var req = URLRequest(url: comps.url!)
        authorized(&req, token: token, csrf: nil)
        return try decode(MyArtworksPage.self, await send(req))
    }

    func artwork(id: String, token: String?) async throws -> ArtworkDetail {
        var req = URLRequest(url: url("api/artworks/\(id)"))
        if let token { authorized(&req, token: token, csrf: nil) }
        return try decode(ArtworkDetail.self, await send(req))
    }

    /// The raw serialized vector for a piece — used to load a remix into the studio.
    func vector(id: String, token: String?) async throws -> String {
        var req = URLRequest(url: url("api/artworks/\(id)/vector"))
        if let token { authorized(&req, token: token, csrf: nil) }
        let data = try await send(req)
        guard let json = String(data: data, encoding: .utf8) else { throw AuthError.decoding }
        return json
    }

    // MARK: Mutations

    func like(id: String, token: String, csrf: String) async throws -> Int {
        var req = URLRequest(url: url("api/artworks/\(id)/like"))
        req.httpMethod = "POST"
        authorized(&req, token: token, csrf: csrf)
        struct R: Codable { let likes: Int }
        return try decode(R.self, await send(req)).likes
    }

    func updateArtwork(id: String, title: String?, visibility: String?, token: String, csrf: String) async throws {
        var body: [String: String] = [:]
        if let title { body["title"] = title }
        if let visibility { body["visibility"] = visibility }
        var req = URLRequest(url: url("api/artworks/\(id)"))
        req.httpMethod = "PATCH"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        authorized(&req, token: token, csrf: csrf)
        _ = try await send(req)
    }

    func deleteArtwork(id: String, token: String, csrf: String) async throws {
        var req = URLRequest(url: url("api/artworks/\(id)"))
        req.httpMethod = "DELETE"
        authorized(&req, token: token, csrf: csrf)
        _ = try await send(req)
    }

    // MARK: AI names + Save (multipart)

    func suggestNames(thumbPNG: Data, segments: Int, mirror: Bool, palette: [String], token: String) async throws -> [String] {
        var parts: [MultipartPart] = [
            .file(name: "thumb", filename: "thumb.png", contentType: "image/png", data: thumbPNG),
            .field(name: "segments", value: String(segments)),
            .field(name: "mirror", value: mirror ? "1" : "0"),
            .field(name: "palette", value: palette.joined(separator: ",")),
        ]
        var req = URLRequest(url: url("api/artworks/suggest-names"))
        req.httpMethod = "POST"
        authorized(&req, token: token, csrf: nil)
        applyMultipart(&req, parts: &parts)
        return try decode(SuggestNamesResponse.self, await send(req)).names
    }

    struct SavePayload {
        var drawing: String
        var image: Data
        var thumb: Data
        var og: Data
        var title: String
        var visibility: String
        var width: Int
        var height: Int
        var remixOf: String?
    }

    func saveArtwork(_ p: SavePayload, token: String, csrf: String) async throws -> SaveResponse {
        var parts: [MultipartPart] = [
            .field(name: "drawing", value: p.drawing),
            .file(name: "image", filename: "image.png", contentType: "image/png", data: p.image),
            .file(name: "thumb", filename: "thumb.png", contentType: "image/png", data: p.thumb),
            .file(name: "og", filename: "og.png", contentType: "image/png", data: p.og),
            .field(name: "title", value: p.title),
            .field(name: "visibility", value: p.visibility),
            .field(name: "width", value: String(p.width)),
            .field(name: "height", value: String(p.height)),
        ]
        if let remixOf = p.remixOf { parts.append(.field(name: "remixOf", value: remixOf)) }
        var req = URLRequest(url: url("api/artworks"))
        req.httpMethod = "POST"
        authorized(&req, token: token, csrf: csrf)
        applyMultipart(&req, parts: &parts)
        return try decode(SaveResponse.self, await send(req))
    }
}

// MARK: - multipart/form-data

enum MultipartPart {
    case field(name: String, value: String)
    case file(name: String, filename: String, contentType: String, data: Data)
}

private func applyMultipart(_ req: inout URLRequest, parts: inout [MultipartPart]) {
    let boundary = "----kaleido-\(UUID().uuidString)"
    req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
    var body = Data()
    func append(_ s: String) { body.append(s.data(using: .utf8)!) }
    for part in parts {
        append("--\(boundary)\r\n")
        switch part {
        case let .field(name, value):
            append("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n")
            append(value)
            append("\r\n")
        case let .file(name, filename, contentType, data):
            append("Content-Disposition: form-data; name=\"\(name)\"; filename=\"\(filename)\"\r\n")
            append("Content-Type: \(contentType)\r\n\r\n")
            body.append(data)
            append("\r\n")
        }
    }
    append("--\(boundary)--\r\n")
    req.httpBody = body
}
