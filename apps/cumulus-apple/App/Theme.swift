import SwiftUI

enum CumulusColor {
    static let ink = Color(red: 17 / 255, green: 24 / 255, blue: 32 / 255)
    static let muted = Color(red: 82 / 255, green: 96 / 255, blue: 107 / 255)
    static let line = Color(red: 214 / 255, green: 220 / 255, blue: 225 / 255)
    static let accent = Color(red: 36 / 255, green: 84 / 255, blue: 221 / 255)
    static let paper = Color.white
    static let good = Color(red: 26 / 255, green: 127 / 255, blue: 55 / 255)
    static let bad = Color(red: 198 / 255, green: 40 / 255, blue: 40 / 255)
    static let chip = Color(red: 244 / 255, green: 246 / 255, blue: 248 / 255)
    static let hover = Color(red: 17 / 255, green: 24 / 255, blue: 32 / 255).opacity(0.04)
}

enum DownloadColor {
    static let background = Color(red: 244 / 255, green: 244 / 255, blue: 241 / 255)
    static let ink = Color(red: 17 / 255, green: 17 / 255, blue: 17 / 255)
    static let muted = Color(red: 93 / 255, green: 93 / 255, blue: 88 / 255)
    static let line = Color(red: 226 / 255, green: 226 / 255, blue: 220 / 255)
}

enum CumulusFont {
    static func text(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .custom("Helvetica Neue", size: size).weight(weight)
    }
}

struct WordmarkText: View {
    var mark: String
    var size: CGFloat = 22
    var weight: Font.Weight = .medium
    var color: Color = CumulusColor.ink

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            Text(mark)
                .font(CumulusFont.text(size, weight: weight))
                .tracking(size >= 32 ? -1.5 : (size >= 20 ? -0.9 : 0))
            Text("™")
                .font(CumulusFont.text(size * 0.5, weight: .regular))
                .baselineOffset(size * 0.45)
                .padding(.leading, size * 0.06)
        }
        .foregroundStyle(color)
        .lineLimit(1)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(mark)
    }
}

struct InkButton: View {
    var title: String
    var identifier: String?
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(CumulusFont.text(15))
                .foregroundStyle(CumulusColor.paper)
                .frame(height: 36)
                .padding(.horizontal, 18)
                .background(CumulusColor.ink)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(identifier ?? title)
    }
}

struct OutlineButton: View {
    var title: String
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(CumulusFont.text(15))
                .foregroundStyle(CumulusColor.ink)
                .frame(height: 36)
                .padding(.horizontal, 16)
                .overlay(Rectangle().stroke(CumulusColor.line, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }
}

struct QuietButton: View {
    var title: String
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(CumulusFont.text(14))
                .foregroundStyle(CumulusColor.muted)
                .frame(height: 36)
                .padding(.horizontal, 12)
        }
        .buttonStyle(.plain)
    }
}
