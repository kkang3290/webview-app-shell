import Foundation

/// Web 热更新的状态与文件布局（与 Android 的 WebBundleUpdater 同一套语义）。
///
/// 包解在 Library/Application Support/appshell-webbundles/<版本>/；状态存 UserDefaults，只记版本号不记绝对路径
/// （App 容器路径会变）。坏包防护是两阶段确认：切包后 confirmed=false，页面启动成功要调 notifyReady；
/// 连续两次冷启动都没等到确认就回退内置产物，并把该版本记为坏包，不再启用也不再下载。
/// 装了新的安装包（版本或 build 号变了）时清掉热更状态，回到新安装包内置的产物。
enum WebBundleStore {
    enum Failure: Error { case contract(String) }

    private static let defaults = UserDefaults.standard
    private static let activeKey = "appshell.webbundle.active"
    private static let confirmedKey = "appshell.webbundle.confirmed"
    private static let attemptsKey = "appshell.webbundle.attempts"
    private static let pendingKey = "appshell.webbundle.pending"
    private static let badKey = "appshell.webbundle.bad"
    private static let binaryKey = "appshell.webbundle.binary"
    private static let maxBootAttempts = 2
    static let manifestFile = "appshell-build.json"

    static var root: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("appshell-webbundles", isDirectory: true)
    }

    static func directory(_ version: String) -> URL { self.root.appendingPathComponent(version, isDirectory: true) }

    static var activeVersion: String? { self.defaults.string(forKey: self.activeKey) }
    static var pendingVersion: String? { self.defaults.string(forKey: self.pendingKey) }
    static var badVersions: [String] { self.defaults.stringArray(forKey: self.badKey) ?? [] }

    /// 安装包内置产物的 Web 版本。
    static let embeddedVersion: String = {
        guard let file = Bundle.main.url(forResource: "appshell-build", withExtension: "json", subdirectory: "public"),
              let data = try? Data(contentsOf: file),
              let manifest = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let version = manifest["webVersion"] as? String else { return "" }
        return version
    }()

    /// 当前在跑的 Web 版本：正在用热更包就是它的版本，否则是内置产物的版本。
    static var currentVersion: String { self.activeVersion ?? self.embeddedVersion }

    static func isVersion(_ value: String) -> Bool {
        value.range(of: "^\\d+\\.\\d+\\.\\d+$", options: .regularExpression) != nil
    }

    /// 按 "." 分段比数值；任何一方不是三段数字就判 false——宁可不更新。
    static func isNewer(_ remote: String, than local: String) -> Bool {
        guard self.isVersion(remote), self.isVersion(local) else { return false }
        let a = remote.split(separator: ".").compactMap { Int($0) }, b = local.split(separator: ".").compactMap { Int($0) }
        guard a.count == 3, b.count == 3 else { return false }
        for index in 0 ..< 3 where a[index] != b[index] { return a[index] > b[index] }
        return false
    }

    /// 只接受指定 appId、同一环境、干净源码构建的包——跨 App 或跨环境的包装上去就是事故。
    static func validate(_ directory: URL, appId: String = AppShellConfig.hotUpdateBundleAppId,
                         environment: String = AppShellConfig.environment) throws
    {
        guard FileManager.default.fileExists(atPath: directory.appendingPathComponent("index.html").path) else {
            throw Failure.contract("Web Bundle 缺少 index.html")
        }
        guard let data = try? Data(contentsOf: directory.appendingPathComponent(self.manifestFile)),
              let manifest = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { throw Failure.contract("Web Bundle 缺少 \(self.manifestFile)") }
        guard manifest["schemaVersion"] as? Int == 1, manifest["sourceDirty"] as? Bool == false,
              let commit = manifest["sourceCommit"] as? String,
              commit.range(of: "^[0-9a-fA-F]{40}$", options: .regularExpression) != nil
        else { throw Failure.contract("Web Bundle 来源不完整或不是干净源码构建") }
        guard manifest["appId"] as? String == appId else { throw Failure.contract("Web Bundle 不属于 \(appId)") }
        guard manifest["environment"] as? String == environment else { throw Failure.contract("Web Bundle 不是 \(environment) 环境的构建") }
    }

    private static var prepared: URL??

    /// 容器创建前调用一次，返回这次冷启动要用的服务目录（nil = 用内置产物）：
    /// 1. 换了安装包：清掉热更状态；
    /// 2. 坏包防护：上次切了包但连续冷启动没等到 notifyReady → 回退并记坏包；
    /// 3. 自动热更新（next-launch）：上次后台下载好的更新的包，这次直接启用（仍走两阶段确认）。
    static func prepareBeforeBridge() -> URL? {
        if let prepared = self.prepared { return prepared }
        let result = self.prepare()
        self.prepared = .some(result)
        return result
    }

    private static func prepare() -> URL? {
        let info = Bundle.main.infoDictionary
        let binary = "\(info?["CFBundleShortVersionString"] as? String ?? "")-\(info?["CFBundleVersion"] as? String ?? "")"
        if self.defaults.string(forKey: self.binaryKey) != binary {
            self.clearActive()
            self.defaults.removeObject(forKey: self.pendingKey)
            try? FileManager.default.removeItem(at: self.root)
            self.defaults.set(binary, forKey: self.binaryKey)
        }
        if let active = self.activeVersion, !self.defaults.bool(forKey: self.confirmedKey) {
            let attempts = self.defaults.integer(forKey: self.attemptsKey) + 1
            if attempts >= self.maxBootAttempts {
                self.addBad(active)
                self.clearActive()
            } else {
                self.defaults.set(attempts, forKey: self.attemptsKey)
            }
        }
        if AppShellConfig.hotUpdateApply == "next-launch", let pending = self.pendingVersion {
            self.defaults.removeObject(forKey: self.pendingKey)
            if self.isNewer(pending, than: self.currentVersion), !self.badVersions.contains(pending),
               (try? self.validate(self.directory(pending))) != nil
            {
                // 这次冷启动算第 1 次尝试：再一次冷启动还没确认就回退
                self.setActive(pending, attempts: 1)
            }
        }
        guard let active = self.activeVersion else { return nil }
        let directory = self.directory(active)
        // 热更包不比内置产物新（或目录丢了、契约不符）就不用它
        guard self.isNewer(active, than: self.embeddedVersion), (try? self.validate(directory)) != nil else {
            self.clearActive()
            return nil
        }
        return directory
    }

    static func setActive(_ version: String, attempts: Int) {
        self.defaults.set(version, forKey: self.activeKey)
        self.defaults.set(false, forKey: self.confirmedKey)
        self.defaults.set(attempts, forKey: self.attemptsKey)
    }

    static func setPending(_ version: String) { self.defaults.set(version, forKey: self.pendingKey) }

    /// 页面确认新包能正常启动。跑内置产物时调它是 no-op。
    static func confirmReady() {
        guard self.activeVersion != nil else { return }
        self.defaults.set(true, forKey: self.confirmedKey)
        self.defaults.set(0, forKey: self.attemptsKey)
    }

    private static func clearActive() {
        self.defaults.removeObject(forKey: self.activeKey)
        self.defaults.removeObject(forKey: self.confirmedKey)
        self.defaults.removeObject(forKey: self.attemptsKey)
    }

    private static func addBad(_ version: String) {
        guard self.isVersion(version), !self.badVersions.contains(version) else { return }
        self.defaults.set(Array((self.badVersions + [version]).suffix(20)), forKey: self.badKey)
    }

    /// 只保留正在用的、待启用的和刚装好的包，其余删掉。
    static func prune(keeping version: String) {
        let keep = Set([version, self.activeVersion, self.pendingVersion].compactMap { $0 })
        for name in (try? FileManager.default.contentsOfDirectory(atPath: self.root.path)) ?? [] where !keep.contains(name) {
            try? FileManager.default.removeItem(at: self.root.appendingPathComponent(name))
        }
    }
}
