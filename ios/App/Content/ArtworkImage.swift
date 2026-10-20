import SwiftUI

/// An artwork image loaded WITH the session.
///
/// 🔴 `AsyncImage` cannot show a private piece. It issues a bare `URLSession`
/// request with no `Authorization` header, and `/api/artworks/:id/image` runs
/// `canView` — a private piece answers **404 to an unauthenticated caller**, so
/// the view falls to its placeholder and the piece renders as an empty
/// rectangle. Every other read in this app sends the bearer token; the media
/// URLs were the one place that did not, because they were handed to a system
/// view instead of going through `AuthClient`.
///
/// It looked like a rendering bug and was an authentication one: the drawing was
/// stored perfectly, which is why Remix — which fetches the VECTOR, with the
/// token — showed the same piece correctly.
///
/// The web never had this because a browser attaches the session cookie to an
/// `<img>` request on its own. Nothing in the e2e suite could have caught it.
struct ArtworkImage<Content: View, Placeholder: View>: View {
    let url: URL
    /// Nil is legitimate: public and unlisted pieces load signed out, and the
    /// gallery is browsable without an account.
    let token: String?
    @ViewBuilder var content: (Image) -> Content
    @ViewBuilder var placeholder: () -> Placeholder

    @State private var loaded: UIImage?
    @State private var failed = false

    var body: some View {
        Group {
            if let loaded {
                content(Image(uiImage: loaded))
            } else {
                placeholder()
            }
        }
        // Keyed on both, so signing in re-fetches a piece that 404'd while
        // signed out rather than leaving the placeholder standing.
        .task(id: TaskKey(url: url, token: token)) { await load() }
    }

    private struct TaskKey: Equatable {
        let url: URL
        let token: String?
    }

    private func load() async {
        loaded = nil
        failed = false
        do {
            let data = try await ArtworkImageLoader.shared.data(for: url, token: token)
            guard let img = UIImage(data: data) else { failed = true; return }
            loaded = img
        } catch {
            failed = true
        }
    }
}
