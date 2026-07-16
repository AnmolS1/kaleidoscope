import SwiftUI

/// The "You" tab — account + settings. Signed-out shows a sign-in prompt;
/// signed-in shows the profile with sign-out and (App Store 5.1.1(v)) account
/// deletion. Also hosts the widget walkthrough + About.
struct YouView: View {
    @EnvironmentObject var auth: AuthModel
    @State private var showAuth = false
    @State private var confirmDelete = false
    @State private var confirmSignOut = false

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

    @ViewBuilder
    private var accountSection: some View {
        Section {
            if let user = auth.user {
                HStack(spacing: 14) {
                    avatar(user)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(user.name ?? "Signed in").font(.headline).foregroundStyle(Blueprint.graphite)
                        Text("Signed in").font(.caption).foregroundStyle(.secondary)
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
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Blueprint.crane)
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
