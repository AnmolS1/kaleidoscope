import WidgetKit
import AppIntents

/// User-pickable cadence for the *visible* rotation (the network reload still obeys the
/// system budget; we pre-bake a timeline of entries spaced this far apart).
enum RefreshInterval: String, AppEnum {
    case fiveMin, fifteenMin, thirtyMin, oneHour, threeHours, sixHours, daily

    static var typeDisplayRepresentation: TypeDisplayRepresentation { "Refresh interval" }

    static var caseDisplayRepresentations: [RefreshInterval: DisplayRepresentation] = [
        .fiveMin: "Every 5 minutes",
        .fifteenMin: "Every 15 minutes",
        .thirtyMin: "Every 30 minutes",
        .oneHour: "Every hour",
        .threeHours: "Every 3 hours",
        .sixHours: "Every 6 hours",
        .daily: "Once a day",
    ]

    var seconds: TimeInterval {
        switch self {
        case .fiveMin: 300
        case .fifteenMin: 900
        case .thirtyMin: 1800
        case .oneHour: 3600
        case .threeHours: 10800
        case .sixHours: 21600
        case .daily: 86400
        }
    }
}

struct ConfigIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource { "Kaleidoscope Widget" }
    static var description: IntentDescription {
        IntentDescription("Show a random public piece and rotate it on your chosen cadence.")
    }

    @Parameter(title: "Rotate every", default: .thirtyMin)
    var interval: RefreshInterval

    static var parameterSummary: some ParameterSummary {
        Summary("Rotate the artwork \(\.$interval)")
    }
}
