import Foundation

/// 系统交给 App 的链接（自定义 scheme、通用链接）的统一入口。
/// AppDelegate / SceneDelegate 收到就交到这里；业务扩展用 `subscribe` 接。冷启动时链接可能先于订阅到达，
/// 所以没人订阅前先存着，订阅时补发。Capacitor 自己的 `appUrlOpen` 事件不受影响。
@MainActor
final class AppShellLinks {
    static let shared = AppShellLinks()
    private var pendingURLs: [URL] = []
    private var pendingActivities: [NSUserActivity] = []
    private var urlHandlers: [(URL) -> Void] = []
    private var activityHandlers: [(NSUserActivity) -> Void] = []

    func open(_ url: URL) {
        if self.urlHandlers.isEmpty {
            self.pendingURLs = Array((self.pendingURLs + [url]).suffix(8))
            return
        }
        for handler in self.urlHandlers { handler(url) }
    }

    func resume(_ activity: NSUserActivity) {
        if self.activityHandlers.isEmpty {
            self.pendingActivities = Array((self.pendingActivities + [activity]).suffix(8))
            return
        }
        for handler in self.activityHandlers { handler(activity) }
    }

    /// 订阅之后的链接实时送达；订阅之前攒下的立即补发一次。
    func subscribe(url: @escaping (URL) -> Void, activity: @escaping (NSUserActivity) -> Void) {
        self.urlHandlers.append(url)
        self.activityHandlers.append(activity)
        let urls = self.pendingURLs, activities = self.pendingActivities
        self.pendingURLs.removeAll()
        self.pendingActivities.removeAll()
        for item in urls { url(item) }
        for item in activities { activity(item) }
    }
}
