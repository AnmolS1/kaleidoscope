import Foundation

/// Single place for the endpoints the app + widget talk to.
enum Config {
    /// Where the random *selection* JSON is fetched from. Points at production so the build
    /// works on a real device (on a phone, 127.0.0.1 is the phone itself, not your Mac).
    /// For local Simulator iteration you can swap this to `http://127.0.0.1:8787`
    /// (`wrangler dev --remote`) — the app's Info.plist carries a debug-only ATS exception for it.
    static let baseURL = URL(string: "https://kaleidoscope.ponderance.dev")!

    /// The public website. Used for artwork PERMALINKS and as a fallback host
    /// for deep links — deliberately NOT for any "draw on the web" call to
    /// action, which would be a Guideline 3.1.1 exposure once Plus is buyable
    /// there. See AboutView.
    static let webURL = URL(string: "https://kaleidoscope.ponderance.dev")!

    /// URL scheme the widget uses to open a specific piece in the app.
    static let urlScheme = "kaleidoscopewidget"
}
