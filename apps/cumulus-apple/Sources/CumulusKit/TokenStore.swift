import Foundation

public protocol TokenStore: AnyObject {
    func load() throws -> TokenSet?
    func save(_ tokens: TokenSet) throws
    func clear() throws
}

public final class MemoryTokenStore: TokenStore {
    private let lock = NSLock()
    private var tokens: TokenSet?

    public init() {}

    public func load() throws -> TokenSet? {
        lock.lock()
        defer { lock.unlock() }
        return tokens
    }

    public func save(_ tokens: TokenSet) throws {
        lock.lock()
        defer { lock.unlock() }
        self.tokens = tokens
    }

    public func clear() throws {
        lock.lock()
        defer { lock.unlock() }
        tokens = nil
    }
}
