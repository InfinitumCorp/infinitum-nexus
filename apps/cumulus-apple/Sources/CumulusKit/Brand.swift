import Foundation

/// Colors and names copied from `@infinitum/brand` and the Cumulus app shell.
/// Product logos are text wordmarks. The parent name uses ®. Product names use ™.
public enum CumulusBrand {
    public static let ink = RGB(0x11, 0x18, 0x20)
    public static let muted = RGB(0x52, 0x60, 0x6B)
    public static let line = RGB(0xD6, 0xDC, 0xE1)
    public static let accent = RGB(0x24, 0x54, 0xDD)
    public static let paper = RGB(0xFF, 0xFF, 0xFF)
    public static let good = RGB(0x1A, 0x7F, 0x37)
    public static let bad = RGB(0xC6, 0x28, 0x28)
    public static let fontName = "Helvetica Neue"
    public static let corporation = "Infinitum Corporation®"

    public struct Wordmark: Equatable, Sendable {
        public let id: String
        public let mark: String
        public var text: String { mark + "™" }
        public init(id: String, mark: String) {
            self.id = id
            self.mark = mark
        }
    }

    public static let id = Wordmark(id: "cumulus-id", mark: "Cumulus://ID")
    public static let mail = Wordmark(id: "cumulus-mail", mark: "Cumulus://Mail")
    public static let cloud = Wordmark(id: "cumulus-cloud", mark: "Cumulus://Cloud")
    public static let drive = Wordmark(id: "cumulus-drive", mark: "Cumulus://Drive")

    public struct RGB: Equatable, Sendable {
        public let red: UInt8
        public let green: UInt8
        public let blue: UInt8
        public init(_ red: UInt8, _ green: UInt8, _ blue: UInt8) {
            self.red = red
            self.green = green
            self.blue = blue
        }
        public var hex: String {
            String(format: "#%02X%02X%02X", red, green, blue)
        }
    }
}
