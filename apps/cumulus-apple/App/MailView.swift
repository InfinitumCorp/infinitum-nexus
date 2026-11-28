import CumulusKit
import SwiftUI

struct MailView: View {
    @ObservedObject var session: CumulusSession

    var body: some View {
        if !session.signedIn {
            SignInView(session: session, mark: "Cumulus://Mail")
        } else {
            VStack(spacing: 0) {
                header
                HStack(spacing: 0) {
                    sidebar
                        .frame(width: 248)
                    Rectangle().fill(CumulusColor.line).frame(width: 1)
                    panel
                }
            }
            .background(CumulusColor.paper)
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            WordmarkText(mark: "Cumulus://Mail", size: 22)
                .frame(width: 248, alignment: .leading)
                .padding(.leading, 24)
            HStack {
                Text("⌕").foregroundStyle(CumulusColor.muted)
                TextField("Search mail", text: $session.query)
                    .textFieldStyle(.plain)
                    .font(CumulusFont.text(14))
                    .accessibilityLabel("Search mail")
            }
            .padding(.horizontal, 18)
            .frame(height: 46)
            .overlay(Rectangle().stroke(CumulusColor.line, lineWidth: 1))
            Spacer()
            Button {
                session.product = .id
            } label: {
                Text(String((session.mailbox?.me.name ?? "A").prefix(1)).uppercased())
                    .font(CumulusFont.text(14, weight: .bold))
                    .foregroundStyle(CumulusColor.paper)
                    .frame(width: 36, height: 36)
                    .background(CumulusColor.ink)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Your Cumulus://ID")
            .padding(.trailing, 16)
        }
        .frame(height: 64)
        .overlay(alignment: .bottom) { Rectangle().fill(CumulusColor.line).frame(height: 1) }
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 2) {
            Button { session.composeNew() } label: {
                HStack(spacing: 12) {
                    Text("✎")
                    Text("Compose").font(CumulusFont.text(15))
                }
                .foregroundStyle(CumulusColor.ink)
                .frame(height: 56)
                .padding(.horizontal, 20)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("compose")
            ForEach(MailBox.allCases, id: \.self) { box in
                nav(box.title, current: session.mailSection == .mail && session.mailBox == box && session.activeLabel == nil) {
                    session.mailSection = .mail
                    session.mailBox = box
                    session.activeLabel = nil
                    session.selectedMessage = nil
                    if box == .inbox { session.inboxTab = .primary }
                }
            }
            Rectangle().fill(CumulusColor.line).frame(height: 1).padding(.vertical, 8)
            nav("Clean", current: session.mailSection == .clean) { session.mailSection = .clean }
            nav("Wallet", current: session.mailSection == .wallet) { session.mailSection = .wallet }
            nav("People", current: session.mailSection == .people) { session.mailSection = .people }
            nav("Architect", current: session.mailSection == .tasks) { session.mailSection = .tasks }
            if let labels = session.mailbox.map({ MailboxIndex.labels(in: $0.messages) }), !labels.isEmpty {
                Rectangle().fill(CumulusColor.line).frame(height: 1).padding(.vertical, 8)
                Text("Labels").font(CumulusFont.text(12)).foregroundStyle(CumulusColor.muted).padding(.leading, 24)
                ForEach(labels, id: \.self) { label in
                    nav(label, current: session.activeLabel == label) {
                        session.mailSection = .mail
                        session.activeLabel = label
                        session.selectedMessage = nil
                    }
                }
            }
            Spacer()
            VStack(alignment: .leading, spacing: 6) {
                GeometryReader { proxy in
                    ZStack(alignment: .leading) {
                        Rectangle().fill(CumulusColor.line)
                        Rectangle().fill(CumulusColor.ink).frame(width: proxy.size.width * min(1, (session.mailbox?.quota.pct ?? 0) / 100))
                    }
                }
                .frame(height: 4)
                Text(session.isPreview ? "Preview · \(session.mailbox?.quota.label ?? "")" : (session.mailbox?.quota.label ?? ""))
                    .font(CumulusFont.text(12))
                    .foregroundStyle(CumulusColor.muted)
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 12)
        }
        .padding(.top, 4)
    }

    private var panel: some View {
        Group {
            switch session.mailSection {
            case .mail:
                if session.selectedMessage != nil {
                    reader
                } else {
                    list
                }
            case .clean:
                clean
            case .wallet:
                wallet
            case .people:
                people
            case .tasks:
                tasks
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .overlay(alignment: .bottomTrailing) {
            if let composer = session.composer {
                composerPanel(composer)
                    .padding(24)
            }
        }
    }

    private var list: some View {
        VStack(spacing: 0) {
            if session.mailBox == .inbox && session.query.trimmingCharacters(in: .whitespaces).isEmpty && session.activeLabel == nil {
                HStack(spacing: 0) {
                    tab("Primary", .primary)
                    tab("Updates", .updates)
                    tab("All mail", .all)
                    Spacer()
                }
                .overlay(alignment: .bottom) { Rectangle().fill(CumulusColor.line).frame(height: 1) }
            }
            if session.rows.isEmpty {
                Text(session.query.isEmpty ? "Nothing in \(session.activeLabel ?? session.mailBox.title)." : "Nothing matches.")
                    .font(CumulusFont.text(14))
                    .foregroundStyle(CumulusColor.muted)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 64)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(session.rows) { message in
                            Button { session.selectMessage(message) } label: {
                                HStack(spacing: 8) {
                                    Button {
                                        Task { await session.threadAction(message.starred ? "unstar" : "star", messageID: message.id) }
                                    } label: {
                                        Text(message.starred ? "★" : "☆").foregroundStyle(message.starred ? CumulusColor.ink : CumulusColor.muted)
                                    }
                                    .buttonStyle(.plain)
                                    .frame(width: 32)
                                    Text(message.from.email == session.mailbox?.me.email ? "To \(message.to.first?.name ?? "someone")" : message.from.name)
                                        .font(CumulusFont.text(14, weight: message.unread ? .bold : .regular))
                                        .frame(width: 160, alignment: .leading)
                                        .lineLimit(1)
                                    HStack(spacing: 6) {
                                        ForEach(message.labels, id: \.self) { label in
                                            Text(label)
                                                .font(CumulusFont.text(11))
                                                .foregroundStyle(CumulusColor.muted)
                                                .padding(.horizontal, 8)
                                                .overlay(Rectangle().stroke(CumulusColor.line, lineWidth: 1))
                                        }
                                        Text(message.subject).font(CumulusFont.text(14, weight: message.unread ? .bold : .regular)).lineLimit(1)
                                        Text("— \(message.body.replacingOccurrences(of: "\n", with: " "))")
                                            .font(CumulusFont.text(14))
                                            .foregroundStyle(CumulusColor.muted)
                                            .lineLimit(1)
                                    }
                                    Spacer(minLength: 8)
                                    Text(shortDate(message.at))
                                        .font(CumulusFont.text(12))
                                        .foregroundStyle(CumulusColor.muted)
                                }
                                .padding(.horizontal, 12)
                                .frame(height: 40)
                                .background(message.unread ? CumulusColor.paper : CumulusColor.chip)
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("mail-row-\(message.id)")
                            Rectangle().fill(CumulusColor.line).frame(height: 1)
                        }
                    }
                }
            }
            Spacer(minLength: 0)
        }
    }

    private var reader: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                QuietButton(title: "Back") { session.selectedMessage = nil }
                QuietButton(title: "Archive") { Task { await session.threadAction("archive") } }
                QuietButton(title: "Trash") { Task { await session.threadAction("trash") } }
                QuietButton(title: "Star") { Task { await session.threadAction("star") } }
                Spacer()
                QuietButton(title: "Reply") {
                    if let message = session.selectedMessage {
                        session.composer = CumulusSession.Composer(to: message.from.email, subject: message.subject.hasPrefix("Re:") ? message.subject : "Re: \(message.subject)", threadID: message.threadId)
                    }
                }
            }
            .padding(.horizontal, 8)
            .frame(minHeight: 48)
            .overlay(alignment: .bottom) { Rectangle().fill(CumulusColor.line).frame(height: 1) }
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Text(session.selectedMessage?.subject ?? "")
                        .font(CumulusFont.text(22))
                    if session.thread.contains(where: { $0.tunnel?.verified == true }) {
                        Text("sealed and sender verified")
                            .font(CumulusFont.text(12))
                            .foregroundStyle(CumulusColor.good)
                    }
                    ForEach(session.thread) { message in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Text(message.from.name).font(CumulusFont.text(14, weight: .bold))
                                Spacer()
                                Text(message.at).font(CumulusFont.text(12)).foregroundStyle(CumulusColor.muted)
                            }
                            Text(message.from.email).font(CumulusFont.text(12)).foregroundStyle(CumulusColor.muted)
                            Text(message.body).font(CumulusFont.text(16)).fixedSize(horizontal: false, vertical: true)
                            if let payment = message.payment {
                                VStack(alignment: .leading) {
                                    Text("FIRM Wallet")
                                    Text("\(payment.amount) \(payment.asset)").font(CumulusFont.text(22))
                                }
                                .padding(14)
                                .overlay(Rectangle().stroke(CumulusColor.line, lineWidth: 1))
                            }
                        }
                        .padding(.vertical, 12)
                        .overlay(alignment: .bottom) { Rectangle().fill(CumulusColor.line).frame(height: 1) }
                    }
                }
                .padding(.horizontal, 32)
                .padding(.vertical, 20)
                .frame(maxWidth: 860, alignment: .leading)
            }
        }
    }

    private var clean: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("Clean").font(CumulusFont.text(22))
                Text("SCALVS Clean sorts mail into people, newsletters, notices, receipts and bounces. Nothing moves until you approve it.")
                    .foregroundStyle(CumulusColor.muted)
                Text("Clean automatically").font(CumulusFont.text(16))
                Text("Runs when you open Mail, at most once an hour.")
                    .font(CumulusFont.text(12))
                    .foregroundStyle(CumulusColor.muted)
                if let note = session.clean?.note, !note.isEmpty {
                    Text(note).font(CumulusFont.text(14))
                }
                ForEach(session.clean?.suggestions ?? []) { suggestion in
                    HStack {
                        Text(suggestion.reason ?? suggestion.kind)
                        Spacer()
                        OutlineButton(title: "Approve") {}
                    }
                    .overlay(alignment: .bottom) { Rectangle().fill(CumulusColor.line).frame(height: 1) }
                }
            }
            .padding(32)
            .frame(maxWidth: 860, alignment: .leading)
        }
    }

    private var wallet: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                Text("FIRM Wallet").font(CumulusFont.text(22))
                Text(session.mailbox?.account?.wallet?.address ?? "")
                    .font(.system(size: 12, design: .monospaced))
                ForEach(session.mailbox?.account?.wallet?.balances ?? []) { balance in
                    Text("\(balance.amount) \(balance.asset)").font(CumulusFont.text(22))
                }
            }
            .padding(32)
            .frame(maxWidth: 860, alignment: .leading)
        }
    }

    private var people: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("People").font(CumulusFont.text(22))
                if session.mailbox?.contacts.isEmpty != false {
                    Text("No contacts yet.").foregroundStyle(CumulusColor.muted)
                }
                ForEach(session.mailbox?.contacts ?? []) { contact in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(contact.name)
                            Text(contact.email).font(CumulusFont.text(12)).foregroundStyle(CumulusColor.muted)
                        }
                        Spacer()
                        OutlineButton(title: "Write") {
                            session.composer = CumulusSession.Composer(to: contact.email)
                            session.mailSection = .mail
                        }
                    }
                    .padding(.vertical, 8)
                    .overlay(alignment: .bottom) { Rectangle().fill(CumulusColor.line).frame(height: 1) }
                }
            }
            .padding(32)
            .frame(maxWidth: 860, alignment: .leading)
        }
    }

    private var tasks: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("Waiting on you").font(CumulusFont.text(22))
                if session.mailbox?.tasks.isEmpty != false {
                    Text("Nothing queued.").foregroundStyle(CumulusColor.muted)
                }
                ForEach(session.mailbox?.tasks ?? []) { task in
                    VStack(alignment: .leading) {
                        Text(task.title).foregroundStyle(task.done ? CumulusColor.muted : CumulusColor.ink)
                        Text(task.detail).font(CumulusFont.text(12)).foregroundStyle(CumulusColor.muted)
                    }
                    .padding(.vertical, 8)
                }
            }
            .padding(32)
            .frame(maxWidth: 860, alignment: .leading)
        }
    }

    private func composerPanel(_ composer: CumulusSession.Composer) -> some View {
        VStack(spacing: 0) {
            HStack {
                Text("New message").font(CumulusFont.text(14, weight: .bold))
                Spacer()
                Button("×") { session.composer = nil }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Close")
            }
            .padding(.horizontal, 16)
            .frame(height: 40)
            .background(CumulusColor.chip)
            field("To", text: composerText(\.to))
            field("Cc", text: composerText(\.cc))
            field("Subject", text: composerText(\.subject))
            TextEditor(text: composerText(\.body))
                .font(CumulusFont.text(16))
                .frame(minHeight: 160)
                .padding(.horizontal, 8)
            HStack {
                InkButton(title: "Send", identifier: "send") { Task { await session.sendComposer() } }
                OutlineButton(title: session.composer?.schedule == true ? "Scheduled" : "Schedule") {
                    guard var composer = session.composer else { return }
                    composer.schedule.toggle()
                    session.composer = composer
                }
                Spacer()
            }
            .padding(12)
            if session.composer?.schedule == true {
                DatePicker("Send at", selection: Binding(get: { session.composer?.sendAt ?? Date() }, set: { value in
                    guard var composer = session.composer else { return }
                    composer.sendAt = value
                    session.composer = composer
                }))
                    .font(CumulusFont.text(13))
                    .padding(.horizontal, 12)
                    .padding(.bottom, 12)
            }
        }
        .frame(width: 520)
        .background(CumulusColor.paper)
        .overlay(Rectangle().stroke(CumulusColor.ink, lineWidth: 1))
        // A container keeps its children's identifiers (the Send button stays "send").
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("composer")
    }

    private func composerText(_ keyPath: WritableKeyPath<CumulusSession.Composer, String>) -> Binding<String> {
        Binding(
            get: { session.composer?[keyPath: keyPath] ?? "" },
            set: { value in
                guard var composer = session.composer else { return }
                composer[keyPath: keyPath] = value
                session.composer = composer
            }
        )
    }

    private func field(_ title: String, text: Binding<String>) -> some View {
        HStack {
            Text(title).frame(width: 52, alignment: .leading).foregroundStyle(CumulusColor.muted)
            TextField(title, text: text).textFieldStyle(.plain)
        }
        .font(CumulusFont.text(14))
        .padding(.horizontal, 16)
        .frame(height: 40)
        .overlay(alignment: .bottom) { Rectangle().fill(CumulusColor.line).frame(height: 1) }
    }

    private func tab(_ title: String, _ tab: InboxTab) -> some View {
        Button {
            session.inboxTab = tab
        } label: {
            Text(title)
                .font(CumulusFont.text(14, weight: session.inboxTab == tab ? .bold : .regular))
                .foregroundStyle(session.inboxTab == tab ? CumulusColor.ink : CumulusColor.muted)
                .frame(maxWidth: 240, alignment: .leading)
                .frame(height: 52)
                .padding(.horizontal, 16)
                .overlay(alignment: .bottom) {
                    if session.inboxTab == tab {
                        Rectangle().fill(CumulusColor.ink).frame(height: 3).padding(.horizontal, 8)
                    }
                }
        }
        .buttonStyle(.plain)
    }

    private func nav(_ title: String, current: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(CumulusFont.text(14, weight: current ? .bold : .regular))
                .foregroundStyle(CumulusColor.ink)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.leading, 24)
                .frame(height: 32)
                .background(current ? CumulusColor.line : Color.clear)
        }
        .buttonStyle(.plain)
    }

    private func shortDate(_ iso: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = formatter.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
        guard let date else { return iso }
        let display = DateFormatter()
        display.dateFormat = Calendar.current.isDateInToday(date) ? "h:mm a" : "d MMM"
        return display.string(from: date)
    }
}

extension WalletBalance: Identifiable {
    public var id: String { asset }
}
