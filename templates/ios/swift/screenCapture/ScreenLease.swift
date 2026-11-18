import Foundation

/// 一次屏幕共享的推流地址与租约（屏幕租约协议 v1，见 docs/screen-capture.md）。主 App 写进 App Group，广播扩展读出来推流、续租。
struct ScreenCredentials: Codable, Sendable {
    var url: String
    let renewUrl: String
    let publisherId: String
    let leaseToken: String
    var expiresAt: String
    var replay: ScreenReplayCredentials?

    /// 地址主机必须在 screenCapture.allowedHosts（本域或子域）；回放上传必须与续租同主机；ID / 令牌限定字符集。
    var valid: Bool {
        func trusted(_ url: URL) -> Bool {
            guard let host = url.host else { return false }
            return AppShellScreenConfig.allowedHosts.contains { host == $0 || host.hasSuffix("." + $0) }
                && url.user == nil && url.password == nil && url.fragment == nil && (url.port == nil || url.port == 443)
        }
        guard let push = URL(string: url), let renew = URL(string: renewUrl) else { return false }
        if let replay {
            guard let upload = URL(string: replay.uploadUrl), upload.scheme == "https", trusted(upload), upload.host == renew.host,
                  upload.port == renew.port, upload.query == nil, ISO8601DateFormatter.replayDate(replay.serverNow) != nil else { return false }
        }
        return push.scheme == "rtmps" && trusted(push) && renew.scheme == "https" && trusted(renew) && renew.query == nil
            && publisherId.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil
            && leaseToken.range(of: "^[A-Za-z0-9_-]{16,256}$", options: .regularExpression) != nil
    }
    var expiry: Date {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: expiresAt) ?? .distantPast
    }
}

struct ScreenStatus: Codable {
    let state: String
    let timestamp: Date

    func currentState(waitingForBroadcast: Bool, now: Date = Date()) -> String {
        // No extension heartbeat exists until the user confirms the system picker.
        // The start command owns the authorization timeout.
        if state == "requesting" && waitingForBroadcast { return state }
        return timestamp.timeIntervalSince(now) < -10 ? "failed" : state
    }
}

enum ScreenLeaseStore {
    static var directory: URL? { FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: AppShellScreenConfig.appGroup)?.appendingPathComponent("appshell-screen", isDirectory: true) }
    static func file(_ name: String) throws -> URL {
        guard let directory else { throw URLError(.cannotCreateFile) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory.appendingPathComponent(name)
    }
    static func write<T: Encodable>(_ value: T, _ name: String) throws {
        try JSONEncoder().encode(value).write(to: file(name), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
    static func read<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(contentsOf: file(name)))
    }
    static func remove(_ name: String) { if let url = try? file(name) { try? FileManager.default.removeItem(at: url) } }
    static func status(_ id: String, _ state: String) { try? write(ScreenStatus(state: state, timestamp: Date()), "\(id).state") }
    static func stopped(_ id: String) -> Bool { (try? read(Bool.self, "\(id).stop")) == true }
}

final class ScreenNoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

enum ScreenLeaseAPI {
    private struct Renewal: Decodable { let url: String?; let expiresAt: String }
    struct Failure: Error { let status: Int }
    static func permanent(status: Int) -> Bool { ScreenLeasePolicy.permanent(status) }
    static func request(_ credentials: ScreenCredentials, action: String, refreshPush: Bool = true) async throws -> ScreenCredentials {
        guard credentials.valid, let url = URL(string: credentials.renewUrl) else { throw URLError(.badURL) }
        var request = URLRequest(url: url, timeoutInterval: 5)
        request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["publisherId": credentials.publisherId, "leaseToken": credentials.leaseToken, "action": action, "refreshPush": refreshPush])
        let session = URLSession(configuration: .ephemeral, delegate: ScreenNoRedirect(), delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard (200..<300).contains(response.statusCode) else { throw Failure(status: response.statusCode) }
        if action == "stop" { return credentials }
        let renewal = try JSONDecoder().decode(Renewal.self, from: data)
        if refreshPush && renewal.url == nil { throw URLError(.badServerResponse) }
        var next = credentials; next.url = renewal.url ?? credentials.url; next.expiresAt = renewal.expiresAt
        guard next.valid, next.expiry > Date(), next.expiry.timeIntervalSinceNow <= 65 else { throw URLError(.badServerResponse) }
        return next
    }
}

private extension ISO8601DateFormatter {
    static func replayDate(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value)
    }
}

