import SwiftUI

/// The cumuluscloud.app download page, as shipped with Cumulus://Mail.
struct DownloadView: View {
    var downloadPage: URL
    var mailAPI: URL

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Link(destination: downloadPage) {
                        WordmarkText(mark: "Cumulus://Cloud", size: 18, weight: .semibold, color: DownloadColor.ink)
                    }
                    Spacer()
                    Link("Open Mail", destination: URL(string: "https://mail.cumuluscloud.app/")!)
                        .font(CumulusFont.text(16, weight: .medium))
                        .foregroundStyle(DownloadColor.ink)
                }
                .frame(height: 64)

                Text("DOWNLOAD")
                    .font(CumulusFont.text(12))
                    .tracking(1.4)
                    .foregroundStyle(DownloadColor.muted)
                    .padding(.top, 48)
                HStack(alignment: .firstTextBaseline, spacing: 0) {
                    WordmarkText(mark: "Cumulus://Mail", size: 40, weight: .regular, color: DownloadColor.ink)
                    Text("on every device.")
                        .font(CumulusFont.text(40))
                        .foregroundStyle(DownloadColor.ink)
                }
                .padding(.bottom, 16)
                .accessibilityIdentifier("download-hero")
                Text("One Cumulus://ID, the same inbox everywhere. Free, encrypted email with 15 GB of storage.")
                    .font(CumulusFont.text(18))
                    .foregroundStyle(DownloadColor.muted)
                    .frame(maxWidth: 720, alignment: .leading)
                    .padding(.bottom, 32)

                LazyVGrid(columns: [GridItem(.adaptive(minimum: 300), spacing: 16)], spacing: 16) {
                    card("Windows", "Desktop app for Windows 10 and 11. Opens mailto: links and shows new mail on the taskbar.", link: "Download for Windows", path: "get/windows")
                    card("macOS", "Desktop app for Apple silicon and Intel Macs, macOS 12 or later.", link: "Download for Mac", path: "get/mac")
                    card("Linux", "AppImage runs on most distributions. The .deb is for Debian, Ubuntu and Mint.", link: "AppImage (x64)", path: "get/linux-appimage-x64")
                    card("Android", "For Android 8 or later. Opens your mail in a fast, full-screen window and keeps you signed in with your passkey.", link: "Download APK", path: "get/android")
                    iosCard
                    card("Web", "Use Cumulus://Mail in any up-to-date browser, with nothing to install.", link: "Open Cumulus://Mail", url: mailAPI)
                }

                Text("Good to know")
                    .font(CumulusFont.text(22))
                    .padding(.top, 36)
                VStack(alignment: .leading, spacing: 8) {
                    Text("Every app connects straight to mail.cumuluscloud.app.")
                    Text("Sign in with your passkey. In the desktop apps you can also choose Sign in with your browser.")
                    Text("Each file's SHA-256 is listed under its button, so you can check the download.")
                }
                .font(CumulusFont.text(16))
                .foregroundStyle(DownloadColor.muted)
                .padding(.top, 8)

                Text("© 2026 Infinitum Corporation. Cumulus://Mail™, Cumulus://Cloud™ and Cumulus://ID™ are trademarks of Infinitum Corporation.")
                    .font(CumulusFont.text(14))
                    .foregroundStyle(DownloadColor.muted)
                    .padding(.vertical, 40)
            }
            .padding(.horizontal, 16)
            .frame(maxWidth: 1120)
            .frame(maxWidth: .infinity)
        }
        .background(DownloadColor.background)
    }

    private var iosCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("iPhone & iPad").font(CumulusFont.text(20)).foregroundStyle(DownloadColor.ink)
            Text("Add Cumulus://Mail to your Home Screen. It opens full screen like an app and signs in with Face ID or Touch ID.")
                .font(CumulusFont.text(16))
            VStack(alignment: .leading, spacing: 4) {
                Text("1. Open mail.cumuluscloud.app in Safari.")
                Text("2. Tap Share, then Add to Home Screen.")
                Text("3. Tap Add. Cumulus Mail is now on your Home Screen.")
            }
            .font(CumulusFont.text(14))
            .foregroundStyle(DownloadColor.muted)
            Link("Open in Safari", destination: mailAPI)
                .font(CumulusFont.text(15, weight: .semibold))
                .foregroundStyle(Color.white)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(DownloadColor.ink)
                .clipShape(RoundedRectangle(cornerRadius: 9))
        }
        .padding(22)
        .frame(maxWidth: .infinity, minHeight: 180, alignment: .topLeading)
        .background(Color.white)
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(DownloadColor.line, lineWidth: 1))
    }

    private func card(_ title: String, _ body: String, link: String, path: String) -> some View {
        let root = mailAPI.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        card(title, body, link: link, url: URL(string: root + "/download/" + path)!)
    }

    private func card(_ title: String, _ body: String, link: String, url: URL) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(CumulusFont.text(20)).foregroundStyle(DownloadColor.ink)
            Text(body).font(CumulusFont.text(16)).foregroundStyle(DownloadColor.ink)
            Link(link, destination: url)
                .font(CumulusFont.text(15, weight: .semibold))
                .foregroundStyle(Color.white)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(DownloadColor.ink)
                .clipShape(RoundedRectangle(cornerRadius: 9))
        }
        .padding(22)
        .frame(maxWidth: .infinity, minHeight: 180, alignment: .topLeading)
        .background(Color.white)
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(DownloadColor.line, lineWidth: 1))
    }
}
