import AuthenticationServices
import SwiftUI

/// The native Apple button (required by HIG / Guideline 4.8). Tapping runs our
/// own flow via AuthModel so we control the nonce + server exchange.
struct AppleSignInButton: UIViewRepresentable {
    var colorScheme: ColorScheme
    var action: () -> Void

    func makeUIView(context: Context) -> ASAuthorizationAppleIDButton {
        let style: ASAuthorizationAppleIDButton.Style = colorScheme == .dark ? .white : .black
        let button = ASAuthorizationAppleIDButton(authorizationButtonType: .signIn, authorizationButtonStyle: style)
        button.cornerRadius = 12
        button.addTarget(context.coordinator, action: #selector(Coordinator.tapped), for: .touchUpInside)
        return button
    }

    func updateUIView(_ uiView: ASAuthorizationAppleIDButton, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(action: action) }

    final class Coordinator: NSObject {
        let action: () -> Void
        init(action: @escaping () -> Void) { self.action = action }
        @objc func tapped() { action() }
    }
}

/// Sign-in sheet. Apple is first and at least as prominent as Google (same size
/// + position), satisfying Guideline 4.8.
struct AuthSheet: View {
    @EnvironmentObject var auth: AuthModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    /// Optional context line, e.g. "Sign in to save your piece."
    var reason: String?

    var body: some View {
        VStack(spacing: 20) {
            Spacer()
            RosetteMark(lineWidth: 3)
                .frame(width: 64, height: 64)
            Text("Sign in to Kaleidoscope")
                .font(.title2.bold())
                .foregroundStyle(Blueprint.graphite)
            Text(reason ?? "Save your work to the gallery, share links, and remix pieces. Drawing and PNG export are always free.")
                .font(.subheadline)
                .foregroundStyle(Blueprint.graphite.opacity(0.75))
                .multilineTextAlignment(.center)
                .padding(.horizontal)

            VStack(spacing: 12) {
                // Apple first + equal size => at least as prominent as Google.
                AppleSignInButton(colorScheme: colorScheme) {
                    Task { await auth.signInWithApple(); dismissIfSignedIn() }
                }
                .frame(height: 50)
                .frame(maxWidth: .infinity)

                Button {
                    Task { await auth.signInWithGoogle(); dismissIfSignedIn() }
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "globe")
                        Text("Continue with Google").fontWeight(.medium)
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: 50)
                }
                .buttonStyle(.bordered)
                .tint(Blueprint.graphite)
            }
            .padding(.horizontal)
            .disabled(auth.isBusy)
            .overlay { if auth.isBusy { ProgressView() } }

            if let error = auth.errorMessage {
                Text(error).font(.footnote).foregroundStyle(.red).multilineTextAlignment(.center)
            }
            Spacer()
            Button("Not now") { dismiss() }
                .font(.footnote)
                .tint(Blueprint.crease)
                .padding(.bottom)
        }
        .padding()
        .background(Blueprint.graph.ignoresSafeArea())
    }

    private func dismissIfSignedIn() {
        if auth.isSignedIn { dismiss() }
    }
}
