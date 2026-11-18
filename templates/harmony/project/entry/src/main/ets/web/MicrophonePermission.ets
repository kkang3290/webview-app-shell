import { abilityAccessCtrl, bundleManager, common } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';
import { MICROPHONE_ENABLED } from '../generated/WebBundle';

export class MicrophoneStatus { microphone: string = 'unsupported'; }
export class PermissionStatuses extends MicrophoneStatus {
  camera: string = 'unsupported';
  notifications: string = 'unsupported';
  photos: string = 'unsupported';
  location: string = 'unsupported';
}

export class MicrophonePermission {
  private manager = abilityAccessCtrl.createAtManager();
  private requesting: Promise<MicrophoneStatus> | undefined;
  private context: common.UIAbilityContext;
  constructor(context: common.UIAbilityContext) { this.context = context; }

  status(): MicrophoneStatus {
    if (!MICROPHONE_ENABLED) return { microphone: 'unsupported' };
    const info = bundleManager.getBundleInfoForSelfSync(bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_APPLICATION);
    const granted = this.manager.checkAccessTokenSync(info.appInfo.accessTokenId, 'ohos.permission.MICROPHONE') ===
      abilityAccessCtrl.GrantStatus.PERMISSION_GRANTED;
    const store = preferences.getPreferencesSync(this.context, { name: 'appshell-permissions' });
    return { microphone: granted ? 'granted' : store.getSync('microphoneAsked', false) ? 'denied' : 'prompt' };
  }

  statuses(): PermissionStatuses {
    const result = new PermissionStatuses();
    result.microphone = this.status().microphone;
    return result;
  }

  request(): Promise<MicrophoneStatus> {
    if (!MICROPHONE_ENABLED) return Promise.resolve(this.status());
    if (this.requesting) return this.requesting;
    this.requesting = this.requestOnce().finally(() => { this.requesting = undefined; });
    return this.requesting;
  }

  private async requestOnce(): Promise<MicrophoneStatus> {
    if (this.status().microphone === 'granted') return this.status();
    await this.manager.requestPermissionsFromUser(this.context, ['ohos.permission.MICROPHONE']);
    const store = preferences.getPreferencesSync(this.context, { name: 'appshell-permissions' });
    store.putSync('microphoneAsked', true);
    await store.flush();
    return this.status();
  }

  async openSettings(): Promise<void> {
    if (!MICROPHONE_ENABLED) throw new Error('Microphone permission is not declared');
    await this.manager.openPermissionOnSetting(this.context, 'ohos.permission.MICROPHONE');
  }
}
