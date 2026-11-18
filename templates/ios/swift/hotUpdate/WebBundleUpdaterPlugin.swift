import Capacitor
import CryptoKit
import Foundation

/// Web 产物热更新：下载 zip → sha256 校验 → 解压 → 切换服务目录。与 Android 的 WebBundleUpdater 同名同接口。
/// 状态机与坏包防护在 WebBundleStore；切换发生在容器创建前（ShellWebViewController.instanceDescriptor）。
@objc(WebBundleUpdaterPlugin)
final class WebBundleUpdaterPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "WebBundleUpdaterPlugin"
    let jsName = "WebBundleUpdater"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getInfo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "notifyReady", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "install", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "activate", returnType: CAPPluginReturnPromise),
    ]

    private enum Failure: Error { case http(Int), checksum, invalid(String) }
    private let queue = DispatchQueue(label: "appshell.webbundle", qos: .utility)

    override func load() {
        guard AppShellConfig.hotUpdateApply == "next-launch" else { return }
        self.queue.async { self.checkInBackground() }
    }

    /// 查最新版 → 比当前新、不是坏包、没下过 → 下载校验解压，记为待启用。失败安静放弃，下次启动再试。
    private func checkInBackground() {
        guard let latestURL = URL(string: AppShellConfig.hotUpdateLatestURL),
              let body = try? self.get(latestURL),
              let latest = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              let version = latest["version"] as? String, let raw = latest["url"] as? String,
              WebBundleStore.isNewer(version, than: WebBundleStore.currentVersion),
              !WebBundleStore.badVersions.contains(version), WebBundleStore.pendingVersion != version,
              let url = URL(string: raw, relativeTo: latestURL)?.absoluteURL, url.scheme == "https",
              let sums = try? self.get(URL(string: url.absoluteString + ".sha256")!),
              let sha256 = Self.parseSha256(String(decoding: sums, as: UTF8.self))
        else { return }
        guard (try? self.install(url: url, version: version, sha256: sha256)) != nil else { return }
        WebBundleStore.setPending(version)
        WebBundleStore.prune(keeping: version)
    }

    static func parseSha256(_ body: String) -> String? {
        let first = body.trimmingCharacters(in: .whitespacesAndNewlines).split(whereSeparator: { $0 == " " || $0 == "\n" || $0 == "\t" }).first
        guard let value = first, value.range(of: "^[0-9a-fA-F]{64}$", options: .regularExpression) != nil else { return nil }
        return value.lowercased()
    }

    @objc func getInfo(_ call: CAPPluginCall) {
        call.resolve([
            "shellVersion": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "",
            "bundleVersion": WebBundleStore.activeVersion as Any? ?? NSNull(),
            "apply": AppShellConfig.hotUpdateApply,
            "webVersion": WebBundleStore.currentVersion,
        ])
    }

    @objc func notifyReady(_ call: CAPPluginCall) {
        WebBundleStore.confirmReady()
        call.resolve()
    }

    @objc func install(_ call: CAPPluginCall) {
        guard let raw = call.getString("url"), let url = URL(string: raw), url.scheme == "https",
              let version = call.getString("version"), WebBundleStore.isVersion(version),
              let sha256 = call.getString("sha256").flatMap(Self.parseSha256)
        else {
            call.reject("install 需要 https 的 url、三段数字的 version 与 sha256")
            return
        }
        self.queue.async {
            do {
                let directory = try self.install(url: url, version: version, sha256: sha256)
                WebBundleStore.prune(keeping: version)
                call.resolve(["path": directory.path])
            } catch {
                call.reject("热更新包安装失败: \(error)")
            }
        }
    }

    @objc func activate(_ call: CAPPluginCall) {
        guard let version = call.getString("version"), WebBundleStore.isVersion(version) else {
            call.reject("activate 需要 version")
            return
        }
        // 只认自己解出来的那个目录；页面传来的 path 仅用于核对，不当成任意路径去加载
        let directory = WebBundleStore.directory(version)
        if let path = call.getString("path"), URL(fileURLWithPath: path).standardizedFileURL.path != directory.standardizedFileURL.path {
            call.reject("path 与 version 不对应", "WEB_BUNDLE_CONTRACT_MISMATCH")
            return
        }
        do { try WebBundleStore.validate(directory) } catch {
            call.reject("\(error)", "WEB_BUNDLE_CONTRACT_MISMATCH")
            return
        }
        WebBundleStore.setActive(version, attempts: 0)
        DispatchQueue.main.async {
            // 换服务目录并原地重载到新包
            (self.bridge?.viewController as? CAPBridgeViewController)?.setServerBasePath(path: directory.path)
            call.resolve()
        }
    }

    // ── 下载与解压 ──────────────────────────────────────────────

    /// 已经解过同版本且契约相符就直接复用；否则下载、校验 sha256、解压到临时目录、校验契约后改名就位。
    private func install(url: URL, version: String, sha256: String) throws -> URL {
        let final = WebBundleStore.directory(version)
        if (try? WebBundleStore.validate(final)) != nil { return final }
        let files = FileManager.default
        let archive = files.temporaryDirectory.appendingPathComponent("appshell-webbundle-\(version).zip")
        let staging = WebBundleStore.root.appendingPathComponent("\(version).tmp", isDirectory: true)
        defer {
            try? files.removeItem(at: archive)
            try? files.removeItem(at: staging)
        }
        try? files.removeItem(at: archive)
        try self.download(url, to: archive)
        guard try Self.sha256(of: archive) == sha256 else { throw Failure.checksum }
        try? files.removeItem(at: staging)
        try files.createDirectory(at: staging, withIntermediateDirectories: true)
        try ShellZip.extract(archive, to: staging)
        try WebBundleStore.validate(staging)
        try? files.removeItem(at: final)
        try files.moveItem(at: staging, to: final)
        // 热更包随时可以重新下载，不占用户的 iCloud 备份
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var root = WebBundleStore.root
        try? root.setResourceValues(values)
        return final
    }

    private static func sha256(of file: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty { hasher.update(data: chunk) }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 600
        return URLSession(configuration: configuration)
    }()

    private func get(_ url: URL) throws -> Data {
        var result: Result<Data, Error> = .failure(Failure.invalid("no response"))
        let done = DispatchSemaphore(value: 0)
        Self.session.dataTask(with: url) { data, response, error in
            if let error { result = .failure(error) }
            else if let status = (response as? HTTPURLResponse)?.statusCode, status != 200 { result = .failure(Failure.http(status)) }
            else { result = .success(data ?? Data()) }
            done.signal()
        }.resume()
        done.wait()
        return try result.get()
    }

    private func download(_ url: URL, to target: URL) throws {
        var result: Result<Void, Error> = .failure(Failure.invalid("no response"))
        let done = DispatchSemaphore(value: 0)
        Self.session.downloadTask(with: url) { file, response, error in
            if let error { result = .failure(error) }
            else if let status = (response as? HTTPURLResponse)?.statusCode, status != 200 { result = .failure(Failure.http(status)) }
            else if let file { result = Result { try FileManager.default.moveItem(at: file, to: target) } }
            done.signal()
        }.resume()
        done.wait()
        try result.get()
    }
}
