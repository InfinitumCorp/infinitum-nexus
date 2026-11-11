import SwiftUI
import UniformTypeIdentifiers

struct CloudView: View {
    @ObservedObject var session: CumulusSession
    @State private var importer = false
    @State private var folderName = ""
    @State private var namingFolder = false

    var body: some View {
        if !session.signedIn {
            SignInView(session: session, mark: "Cumulus://Cloud")
        } else {
            VStack(spacing: 0) {
                header
                HStack(spacing: 0) {
                    sidebar.frame(width: 240)
                    Rectangle().fill(CumulusColor.line).frame(width: 1)
                    main
                }
            }
            .background(CumulusColor.paper)
            .fileImporter(isPresented: $importer, allowedContentTypes: [.item], allowsMultipleSelection: false) { result in
                if case .success(let urls) = result, let url = urls.first {
                    Task { await session.upload(url) }
                }
            }
        }
    }

    private var header: some View {
        HStack(spacing: 16) {
            HStack(spacing: 0) {
                Text("Cumulus://").foregroundStyle(CumulusColor.ink)
                Text("Drive").foregroundStyle(CumulusColor.muted)
            }
            .font(CumulusFont.text(20))
            .accessibilityLabel("Cumulus://Drive")
            HStack {
                Text("⌕").foregroundStyle(CumulusColor.muted)
                TextField("Search Drive", text: $session.query)
                    .textFieldStyle(.plain)
                    .accessibilityLabel("Search Drive")
            }
            .padding(.horizontal, 12)
            .frame(maxWidth: 640, minHeight: 40)
            .overlay(Rectangle().stroke(session.query.isEmpty ? CumulusColor.line : CumulusColor.accent, lineWidth: 1))
            Spacer()
        }
        .padding(.horizontal, 24)
        .frame(height: 64)
        .overlay(alignment: .bottom) { Rectangle().fill(CumulusColor.line).frame(height: 1) }
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 2) {
            Button { importer = true } label: {
                Text("Upload files")
                    .font(CumulusFont.text(13))
                    .foregroundStyle(CumulusColor.paper)
                    .frame(maxWidth: .infinity)
                    .frame(height: 40)
                    .background(CumulusColor.ink)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("upload")
            .padding(.bottom, 12)
            sideLink("My Drive", current: session.cloudSection == .drive) {
                session.cloudSection = .drive
                Task { await session.openFolder(nil, name: "My Drive") }
            }
            sideLink("Trash", current: session.cloudSection == .trash) {
                session.cloudSection = .trash
                Task { await session.reloadDrive() }
            }
            sideLink("Exchange", current: session.cloudSection == .exchange) {
                session.cloudSection = .exchange
            }
            Spacer()
            VStack(alignment: .leading, spacing: 6) {
                Text(session.quota?.label ?? session.mailbox?.quota.label ?? "")
                    .font(CumulusFont.text(13))
                GeometryReader { proxy in
                    ZStack(alignment: .leading) {
                        Rectangle().fill(CumulusColor.line)
                        Rectangle().fill(CumulusColor.ink)
                            .frame(width: proxy.size.width * fraction)
                    }
                }
                .frame(height: 4)
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 16)
        }
        .padding(16)
    }

    private var fraction: Double {
        guard let quota = session.quota, quota.limitBytes > 0 else {
            return min(1, (session.mailbox?.quota.pct ?? 0) / 100)
        }
        return min(1, Double(quota.usedBytes) / Double(quota.limitBytes))
    }

    @ViewBuilder
    private var main: some View {
        switch session.cloudSection {
        case .exchange:
            ExchangeView(session: session)
        case .trash:
            fileTable(session.trash, title: "Trash", empty: "The trash is empty.")
        case .drive:
            fileTable(filteredDrive, title: nil, empty: session.query.isEmpty ? "Drop files here, or use New." : "Nothing matches.")
        }
    }

    private var filteredDrive: DriveListing {
        let query = session.query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !query.isEmpty else { return session.drive }
        return DriveListing(
            folders: session.drive.folders.filter { $0.name.lowercased().contains(query) },
            files: session.drive.files.filter { $0.name.lowercased().contains(query) },
            nextFolder: nil,
            nextFile: nil
        )
    }

