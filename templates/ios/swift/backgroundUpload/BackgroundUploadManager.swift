import Foundation

protocol BackgroundUploadListener: AnyObject {
    func uploadProgress(_ id: String, sent: Int64, total: Int64)
    func uploadStateChanged(_ record: UploadRecord)
}

struct UploadRecord: Codable {
    var id: String
    var url: String
    var method: String
    var headers: [String: String]
    var label: String
    /// 相对 App 主目录（NSHomeDirectory）的路径：App 每次安装 / 升级容器路径都会变，绝对路径会失效。
    var source: String
    var staged: Bool
    var state: String
    var sent: Int64
    var total: Int64
    var attempts: Int
    var status: Int?
    var error: String?
    var responseHeaders: [String: String]
    var createdAt: String
    var finishedAt: String?

    /// 给 Web 的视图：不回显签名 URL、请求头和本地路径。
    var json: [String: Any] {
        var out: [String: Any] = [
            "id": self.id, "method": self.method, "label": self.label, "state": self.state, "sent": self.sent,
            "total": self.total, "attempts": self.attempts, "createdAt": self.createdAt,
            "responseHeaders": self.responseHeaders,
        ]
        if let status = self.status { out["status"] = status }
        if let error = self.error { out["error"] = error }
        if let finishedAt = self.finishedAt { out["finishedAt"] = finishedAt }
        return out
    }
}

/// 进程级单例：后台 URLSession 必须在 App 被系统叫醒时用同一个 identifier 重建，才能接回结果。
final class BackgroundUploadManager: NSObject, URLSessionDataDelegate {
    static let shared = BackgroundUploadManager()
    static let maxAttempts = 8
    static let maxInlineBytes = 10 * 1024 * 1024

    weak var listener: BackgroundUploadListener?
    private var completionHandler: (() -> Void)?
    private let queue = DispatchQueue(label: "org.appshell.upload")
    private let delegateQueue: OperationQueue = {
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        return queue
    }()
    private var lastProgress: [String: Date] = [:]

