import Capacitor
import UIKit

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        self.window = UIWindow(windowScene: windowScene)
        self.window?.rootViewController = ShellHostViewController()
        self.window?.makeKeyAndVisible()

        // 冷启动带来的链接：先交给外壳的统一入口（业务扩展订阅时补发），再交给 Capacitor
        for context in connectionOptions.urlContexts { AppShellLinks.shared.open(context.url) }
        for activity in connectionOptions.userActivities { AppShellLinks.shared.resume(activity) }
        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        for context in URLContexts { AppShellLinks.shared.open(context.url) }
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        AppShellLinks.shared.resume(userActivity)
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