    private func fileTable(_ listing: DriveListing, title: String?, empty: String) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                if session.cloudSection == .drive {
                    HStack(spacing: 8) {
                        ForEach(Array(session.crumbs.enumerated()), id: \.offset) { index, crumb in
                            if index > 0 { Text("/").foregroundStyle(CumulusColor.muted) }
                            Button(crumb.name) { Task { await session.openFolder(crumb.id, name: crumb.name) } }
                                .buttonStyle(.plain)
                                .font(CumulusFont.text(20))
                        }
                    }
                } else {
                    Text(title ?? "").font(CumulusFont.text(28)).tracking(-0.8)
                }
                Spacer()
                if session.cloudSection == .drive {
                    OutlineButton(title: "New folder") { namingFolder = true }
                }
            }
            if listing.folders.isEmpty && listing.files.isEmpty {
                Text(empty)
                    .font(CumulusFont.text(14))
                    .foregroundStyle(CumulusColor.muted)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 64)
                    .overlay(Rectangle().stroke(CumulusColor.line, style: StrokeStyle(lineWidth: 1, dash: [4])))
            } else {
                VStack(spacing: 0) {
                    HStack {
                        Text("Name").frame(maxWidth: .infinity, alignment: .leading)
                        Text("Updated").frame(width: 160, alignment: .leading)
                        Text("Size").frame(width: 80, alignment: .trailing)
                    }
                    .font(CumulusFont.text(13))
                    .foregroundStyle(CumulusColor.muted)
                    .padding(.vertical, 8)
                    .overlay(alignment: .bottom) { Rectangle().fill(CumulusColor.line).frame(height: 1) }
                    ForEach(listing.folders) { folder in
                        Button { Task { await session.openFolder(folder.id, name: folder.name) } } label: {
                            row(name: folder.name, kind: "Folder", updated: folder.updatedAt, size: "")
                        }
                        .buttonStyle(.plain)
                    }
                    ForEach(listing.files) { file in
                        Button {
                            session.selectedFile = file
                            Task { await session.loadVersions() }
                        } label: {
                            row(name: file.name, kind: file.mediaType, updated: file.updatedAt, size: byteCount(file.size))
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("drive-file-\(file.id)")
                    }
                }
            }
            if let file = session.selectedFile {
                detail(file)
            }
            if namingFolder {
                HStack {
                    TextField("Folder name", text: $folderName)
                        .textFieldStyle(.plain)
                        .padding(.horizontal, 12)
                        .frame(height: 40)
                        .overlay(Rectangle().stroke(CumulusColor.line, lineWidth: 1))
                    InkButton(title: "Create") {
                        let name = folderName
                        folderName = ""
                        namingFolder = false
                        Task { await session.createFolder(named: name) }
                    }
                }
            }
            if !session.error.isEmpty {
                Text(session.error).font(CumulusFont.text(13)).foregroundStyle(CumulusColor.bad)
            }
            Spacer()
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func row(name: String, kind: String, updated: String, size: String) -> some View {
        HStack {
            Text(name).frame(maxWidth: .infinity, alignment: .leading).lineLimit(1)
            Text(updated).frame(width: 160, alignment: .leading).foregroundStyle(CumulusColor.muted).lineLimit(1)
            Text(size).frame(width: 80, alignment: .trailing).foregroundStyle(CumulusColor.muted)
        }
        .font(CumulusFont.text(13))
        .padding(.vertical, 8)
        .overlay(alignment: .bottom) { Rectangle().fill(CumulusColor.line).frame(height: 1) }
    }

    private func detail(_ file: DriveFile) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(file.name).font(CumulusFont.text(20))
            Text("\(byteCount(file.size)) · \(file.mediaType) · version \(file.version)\(file.encrypted ? " · encrypted" : "")")
                .font(CumulusFont.text(13))
                .foregroundStyle(CumulusColor.muted)
            HStack {
                OutlineButton(title: "Download") { Task { await session.downloadSelected() } }
                OutlineButton(title: "Share link") { Task { await session.shareSelected() } }
                OutlineButton(title: "Trash") { Task { await session.trashSelected() } }
            }
            if let url = session.downloadedURL {
                ShareLink(item: url) { Text("Save \(url.lastPathComponent)").foregroundStyle(CumulusColor.accent) }
            }
            ForEach(session.versions) { version in
                Text("Version \(version.version) · \(byteCount(version.size))\(version.current ? " · current" : "")")
                    .font(CumulusFont.text(13))
            }
            ForEach(session.shares) { share in
                Text(share.url ?? "Link created")
                    .font(CumulusFont.text(13))
                    .foregroundStyle(CumulusColor.accent)
                    .textSelection(.enabled)
            }
        }
        .padding(16)
        .overlay(Rectangle().stroke(CumulusColor.line, lineWidth: 1))
    }

    private func sideLink(_ title: String, current: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(CumulusFont.text(13))
                .foregroundStyle(CumulusColor.ink)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 8)
                .padding(.horizontal, 12)
                .background(current ? CumulusColor.chip : Color.clear)
                .overlay(alignment: .leading) { Rectangle().fill(current ? CumulusColor.ink : Color.clear).frame(width: 2) }
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(title == "My Drive" ? "my-drive" : title.lowercased())
    }

    private func byteCount(_ bytes: Int) -> String {
        if bytes < 1024 { return "\(bytes) B" }
        if bytes < 1024 * 1024 { return "\(max(1, bytes / 1024)) KB" }
        return String(format: "%.1f MB", Double(bytes) / 1_048_576)
    }
}