/** One serialized maintenance loop; transport recovery never extends authorization itself. */
struct ScreenRecovery {
    enum Action { case wait, renew, reconnect, stop }
    enum Status: String { case connecting, connected, disconnected, stopped }
    private(set) var deadline: Date
    private(set) var status: Status = .connecting
    var connected: Bool { status == .connected }
    private var retryAt = Date.distantPast
    private var failures = 0

    init(deadline: Date) { self.deadline = deadline }
    private mutating func transition(_ event: String) {
        if let target = ScreenLeasePolicy.transitions[status.rawValue]?[event], let next = Status(rawValue: target) { status = next }
    }
    private mutating func active(now: Date) -> Bool {
        if now >= deadline { transition("stop") }
        return status != .stopped
    }
    mutating func next(now: Date) -> Action {
        guard active(now: now) else { return .stop }
        if now < retryAt { return .wait }
        return connected ? .renew : .reconnect
    }
    mutating func renewed(until: Date, now: Date) {
        guard active(now: now), until > now else { transition("stop"); return }
        deadline = min(until, now.addingTimeInterval(ScreenLeasePolicy.lease))
    }
    mutating func succeeded(now: Date) {
        guard active(now: now) else { return }
        transition("connected"); failures = 0; retryAt = now.addingTimeInterval(ScreenLeasePolicy.renew)
    }
    mutating func disconnected(now: Date) {
        guard active(now: now) else { return }
        transition("disconnected"); retryAt = now
    }
    mutating func failed(permanent: Bool, now: Date) {
        guard active(now: now) else { return }
        if permanent { transition("stop"); return }
        retryAt = now.addingTimeInterval(ScreenLeasePolicy.retry[min(failures, ScreenLeasePolicy.retry.count - 1)])
        failures = min(failures + 1, 3)
    }
}

// 屏幕租约协议 v1 的时间与重试策略；与 Android 的 ScreenRecovery.kt 必须一致（见 docs/screen-capture.md）。
private enum ScreenLeasePolicy {
    static let lease: TimeInterval = 60
    static let renew: TimeInterval = 20
    static let retry: [TimeInterval] = [1, 2, 4, 5]
    static func permanent(_ status: Int) -> Bool { (400..<500).contains(status) && ![408, 425, 429].contains(status) }
    static let transitions: [String: [String: String]] = [
        "connecting": ["connected": "connected", "disconnected": "disconnected", "stop": "stopped"],
        "connected": ["connected": "connected", "disconnected": "disconnected", "stop": "stopped"],
        "disconnected": ["connected": "connected", "disconnected": "disconnected", "stop": "stopped"],
        "stopped": ["connected": "stopped", "disconnected": "stopped", "stop": "stopped"]
    ]
}

/**
 * Keeps the ReplayKit RTMP push near real time. HaishinKit's RTMP socket queues every encoded frame without
 * limit, so on an uplink slower than the encoder bitrate the screen fell further and further behind the
 * classroom audio (sent separately by the WebView's adaptive WebRTC push). One sample per second from the
 * network monitor: lower the bitrate to what the uplink delivers, and while the queue holds over a second of
 * video stop feeding the encoder (dropping before encoding keeps every sent frame decodable) until it drains.
 */
struct ScreenUplinkPolicy: Sendable {
    static let maximumBitRate = 3_000_000
    static let minimumBitRate = 500_000
    /// Seconds without queue growth before stepping the bitrate back up by a tenth of the maximum.
    static let steadySeconds = 10
    private(set) var bitRate = maximumBitRate
    private(set) var gated = false
    private var steady = 0

    /// Returns the new encoder bitrate when it should change.
    mutating func observe(queueBytes: Int, sentBytesPerSecond: Int, insufficient: Bool) -> Int? {
        let backlog = Double(max(0, queueBytes) * 8) / Double(bitRate)
        if backlog > 1 { gated = true } else if backlog < 0.25 { gated = false }
        var next = bitRate
        if insufficient || backlog > 0.5 {
            steady = 0
            next = sentBytesPerSecond > 0 ? min(bitRate, sentBytesPerSecond * 8 * 85 / 100) : bitRate / 2
        } else {
            steady += 1
            if steady >= Self.steadySeconds { steady = 0; next = bitRate + Self.maximumBitRate / 10 }
        }
        next = min(Self.maximumBitRate, max(Self.minimumBitRate, next))
        guard next != bitRate else { return nil }
        bitRate = next
        return next
    }

    mutating func reset() { bitRate = Self.maximumBitRate; gated = false; steady = 0 }
}
