import CumulusKit
import SwiftUI

struct IDView: View {
    @ObservedObject var session: CumulusSession

    var body: some View {
        if !session.signedIn {
            SignInView(session: session, mark: "Cumulus://ID")
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Text(session.mailbox?.me.name ?? session.claims?.name ?? "Your account")
                        .font(CumulusFont.text(22))
                    Text("Your Cumulus://ID")
                        .font(CumulusFont.text(12))
                        .foregroundStyle(CumulusColor.muted)
                    Text(session.mailbox?.me.email ?? session.claims?.email ?? "")
                        .font(CumulusFont.text(28))
                    Text("One address for every Infinitum product. Sign in to +SPCTR, Cloud and the FIRM Wallet with it.")
                        .font(CumulusFont.text(16))
                        .foregroundStyle(CumulusColor.muted)
                    section("Aliases")
                    if let aliases = session.mailbox?.aliases, !aliases.isEmpty {
                        ForEach(aliases, id: \.self) { alias in
                            Text(alias).font(.system(size: 12, design: .monospaced))
                        }
                    } else {
                        Text("No aliases yet.").foregroundStyle(CumulusColor.muted)
                    }
                    section("\(session.mailbox?.account?.plan ?? "Free") plan · included with your Cumulus://ID")
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Mail · \(session.mailbox?.account?.mailAddress ?? session.mailbox?.me.email ?? "")")
                        Text("Cloud · \(session.mailbox?.account?.storage?.label ?? session.mailbox?.quota.label ?? "")")
                        Text("FIRM Wallet")
                        Text("SCALVS Clean, SCALVS.ai and :\\ARCHITECT\\")
                    }
                    .font(CumulusFont.text(16))
                    section("Cumulus Tunnel")
                    Text("Mail between Cumulus accounts is sealed to the recipient and signed by the sender. Your keys were made for you when your Cumulus://ID was created. There's nothing to set up or remember.")
                        .font(CumulusFont.text(16))
                    if let fingerprint = session.mailbox?.tunnel?.fingerprint {
                        Text("Your key fingerprint").font(CumulusFont.text(12)).foregroundStyle(CumulusColor.muted)
                        Text(fingerprint).font(.system(size: 12, design: .monospaced))
                    }
                    Text(session.mailbox?.tunnel?.atRest == true ? "Your mailbox is stored encrypted. Never scanned for ads and never sold." : "Never scanned for ads and never sold.")
                        .font(CumulusFont.text(14))
                        .foregroundStyle(CumulusColor.muted)
                    if let subject = session.claims?.subject {
                        Text(subject).font(CumulusFont.text(12)).foregroundStyle(CumulusColor.muted)
                    }
                    OutlineButton(title: "Sign out") { session.signOut() }
                        .padding(.top, 8)
                }
                .padding(32)
                .frame(maxWidth: 860, alignment: .leading)
            }
            .background(CumulusColor.paper)
        }
    }

    private func section(_ title: String) -> some View {
        Text(title)
            .font(CumulusFont.text(12, weight: .bold))
            .foregroundStyle(CumulusColor.muted)
            .textCase(.uppercase)
            .padding(.top, 16)
    }
}