    static var identifier: String { (Bundle.main.bundleIdentifier ?? "app") + ".appshell.upload" }

    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.background(withIdentifier: Self.identifier)
        configuration.isDiscretionary = false
        configuration.sessionSendsLaunchEvents = true
        return URLSession(configuration: configuration, delegate: self, delegateQueue: self.delegateQueue)
    }()

    private var root: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let root = base.appendingPathComponent("appshell-uploads", isDirectory: true)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    /// App 启动或被系统叫醒时调用：重建会话，系统据此把挂起期间完成的任务回调过来。
    func reconnect() {
        // 进程被杀后，排队中、但系统里已经没有对应任务的记录（例如退避等待时被杀）重新发出去。
        self.session.getAllTasks { tasks in
            let live = Set(tasks.compactMap(\.taskDescription))
            self.queue.async {
                let names = (try? FileManager.default.contentsOfDirectory(atPath: self.root.path)) ?? []
                for name in names where name.hasSuffix(".json") {
                    guard let record = self.load(String(name.dropLast(5))),
                          ["queued", "running"].contains(record.state), !live.contains(record.id)
                    else { continue }
                    self.start(record)
                }
            }
        }
    }

    func handleEvents(_ identifier: String, _ completion: @escaping () -> Void) -> Bool {
        guard identifier == Self.identifier else { return false }
        self.completionHandler = completion
        self.reconnect()
        return true
    }

    // MARK: - 记录

    private func recordURL(_ id: String) -> URL {
        self.root.appendingPathComponent("\(id).json")
    }

    private func save(_ record: UploadRecord) {
        if let data = try? JSONEncoder().encode(record) { try? data.write(to: self.recordURL(record.id), options: .atomic) }
    }

    func record(_ id: String) -> UploadRecord? {
        self.queue.sync { self.load(id) }
    }

    private func load(_ id: String) -> UploadRecord? {
        guard Self.validId(id), let data = try? Data(contentsOf: self.recordURL(id)) else { return nil }
        return try? JSONDecoder().decode(UploadRecord.self, from: data)
    }

    func records() -> [UploadRecord] {
        self.queue.sync {
            let names = (try? FileManager.default.contentsOfDirectory(atPath: self.root.path)) ?? []
            return names.filter { $0.hasSuffix(".json") }
                .compactMap { self.load(String($0.dropLast(5))) }
                .sorted { $0.createdAt < $1.createdAt }
        }
    }

    static func validId(_ id: String) -> Bool {
        id.range(of: "^[A-Za-z0-9_-]{1,64}$", options: .regularExpression) != nil
    }

    /// 正式包只收 https；Debug 包额外允许本机回环 http，便于对着本机测试服务联调。
    static func allowedURL(_ raw: String) -> URL? {
        guard let url = URL(string: raw), let scheme = url.scheme, let host = url.host else { return nil }
        if scheme == "https" { return url }
        #if DEBUG
            if scheme == "http", ["127.0.0.1", "localhost"].contains(host), url.port != nil { return url }
        #endif
        return nil
    }

    static var home: URL { URL(fileURLWithPath: NSHomeDirectory()).standardizedFileURL.resolvingSymlinksInPath() }

    static func relativeToHome(_ url: URL) -> String {
        String(url.standardizedFileURL.resolvingSymlinksInPath().path.dropFirst(Self.home.path.count + 1))
    }

    static func resolve(_ relative: String) -> URL {
        Self.home.appendingPathComponent(relative)
    }

    /// 只允许 App 自己容器里的文件，网页不能借上传把别处的文件带出去。
    static func allowedSource(_ path: String) -> URL? {
        let file = URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath()
        let home = URL(fileURLWithPath: NSHomeDirectory()).standardizedFileURL.resolvingSymlinksInPath()
        guard file.path.hasPrefix(home.path + "/"),
              FileManager.default.fileExists(atPath: file.path)
        else { return nil }
        return file
    }

    static func now() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date())
    }

    // MARK: - 操作

    struct UploadError: LocalizedError {
        let errorDescription: String?
        init(_ message: String) { self.errorDescription = message }
    }

    func enqueue(id: String, url: String, method: String, headers: [String: String], label: String,
                 path: String?, inlineData: String?) throws -> UploadRecord
    {
        guard Self.validId(id) else { throw UploadError("id must match [A-Za-z0-9_-]{1,64}") }
        guard Self.allowedURL(url) != nil else { throw UploadError("url must be https (debug builds may also use http://127.0.0.1)") }
        guard ["PUT", "POST"].contains(method) else { throw UploadError("method must be PUT or POST") }
        for name in headers.keys where ["content-length", "host"].contains(name.lowercased()) {
            throw UploadError("header \(name) is managed by the system")
        }
        guard headers.contains(where: { $0.key.lowercased() == "content-type" && !$0.value.isEmpty }) else {
            throw UploadError("headers must include Content-Type (signed URLs usually sign it; platforms default differently)")
        }
        return try self.queue.sync {
            if self.load(id) != nil { throw UploadError("upload \(id) already exists") }
            let source: URL
            var staged = false
            if let inlineData {
                guard let bytes = Data(base64Encoded: inlineData) else { throw UploadError("file.data must be base64") }
                guard bytes.count <= Self.maxInlineBytes else {
                    throw UploadError("inline data is limited to 10 MiB; write a file and pass file.path")
                }
                source = self.root.appendingPathComponent("\(id).bin")
                try bytes.write(to: source, options: .atomic)
                staged = true
            } else if let path, let allowed = Self.allowedSource(path) {
                source = allowed
            } else {
                throw UploadError("file.path must point to an existing file inside the app container")
            }
            let size = ((try? FileManager.default.attributesOfItem(atPath: source.path))?[.size] as? NSNumber)?.int64Value ?? 0
            let record = UploadRecord(
                id: id, url: url, method: method, headers: headers, label: label, source: Self.relativeToHome(source),
                staged: staged,
                state: "queued", sent: 0, total: size, attempts: 0, status: nil, error: nil, responseHeaders: [:],
                createdAt: Self.now(), finishedAt: nil
            )
            self.save(record)
            self.start(record)
            return record
        }
    }

    private func start(_ record: UploadRecord) {
        guard let url = Self.allowedURL(record.url) else { return }
        let file = Self.resolve(record.source)
        // 源文件被业务删掉了：uploadTask(fromFile:) 会直接抛异常让 App 崩溃，这里先拦下并标记失败。
        guard FileManager.default.fileExists(atPath: file.path) else {
            var failed = record
            failed.state = "failed"
            failed.error = "source file missing"
            failed.finishedAt = Self.now()
            self.save(failed)
            self.listener?.uploadStateChanged(failed)
            return
        }
        var request = URLRequest(url: url)
        request.httpMethod = record.method
        for (name, value) in record.headers { request.setValue(value, forHTTPHeaderField: name) }
        let task = self.session.uploadTask(with: request, fromFile: file)
        task.taskDescription = record.id
        task.resume()
    }

    func cancel(_ id: String) -> UploadRecord? {
        self.session.getAllTasks { tasks in tasks.filter { $0.taskDescription == id }.forEach { $0.cancel() } }
        return self.queue.sync {
            guard var record = self.load(id) else { return nil }
            if ["queued", "running"].contains(record.state) {
                record.state = "cancelled"
                record.finishedAt = Self.now()
                self.save(record)
                self.listener?.uploadStateChanged(record)
            }
            return record
        }
    }

    func remove(_ id: String) throws {
        try self.queue.sync {
            guard let record = self.load(id) else { throw UploadError("unknown upload") }
            if ["queued", "running"].contains(record.state) { throw UploadError("cancel the upload before removing it") }
            try? FileManager.default.removeItem(at: self.recordURL(id))
            if record.staged { try? FileManager.default.removeItem(at: Self.resolve(record.source)) }
        }
    }

    // MARK: - URLSession 回调

    func urlSession(_: URLSession, task: URLSessionTask, didSendBodyData _: Int64, totalBytesSent: Int64,
                    totalBytesExpectedToSend: Int64)
    {
        guard let id = task.taskDescription else { return }
        let now = Date()
        if let last = self.lastProgress[id], now.timeIntervalSince(last) < 0.25, totalBytesSent < totalBytesExpectedToSend {
            return
        }
        self.lastProgress[id] = now
        self.queue.sync {
            guard var record = self.load(id), record.state != "cancelled" else { return }
            record.state = "running"
            record.sent = totalBytesSent
            self.save(record)
        }
        self.listener?.uploadProgress(id, sent: totalBytesSent, total: totalBytesExpectedToSend)
    }

    func urlSession(_: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let id = task.taskDescription else { return }
        self.lastProgress[id] = nil
        let response = task.response as? HTTPURLResponse
        var retry: UploadRecord?
        let finished: UploadRecord? = self.queue.sync {
            guard var record = self.load(id), record.state != "cancelled" else { return nil }
            record.attempts += 1
            record.sent = task.countOfBytesSent
            if let response {
                record.status = response.statusCode
                for (key, value) in response.allHeaderFields {
                    guard let name = (key as? String)?.lowercased(), let value = value as? String else { continue }
                    if name == "etag" || name.hasPrefix("x-") { record.responseHeaders[name] = value }
                }
            }
            if error == nil, let status = response?.statusCode, (200 ..< 300).contains(status) {
                record.state = "succeeded"
                record.error = nil
                record.finishedAt = Self.now()
            } else {
                let status = response?.statusCode ?? 0
                let transient = error != nil || status == 408 || status == 429 || status >= 500
                record.error = error.map { error in
                    let ns = error as NSError
                    return "\(ns.domain) \(ns.code): \(ns.localizedDescription)"
                } ?? "HTTP \(status)"
                if transient, record.attempts < Self.maxAttempts {
                    record.state = "queued"
                    retry = record
                } else {
                    record.state = "failed"
                    record.finishedAt = Self.now()
                }
            }
            self.save(record)
            return record
        }
        if let finished { self.listener?.uploadStateChanged(finished) }
        if let retry {
            // 退避后重发：30 秒起，每次翻倍，最多 30 分钟。
            let delay = min(30 * pow(2, Double(retry.attempts - 1)), 1800)
            self.queue.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let self, let current = self.load(retry.id), current.state == "queued" else { return }
                self.start(current)
            }
        }
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession _: URLSession) {
        DispatchQueue.main.async {
            self.completionHandler?()
            self.completionHandler = nil
        }
    }
}