struct ExchangeView: View {
    @ObservedObject var session: CumulusSession

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("DATA EXCHANGE · OPT-IN · IN DEVELOPMENT")
                    .font(CumulusFont.text(12))
                    .foregroundStyle(CumulusColor.muted)
                    .accessibilityIdentifier("exchange-opt-in")
                Text("Your data, your share")
                    .font(CumulusFont.text(22))
                Text("Choose, product by product, whether de-identified usage data may be pooled with at least 1,000 other people. You keep 85% of eligible net revenue, paid in product tokens and recorded on Firmament Network™. Nothing is shared yet: your choices stay on this device until the exchange opens.")
                    .font(CumulusFont.text(14))
                    .foregroundStyle(CumulusColor.muted)
                ForEach(ExchangePolicy.offered) { product in
                    Toggle(isOn: Binding(
                        get: { session.choices[product.id] == true },
                        set: { value in Task { await session.setChoice(product.id, value) } }
                    )) {
                        Text(product.mark + "™").font(CumulusFont.text(15))
                    }
                    .toggleStyle(.switch)
                    .tint(CumulusColor.ink)
                }
                Text("Never sold: \(ExchangePolicy.neverSold.joined(separator: ", ")). You can opt out of any sale at any time.")
                    .font(CumulusFont.text(13))
                    .foregroundStyle(CumulusColor.muted)
                if !session.licenses.isEmpty {
                    Text("Licenses").font(CumulusFont.text(12, weight: .bold)).foregroundStyle(CumulusColor.muted).padding(.top, 8)
                    ForEach(session.licenses, id: \.identifier) { grant in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(grant.objectKey).font(CumulusFont.text(15))
                            Text("\(grant.licensee) · \(grant.terms) · \(grant.issuedAt)")
                                .font(CumulusFont.text(12))
                                .foregroundStyle(CumulusColor.muted)
                        }
                        .padding(.vertical, 8)
                        .overlay(alignment: .bottom) { Rectangle().fill(CumulusColor.line).frame(height: 1) }
                    }
                }
                if !session.consents.isEmpty {
                    Text("Consent recorded").font(CumulusFont.text(12)).foregroundStyle(CumulusColor.muted)
                    ForEach(session.consents) { consent in
                        Text("\(consent.product) · \(consent.granted ? "on" : "off") · \(consent.timestamp)")
                            .font(CumulusFont.text(13))
                    }
                }
            }
            .padding(24)
            .frame(maxWidth: 720, alignment: .leading)
        }
    }
}
