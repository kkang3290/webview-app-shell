import Capacitor
import UIKit

/// 一项系统权限。每个权限一个文件，按 appshell.config.json permissions 编入——
/// 没声明的权限连 API 引用都不进二进制，审核不会因此要求补说明文字。
protocol ShellPermission {
    var name: String { get }
    /// granted / denied / prompt / unsupported
    func check(_ done: @escaping (String) -> Void)
    func request(_ done: @escaping (String) -> Void)
}

/// 统一权限接口（Android 同名同语义）：check / request / openSettings。
@objc(PermissionsPlugin)
final class PermissionsPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "PermissionsPlugin"
    let jsName = "Permissions"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "check", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "request", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise),
    ]
    static let known = ["microphone", "camera", "notifications", "photos", "location"]
    private let providers: [String: ShellPermission] = Dictionary(
        uniqueKeysWithValues: AppShellPermissions.all.map { ($0.name, $0) }
    )

    private func names(_ call: CAPPluginCall) -> [String]? {
        guard let raw = call.getArray("names", String.self), !raw.isEmpty else {
            call.reject("names must be a non-empty array of strings", "INVALID")
            return nil
        }
        var names: [String] = []
        for name in raw where !names.contains(name) {
            guard Self.known.contains(name) else {
                call.reject("unknown permission \(name)", "INVALID")
                return nil
            }
            guard self.providers[name] != nil else {
                call.reject("\(name) is not declared in appshell.config.json permissions", "INVALID")
                return nil
            }
            names.append(name)
        }
        return names
    }

    private func collect(_ names: [String], request: Bool, _ done: @escaping ([String: String]) -> Void) {
        // 逐个来：系统权限弹窗不能叠在一起。
        var result: [String: String] = [:]
        func step(_ index: Int) {
            guard index < names.count else {
                done(result)
                return
            }
            let provider = self.providers[names[index]]!
            let next: (String) -> Void = { state in
                DispatchQueue.main.async {
                    result[names[index]] = state
                    step(index + 1)
                }
            }
            if request {
                provider.check { state in
                    if state == "prompt" { DispatchQueue.main.async { provider.request(next) } } else { next(state) }
                }
            } else {
                provider.check(next)
            }
        }
        DispatchQueue.main.async { step(0) }
    }

    @objc func check(_ call: CAPPluginCall) {
        guard let names = self.names(call) else { return }
        self.collect(names, request: false) { call.resolve($0) }
    }

    @objc func request(_ call: CAPPluginCall) {
        guard let names = self.names(call) else { return }
        self.collect(names, request: true) { call.resolve($0) }
    }

    @objc func openSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let url = URL(string: UIApplication.openSettingsURLString) else {
                call.reject("System settings are unavailable")
                return
            }
            UIApplication.shared.open(url) { opened in
                if opened { call.resolve() } else { call.reject("System settings could not be opened") }
            }
        }
    }
}
