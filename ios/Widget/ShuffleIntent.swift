import WidgetKit
import AppIntents

/// The interactive "new one now" affordance. Reloading the timeline from a Button intent is
/// exempt from the daily refresh budget, so the user can shuffle as often as they like.
struct ShuffleIntent: AppIntent {
    static var title: LocalizedStringResource { "Shuffle" }
    static var description: IntentDescription { IntentDescription("Show a new random piece now.") }

    func perform() async throws -> some IntentResult {
        await WidgetCenter.shared.reloadTimelines(ofKind: RandomWidget.kind)
        return .result()
    }
}
