import SwiftUI

struct SignInView: View {
    @ObservedObject var session: CumulusSession
    var mark: String

    var body: some View {
        VStack(spacing: 16) {
            WordmarkText(mark: mark, size: 28)
            Text("Sign in with your Cumulus://ID")
                .font(CumulusFont.text(16))
                .foregroundStyle(CumulusColor.muted)
            InkButton(title: "Sign in with your browser", identifier: "sign-in-button") {
                Task { await session.signIn() }
            }
            .disabled(session.busy)
            if !session.error.isEmpty {
                Text(session.error)
                    .font(CumulusFont.text(13))
                    .foregroundStyle(CumulusColor.bad)
                    .multilineTextAlignment(.center)
            }
            Text("Your @cumuluscloud.app address is your Cumulus://ID. It comes with 15 GB shared with Cumulus://Cloud and a FIRM Wallet. Free.")
                .font(CumulusFont.text(13))
                .foregroundStyle(CumulusColor.muted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 420)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(CumulusColor.paper)
    }
}
