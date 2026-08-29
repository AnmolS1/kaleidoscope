import SwiftUI

/// The "You" tab — account + settings. Signed-out shows a sign-in prompt;
/// signed-in shows the profile with sign-out and (App Store 5.1.1(v)) account
/// deletion. Also hosts the widget walkthrough + About.
struct YouView: View {
    @EnvironmentObject var auth: AuthModel
    @EnvironmentObject var plus: PlusStore
    @State private var showAuth = false
    @State private var confirmDelete = false
    @State private var confirmSignOut = false
    @State private var showPlus = false
    /// The sheet was opened by the "Restore purchase" row, so it should start a
    /// restore rather than wait to be told.
    @State private var plusRestoreOnAppear = false

    /// Avatar/rosette diameter, scaled with Dynamic Type.
    @ScaledMetric(relativeTo: .body) private var avatarSize: CGFloat = 48

    var body: some View {
        NavigationStack {
            List {
                accountSection
                if auth.isSignedIn {
                    Section {
                        NavigationLink { MyPiecesView() } label: {
                            Label("My pieces", systemImage: "square.on.square")
                        }
                    }
                }
                plusSection
                Section("Explore") {
                    NavigationLink { AddWidgetHelp() } label: {
                        Label("Add the widget", systemImage: "rectangle.3.group")
                    }
                    NavigationLink { AboutView() } label: {
                        Label("About Kaleidoscope", systemImage: "info.circle")
                    }
                }
                if auth.isSignedIn {
                    Section {
                        Button(role: .destructive) { confirmDelete = true } label: {
                            Label("Delete account", systemImage: "trash")
                        }
                        .accessibilityHint("Permanently deletes your account and all saved artwork")
                    } footer: {
                        Text("Permanently deletes your account and all your saved artwork. This can't be undone.")
                    }
                }
            }
            .navigationTitle("You")
            .onAppear { if ProcessInfo.processInfo.environment["KALEIDO_AUTH"] == "1" { showAuth = true } }
            .sheet(isPresented: $showAuth) { AuthSheet().environmentObject(auth) }
            .sheet(isPresented: $showPlus) {
                PlusSheet(
                    // "Switch account" and "Sign in to continue" both end up in
                    // the same place; only the starting session differs.
                    onSwitchAccount: {
                        Task {
                            // Sign out FIRST, or signing back in returns to the
                            // very account the purchase cannot be used on.
                            await auth.signOut()
                            showAuth = true
                        }
                    },
                    onSignIn: { showAuth = true },
                    restoreOnAppear: plusRestoreOnAppear
                )
                .environmentObject(auth)
                .environmentObject(plus)
            }
            .alert("Sign out?", isPresented: $confirmSignOut) {
                Button("Sign out", role: .destructive) { Task { await auth.signOut() } }
                Button("Cancel", role: .cancel) {}
            }
            .alert("Delete account?", isPresented: $confirmDelete) {
                Button("Delete", role: .destructive) { Task { await auth.deleteAccount() } }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This permanently removes your account and every piece you've saved. This can't be undone.")
            }
        }
    }

    /// Hidden entirely while `plus.enabled` is false — a nil `plus` block (no
    /// `/api/me` yet, a failed call, an older Worker) counts as false, so the
    /// gate fails CLOSED and an unapproved IAP is invisible.
    @ViewBuilder
    private var plusSection: some View {
        if auth.plus?.enabled == true {
            Section {
                Button {
                    plusRestoreOnAppear = false
                    showPlus = true
                } label: {
                    Label(auth.plus?.active == true ? "Kaleidoscope Plus" : "Get Kaleidoscope Plus",
                          systemImage: "sparkles.rectangle.stack")
                }
                Button {
                    // Opens the sheet AND runs the restore, so the answer lands
                    // somewhere the user can read it. A row that silently
                    // succeeded or silently found nothing looks identical.
                    plusRestoreOnAppear = true
                    showPlus = true
                } label: {
                    Label(PlusCopy.restore, systemImage: "arrow.clockwise")
                }
            } footer: {
                if auth.plus?.active == true {
                    Text(PlusCopy.purchased)
                }
            }
        }
    }

    @ViewBuilder
    private var accountSection: some View {
        Section {
            if let user = auth.user {
                HStack(spacing: 14) {
                    avatar(user)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(user.name ?? "Signed in").font(.headline).foregroundStyle(Blueprint.graphite)
                        // `AccountAndCap`: the mono counter under the name. The
                        // frame's price chip beside "Kaleidoscope Plus" is web
                        // only (3.1.1) and is deliberately absent. `publicCap` is
                        // genuinely nullable and null means "no cap", not zero.
                        if let plusState = auth.plus, plusState.enabled, let cap = plusState.publicCap {
                            Text(PlusCopy.publicPostsLine(count: plusState.publicCount, cap: cap))
                                .font(Blueprint.mono(.caption))
                                .foregroundStyle(.secondary)
                        } else {
                            Text("Signed in").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                Button { confirmSignOut = true } label: {
                    Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right")
                }
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Sign in to save & remix")
                        .font(.headline)
                        .foregroundStyle(Blueprint.graphite)
                    Text("Drawing and PNG export are free. Sign in to save pieces to the gallery, share links, and remix.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Button { showAuth = true } label: {
                        Text("Sign in").frame(maxWidth: .infinity)
                            .foregroundStyle(.white) // pin white so the label isn't system-picked
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Blueprint.craneButton)
                }
                .padding(.vertical, 4)
            }
        }
    }

    @ViewBuilder
    private func avatar(_ user: AuthUser) -> some View {
        if let avatar = user.avatar, let url = absoluteAvatarURL(avatar) {
            AsyncImage(url: url) { image in
                image.resizable().scaledToFill()
            } placeholder: {
                Circle().fill(Blueprint.crease.opacity(0.2))
            }
            .frame(width: avatarSize, height: avatarSize)
            .clipShape(Circle())
            .accessibilityHidden(true)
        } else {
            RosetteMark(lineWidth: 2).frame(width: avatarSize, height: avatarSize)
                .accessibilityHidden(true)
        }
    }

    /// Avatars are served as a same-origin path (e.g. /api/users/:id/avatar).
    private func absoluteAvatarURL(_ path: String) -> URL? {
        if path.hasPrefix("http") { return URL(string: path) }
        return URL(string: Config.baseURL.absoluteString + path)
    }
}
