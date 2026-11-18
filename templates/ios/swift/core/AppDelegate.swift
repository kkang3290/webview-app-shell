import Capacitor
import UIKit

/// 外壳的 AppDelegate：系统回调（后台上传唤醒、推送令牌）统一转给生成的 AppShellHooks，
/// 由启用的能力组各自接住；没启用的能力组对应的钩子是空实现。
@main
class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions _: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        AppShellHooks.didFinishLaunching(application)
        return true
    }

    func application(_: UIApplication, handleEventsForBackgroundURLSession identifier: String,
                     completionHandler: @escaping () -> Void)
    {
        if !AppShellHooks.handleBackgroundSession(identifier, completionHandler) { completionHandler() }
    }

    func application(_: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        AppShellHooks.didRegisterForRemoteNotifications(deviceToken)
    }

    func application(_: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        AppShellHooks.didFailToRegisterForRemoteNotifications(error)
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        AppShellLinks.shared.open(url)
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity,
                     restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool
    {
        AppShellLinks.shared.resume(userActivity)
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

    func application(_: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession,
                     options _: UIScene.ConnectionOptions) -> UISceneConfiguration
    {
        let config = UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}
