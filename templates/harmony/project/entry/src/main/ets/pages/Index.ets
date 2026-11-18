import { common } from '@kit.AbilityKit';
import { webview } from '@kit.ArkWeb';
import { HarmonyBridge } from '../web/HarmonyBridge';
import { bridgePermission, bundleResource, trustedUrl } from '../web/WebPolicy';
import { selectWebFiles, WebFiles } from '../web/WebFiles';
import { BRIDGE_SCRIPT } from '../generated/BridgeScript';
import { WEB_ORIGIN } from '../generated/WebBundle';

@Entry
@Component
struct Index {
  private controller: webview.WebviewController = new webview.WebviewController();
  private context = this.getUIContext().getHostContext() as common.UIAbilityContext;
  private bridge = new HarmonyBridge(this.context, this.controller);
  private files = new WebFiles(this.context, this.getUIContext().getPromptAction(),
    () => this.bridge.currentGeneration(), generation => this.bridge.isCurrent(generation));
  @State private failed: boolean = false;
  private lifecycleId: number = -1;

  aboutToAppear(): void {
    webview.WebviewController.setWebDebuggingAccess(false);
    this.lifecycleId = this.context.getApplicationContext().on('abilityLifecycle', {
      onAbilityCreate: () => {}, onAbilityDestroy: () => {}, onAbilityContinue: () => {},
      onWindowStageCreate: () => {}, onWindowStageDestroy: () => {}, onWindowStageActive: () => {},
      onWindowStageInactive: () => {}, onAbilityForeground: () => { this.bridge.foreground(); },
      onAbilityBackground: () => { this.bridge.background(); }
    });
  }
  aboutToDisappear(): void {
    this.bridge.dispose();
    this.context.getApplicationContext().off('abilityLifecycle', this.lifecycleId);
  }
  onBackPress(): boolean {
    try { if (this.controller.accessBackward()) { this.controller.backward(); return true; } } catch {}
    if (this.bridge.recording.active) { this.context.moveAbilityToBackground().catch(() => {}); return true; }
    return false;
  }
  private async requestMicrophone(request: PermissionRequest): Promise<void> {
    if (!trustedUrl(request.getOrigin()) || request.getAccessibleResource().some(resource =>
      resource !== ProtectedResourceType.AUDIO_CAPTURE)) { request.deny(); return; }
    try {
      const status = await this.bridge.microphone.request();
      if (status.microphone === 'granted') request.grant([ProtectedResourceType.AUDIO_CAPTURE]);
      else request.deny();
    } catch { try { request.deny(); } catch {} }
  }
  build() {
    Stack() {
      Web({ src: `${WEB_ORIGIN}/`, controller: this.controller })
        .width('100%').height('100%').javaScriptAccess(true).domStorageAccess(true).databaseAccess(true)
        .fileAccess(false).mixedMode(MixedMode.None).multiWindowAccess(false)
        .javaScriptProxy({ object: this.bridge, name: 'appshellNative', methodList: ['getInfo', 'postMessage'],
          controller: this.controller, permission: bridgePermission() })
        .onControllerAttached(() => {
          this.controller.setDownloadDelegate(this.files.downloads);
          this.controller.runJavaScript(BRIDGE_SCRIPT).catch(() => {});
        })
        .onInterceptRequest(event => bundleResource(event.request)!)
        .onPermissionRequest(event => { this.requestMicrophone(event.request); })
        .onMicrophoneCaptureStateChange(event => { this.bridge.captureChanged(event.newState); })
        .onShowFileSelector(event => { selectWebFiles(this.context, event, () => this.bridge.isCurrent(this.bridge.currentGeneration())); return true; })
        .onOverrideUrlLoading(request => {
          const target = request.getRequestUrl();
          if (trustedUrl(target)) return false;
          if (!request.isMainFrame()) return !/^https:\/\//.test(target);
          if (request.isRequestGesture() && /^https:\/\//.test(target)) this.context.openLink(target).catch(() => {});
          return true;
        })
        .onRenderExited(() => { this.bridge.pageChanged(); this.failed = true; })
        .onErrorReceive(event => { if (event.request.isMainFrame()) { this.bridge.pageChanged(); this.failed = true; } })
        .onPageEnd(() => { this.failed = false; });
      if (this.failed) {
        Column({ space: 16 }) {
          Text('Unable to open the application').fontSize(18);
          Button('Retry').onClick(() => { this.failed = false; this.controller.loadUrl(`${WEB_ORIGIN}/`); });
        }.width('100%').height('100%').justifyContent(FlexAlign.Center)
      }
    }.width('100%').height('100%');
  }
}
