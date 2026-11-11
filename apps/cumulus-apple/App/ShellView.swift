import CumulusKit
import SwiftUI

struct ShellView: View {
    @ObservedObject var session: CumulusSession

    var body: some View {
        VStack(spacing: 0) {
            productBar
            Group {
                switch session.product {
                case .id: IDView(session: session)
                case .mail: MailView(session: session)
                case .cloud: CloudView(session: session)
                case .download: DownloadView(downloadPage: session.configuration.downloadPage, mailAPI: session.configuration.mailAPI)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(CumulusColor.paper)
        .task {
            guard session.signedIn, !session.isPreview else { return }
            await session.restore()
            guard session.signedIn else { return }
            try? await session.reload()
        }
    }

    private var productBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 24) {
                product(.id, "Cumulus://ID")
                product(.mail, "Cumulus://Mail")
                product(.cloud, "Cumulus://Cloud")
                Button {
                    session.product = .download
                } label: {
                    Text("Download")
                        .font(CumulusFont.text(15))
                        .foregroundStyle(session.product == .download ? CumulusColor.ink : CumulusColor.muted)
                        .padding(.vertical, 20)
                        .overlay(alignment: .bottom) {
                            Rectangle().fill(session.product == .download ? CumulusColor.ink : Color.clear).frame(height: 1)
                        }
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("product-download")
            }
            .padding(.horizontal, 24)
        }
        .frame(height: 64)
        .background(CumulusColor.paper)
        .overlay(alignment: .bottom) { Rectangle().fill(CumulusColor.line).frame(height: 1) }
    }

    private func product(_ product: CumulusSession.Product, _ mark: String) -> some View {
        Button { session.product = product } label: {
            WordmarkText(mark: mark, size: 15, weight: .regular, color: session.product == product ? CumulusColor.ink : CumulusColor.muted)
                .padding(.vertical, 20)
                .overlay(alignment: .bottom) {
                    Rectangle().fill(session.product == product ? CumulusColor.ink : Color.clear).frame(height: 1)
                }
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("product-\(product.rawValue)")
    }
}
