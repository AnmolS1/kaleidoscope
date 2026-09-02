import Foundation

/// Single place for the endpoints the app + widget talk to.
enum Config {
    /// Where the random *selection* JSON is fetched from. Points at production so the build
    /// works on a real device (on a phone, 127.0.0.1 is the phone itself, not your Mac).
    ///
    /// For local Simulator iteration, set `KALEIDO_BASE_URL` in the scheme's
    /// environment (e.g. `http://127.0.0.1:8787` for `wrangler dev --remote`)
    /// rather than editing this line. An uncommitted source edit is a change
    /// that can be committed by accident and cannot be seen in a diff review;
    /// an environment variable cannot leave the machine. DEBUG only — the
    /// string is inside the `#if`, which is what actually keeps it out of a
    /// Release binary.
    static let baseURL: URL = {
        #if DEBUG
            if let raw = ProcessInfo.processInfo.environment["KALEIDO_BASE_URL"],
               let url = URL(string: raw) {
                return url
            }
        #endif
        return URL(string: "https://kaleidoscope.ponderance.dev")!
    }()

    /// The public website. Used for artwork PERMALINKS and as a fallback host
    /// for deep links — deliberately NOT for any "draw on the web" call to
    /// action, which would be a Guideline 3.1.1 exposure once Plus is buyable
    /// there. See AboutView.
    static let webURL = URL(string: "https://kaleidoscope.ponderance.dev")!

    /// URL scheme the widget uses to open a specific piece in the app.
    static let urlScheme = "kaleidoscopewidget"
}
