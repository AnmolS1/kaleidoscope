import SwiftUI
import StoreKit

/// The Kaleidoscope Plus paywall — DESIGN.md §5, `Plus*`.
///
/// Which state renders is decided by `resolvePlusSheet`, not here; this file is
/// the markup, the two actions, and the accessibility plumbing.
///
/// 🔴 The whole surface is hidden while `plus.enabled` is false, and a nil `plus`
/// block counts as false. That switch is what keeps an unapproved IAP invisible,
/// so it fails CLOSED: an `/api/me` that failed, or a Worker that predates the
/// entitlement block, must not produce a paywall. The gate lives on the entry
/// points in `YouView`, and again here so the sheet cannot be presented past it.
struct PlusSheet: View {
    @EnvironmentObject var auth: AuthModel
    @EnvironmentObject var store: PlusStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    /// Sign out and open the sign-in sheet — `PlusBoundElsewhere`'s action, and
    /// `PlusSignIn`'s. Owned by `YouView`, which is where both sheets live.
    var onSwitchAccount: () -> Void
    var onSignIn: () -> Void

    /// Start a restore as soon as the sheet appears. Set when the sheet is
    /// opened from the You tab's "Restore purchase" row, so the result of that
    /// row is somewhere the user can see it.
    var restoreOnAppear = false

    @ScaledMetric(relativeTo: .body) private var markSize: CGFloat = 28

    private var kind: PlusSheetKind {
        let resolved = resolvePlusSheet(store.sheetInput(plus: auth.plus, signedIn: auth.isSignedIn))
        #if DEBUG
        // Screenshot seam, DEBUG-only (T15 needs `Plus*` renders and an IAP
        // review shot without eight real purchases). Compiled out of Release
        // entirely — `#if DEBUG` removes the literal too, which is what the
        // `strings`/`nm` check in the handover asserts.
        if let forced = ProcessInfo.processInfo.environment["KALEIDO_PLUS_STATE"],
           let state = PlusSheetKind(rawValue: forced) {
            return state
        }
        #endif
        return resolved
    }

