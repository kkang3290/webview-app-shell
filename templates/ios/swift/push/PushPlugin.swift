import Capacitor
import UIKit
import UserNotifications

/// 推送（Android 同名同语义）。iOS 直连 APNs，返回十六进制设备令牌，交给业务后端按 environment 选择
/// sandbox / production 网关发送。register() 应在用户同意隐私政策之后调用。
@objc(PushPlugin)
final class PushPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "PushPlugin"
    let jsName = "Push"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "register", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unregister", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getLaunchNotification", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearAll", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setBadge", returnType: CAPPluginReturnPromise),
    ]

    static func tokenResult(_ token: String) -> [String: Any] {
        ["provider": "apns", "token": token, "environment": AppShellConfig.apnsEnvironment]
    }

    override func load() {
        PushManager.shared.plugin = self
        self.bridge?.notificationRouter.pushNotificationHandler = PushManager.shared
    }

    func emit(_ event: String, _ data: [String: Any]) {
        self.notifyListeners(event, data: data, retainUntilConsumed: event == "opened")
    }

    @objc func register(_ call: CAPPluginCall) {
        var options: UNAuthorizationOptions = [.alert, .sound, .badge]
        #if DEBUG && targetEnvironment(simulator)
            // 自动化验证用：模拟器里没法替用户点「允许」，临时授权（provisional）不弹窗。
            if ProcessInfo.processInfo.environment["APPSHELL_PUSH_PROVISIONAL"] == "1" { options.insert(.provisional) }
        #endif
        UNUserNotificationCenter.current().requestAuthorization(options: options) { granted, error in
            if let error { return call.reject("notification authorization failed: \(error.localizedDescription)") }
            guard granted else { return call.reject("notification permission denied", "PERMISSION_DENIED") }
            PushManager.shared.consented = true
            var finished = false
            DispatchQueue.main.asyncAfter(deadline: .now() + 20) {
                guard !finished else { return }
                finished = true
                call.reject("APNs registration timed out (check the aps-environment entitlement and network)", "TIMEOUT")
            }
            PushManager.shared.register { result in
                guard !finished else { return }
                finished = true
                switch result {
                case let .success(token): call.resolve(Self.tokenResult(token))
                case let .failure(error): call.reject("APNs registration failed: \(error.localizedDescription)", "REGISTER_FAILED")
                }
            }
        }
    }

    @objc func getToken(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let token = PushManager.shared.token { call.resolve(Self.tokenResult(token)) } else { call.resolve(["provider": "apns"]) }
        }
    }

    @objc func unregister(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            PushManager.shared.consented = false
            UIApplication.shared.unregisterForRemoteNotifications()
            call.resolve()
        }
    }

    @objc func getLaunchNotification(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            call.resolve(["notification": PushManager.shared.takeLaunchNotification() as Any])
        }
    }

    @objc func clearAll(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
        call.resolve()
    }

    @objc func setBadge(_ call: CAPPluginCall) {
        guard let count = call.getInt("count"), count >= 0 else { return call.reject("count must be a non-negative integer") }
        if #available(iOS 16.0, *) {
            UNUserNotificationCenter.current().setBadgeCount(count) { error in
                if let error { call.reject(error.localizedDescription) } else { call.resolve() }
            }
        } else {
            // iOS 15：只有 UIApplication 的角标属性（主线程）
            DispatchQueue.main.async {
                UIApplication.shared.applicationIconBadgeNumber = count
                call.resolve()
            }
        }
    }
}
