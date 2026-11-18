import Capacitor
import UIKit
import UserNotifications

/// APNs 令牌、前台展示与点击的进程级入口。
/// 冷启动时（用户点通知把 App 拉起来）Capacitor 的 bridge 还没建好，所以启动时先把自己设为
/// UNUserNotificationCenter 的代理接住那一下；bridge 建好后 Capacitor 接管代理，再通过
/// notificationRouter.pushNotificationHandler 转回这里。
final class PushManager: NSObject, UNUserNotificationCenterDelegate, NotificationHandlerProtocol {
    static let shared = PushManager()
    private static let consentKey = "appshell.push.consented"

    weak var plugin: PushPlugin?
    private(set) var token: String?
    private var waiting: [(Result<String, Error>) -> Void] = []
    private var launchNotification: [String: Any]?

    var consented: Bool {
        get { UserDefaults.standard.bool(forKey: Self.consentKey) }
        set { UserDefaults.standard.set(newValue, forKey: Self.consentKey) }
    }

    func didFinishLaunching(_ application: UIApplication) {
        UNUserNotificationCenter.current().delegate = self
        // 以前同意过：每次启动都重新注册，系统可能换发令牌。
        if self.consented { application.registerForRemoteNotifications() }
    }

    func register(_ done: @escaping (Result<String, Error>) -> Void) {
        DispatchQueue.main.async {
            if let token = self.token { return done(.success(token)) }
            self.waiting.append(done)
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    func didRegister(_ data: Data) {
        let token = data.map { String(format: "%02x", $0) }.joined()
        DispatchQueue.main.async {
            self.token = token
            let callbacks = self.waiting
            self.waiting.removeAll()
            callbacks.forEach { $0(.success(token)) }
            self.plugin?.emit("token", PushPlugin.tokenResult(token))
        }
    }

    func didFailToRegister(_ error: Error) {
        DispatchQueue.main.async {
            let callbacks = self.waiting
            self.waiting.removeAll()
            callbacks.forEach { $0(.failure(error)) }
        }
    }

    func takeLaunchNotification() -> [String: Any]? {
        defer { self.launchNotification = nil }
        return self.launchNotification
    }

    static func payload(_ notification: UNNotification) -> [String: Any] {
        let content = notification.request.content
        var data: [String: Any] = [:]
        for (key, value) in content.userInfo {
            guard let key = key as? String, key != "aps" else { continue }
            data[key] = value
        }
        return ["id": notification.request.identifier, "title": content.title, "body": content.body, "data": data]
    }

    private func presentation(_ notification: UNNotification) -> UNNotificationPresentationOptions {
        self.plugin?.emit("received", Self.payload(notification))
        // 前台也展示横幅：业务想自己画应用内提示，可以在 received 事件里处理后忽略系统横幅。
        return [.banner, .list, .sound]
    }

    private func opened(_ response: UNNotificationResponse) {
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier else { return }
        let payload = Self.payload(response.notification)
        self.launchNotification = payload
        self.plugin?.emit("opened", payload)
    }

    // UNUserNotificationCenterDelegate（bridge 建好之前）
    func userNotificationCenter(_: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completion: @escaping (UNNotificationPresentationOptions) -> Void)
    {
        completion(self.presentation(notification))
    }

    func userNotificationCenter(_: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completion: @escaping () -> Void)
    {
        self.opened(response)
        completion()
    }

    // NotificationHandlerProtocol（Capacitor 接管代理之后）
    func willPresent(notification: UNNotification) -> UNNotificationPresentationOptions {
        self.presentation(notification)
    }

    func didReceive(response: UNNotificationResponse) {
        self.opened(response)
    }
}