    private var price: String? { store.product?.displayPrice }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    body(for: kind)
                }
                .frame(maxWidth: 400, alignment: .leading)
                .frame(maxWidth: .infinity)
                .padding(20)
            }
            .background(Blueprint.graph.ignoresSafeArea())
            .navigationTitle(PlusCopy.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    RosetteMark(lineWidth: 2)
                        .frame(width: markSize, height: markSize)
                        .accessibilityHidden(true)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Close") { dismiss() }
                }
            }
        }
        .accessibilityIdentifier("plus-sheet-\(kind.rawValue)")
        .task {
            await store.loadProduct()
            if restoreOnAppear { await store.restore() }
        }
    }

    // MARK: the eight bodies

    @ViewBuilder
    private func body(for kind: PlusSheetKind) -> some View {
        switch kind {
        case .purchased:
            note(icon: "checkmark.circle.fill", tint: .green) {
                (Text(PlusCopy.purchasedTitle).bold() + Text(" ") + Text(PlusCopy.purchased))
            }
            secondaryButton(PlusCopy.backToCanvas) { dismiss() }

        case .boundElsewhere:
            note(icon: "lock.fill", tint: Blueprint.craneText) { Text(PlusCopy.boundElsewhere) }
            secondaryButton(PlusCopy.switchAccount) {
                dismiss()
                onSwitchAccount()
            }

        case .signIn:
            features
            note(icon: "info.circle", tint: Blueprint.crease) { Text(PlusCopy.signIn) }
            primaryButton(PlusCopy.signInCTA, enabled: true) {
                dismiss()
                onSignIn()
            }
            footnote

        case .restoreNone:
            note(icon: "info.circle", tint: Blueprint.crease) { Text(PlusCopy.restoreNone) }
            unlockButton
            footnote

        case .error:
            note(icon: "exclamationmark.circle", tint: Blueprint.craneText) {
                Text(errorMessage)
            }
            unlockButton
            footnote

        case .unavailable:
            note(icon: "exclamationmark.circle", tint: Blueprint.craneText) {
                Text(PlusCopy.unavailable)
            }
            footnote

        // `before` and `purchasing` share a body; only the button differs, and it
        // reads `busy` itself. The meter stays put through the purchase on
        // purpose — the card must not resize under a finger that just pressed it.
        case .before, .purchasing:
            meter
            features
            unlockButton
            footnote
        }
    }

    private var errorMessage: String {
        if case .error(let message) = store.outcome { return message }
        return PlusCopy.purchaseFailed
    }

    // MARK: pieces

    /// `PUBLIC POSTS · 9 of 10`, crane fill. Only when the cap is known and
    /// enforced — `publicCap` is genuinely nullable and null means "no cap".
    @ViewBuilder
    private var meter: some View {
        if let plus = auth.plus, let cap = plus.publicCap, cap > 0 {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("PUBLIC POSTS").font(Blueprint.mono(.caption2)).kerning(0.5)
                    Spacer()
                    Text(PlusCopy.meterReadout(count: plus.publicCount, cap: cap))
                        .font(Blueprint.mono(.caption2))
                }
                .foregroundStyle(Blueprint.graphite.opacity(0.72))
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Blueprint.creaseLine)
                        Capsule()
                            .fill(Blueprint.crane)
                            .frame(width: geo.size.width * min(1, Double(plus.publicCount) / Double(cap)))
                    }
                }
                .frame(height: 6)
            }
            // The line above already states the numbers; the bar is decoration.
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(PlusCopy.publicPostsLine(count: plus.publicCount, cap: cap))
            .padding(14)
            .background(Blueprint.graphCard, in: RoundedRectangle(cornerRadius: Blueprint.rMd))
        }
    }

    private var features: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(PlusCopy.features, id: \.0) { title, sub in
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: "checkmark")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Blueprint.crease)
                        .accessibilityHidden(true)
                        .padding(.top, 2)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title).font(.subheadline.weight(.semibold))
                            .foregroundStyle(Blueprint.graphite)
                        Text(sub).font(.footnote).foregroundStyle(Blueprint.graphite.opacity(0.72))
                    }
                }
                .accessibilityElement(children: .combine)
            }
        }
    }

    /// 🔴 The price is `product.displayPrice` or it is nothing. There is no
    /// literal fallback: a wrong price on a live button is worse than a button
    /// that is briefly disabled, and a literal here fails
    /// `test/unit/plus-state.test.ts`, which is App Review 3.1.1 made executable.
    private var unlockButton: some View {
        primaryButton(
            store.busy ? PlusCopy.unlocking : (price.map(PlusCopy.unlockLabel) ?? PlusCopy.unlockNoPrice),
            enabled: !store.busy && price != nil
        ) {
            Task { await store.purchase() }
        }
    }

    @ViewBuilder
    private var footnote: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let price {
                Text(PlusCopy.priceFootnote(price))
                    .font(Blueprint.mono(.caption2))
                    .foregroundStyle(Blueprint.graphite.opacity(0.72))
            }
            HStack(spacing: 14) {
                Button(PlusCopy.terms) { openURL(PlusCopy.termsURL) }
                Button(PlusCopy.privacy) { openURL(PlusCopy.privacyURL) }
                Button(PlusCopy.restore) { Task { await store.restore() } }
                    .disabled(store.busy)
            }
            .font(.footnote)
            .tint(Blueprint.craneText)
            // 44pt targets even though the labels are footnote-sized.
            .frame(minHeight: 44)
        }
    }

    private func primaryButton(_ label: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .frame(maxWidth: .infinity, minHeight: 44)
                .foregroundStyle(.white) // pinned, so the label is never system-picked
        }
        .buttonStyle(.borderedProminent)
        .tint(Blueprint.craneButton)
        .disabled(!enabled)
    }

    private func secondaryButton(_ label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label).frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.bordered)
        .tint(Blueprint.crease)
    }

    private func note<C: View>(icon: String, tint: Color, @ViewBuilder content: () -> C) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon)
                .foregroundStyle(tint)
                .accessibilityHidden(true)
            content()
                .font(.subheadline)
                .foregroundStyle(Blueprint.graphite)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(14)
        .background(Blueprint.graphCard, in: RoundedRectangle(cornerRadius: Blueprint.rMd))
        .overlay(
            RoundedRectangle(cornerRadius: Blueprint.rMd).stroke(Blueprint.creaseLineBold, lineWidth: 1)
        )
    }
}
