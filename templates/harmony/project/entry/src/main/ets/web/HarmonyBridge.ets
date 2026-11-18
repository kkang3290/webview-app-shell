import { common } from '@kit.AbilityKit';
import { webview } from '@kit.ArkWeb';
import { backgroundTaskManager } from '@kit.BackgroundTasksKit';
import { APP_INFO, MICROPHONE_ENABLED, RECORDING_ENABLED } from '../generated/WebBundle';
import { MicrophonePermission } from './MicrophonePermission';
import { RecordingLease } from './RecordingLease';
import { trustedUrl } from './WebPolicy';

class BridgeOptions {
  names: string[] = [];
  active: boolean = false;
  finishing: boolean = false;
}
class BridgeRequest {
  id: string = '';
  plugin: string = '';
  method: string = '';
  options: BridgeOptions = new BridgeOptions();
}
class BridgeError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
function toBridgeError(error: Error): BridgeError {
  return error instanceof BridgeError ? error as BridgeError : new BridgeError('NATIVE_ERROR', 'Harmony request failed');
}
interface ReplyError { code: string; message: string }
interface ReplyEnvelope { id: string; ok: boolean; data: Object | null; error: ReplyError | null }
interface InterruptionData { reason: string }
interface InterruptionEvent { plugin: string; event: string; data: InterruptionData }

export class HarmonyBridge {
  readonly microphone: MicrophonePermission;
  readonly recording: RecordingLease;
  private queue: Promise<void> = Promise.resolve();
  private generation: number = 0;
  private disposed: boolean = false;
  private pending: Set<string> = new Set();
  private controller: webview.WebviewController;
  private cancellation = (info: backgroundTaskManager.ContinuousTaskCancelInfo): void => {
    if (!this.disposed && this.recording.cancelTask(info.id)) this.interrupt('background-task-cancelled');
  };
  constructor(context: common.UIAbilityContext, controller: webview.WebviewController) {
    this.controller = controller;
    this.microphone = new MicrophonePermission(context);
    this.recording = new RecordingLease(context);
    if (RECORDING_ENABLED) backgroundTaskManager.on('continuousTaskCancel', this.cancellation);
  }
  currentGeneration(): number { return this.generation; }
  isCurrent(generation: number): boolean {
    try { return !this.disposed && generation === this.generation && trustedUrl(this.controller.getUrl()); }
    catch { return false; }
  }
  private trustedCaller(): boolean {
    try {
      return this.isCurrent(this.generation) && trustedUrl(this.controller.getLastJavascriptProxyCallingFrameUrl());
    } catch { return false; }
  }
  getInfo(): string { return this.trustedCaller() ? APP_INFO : ''; }

  postMessage(raw: string): void {
    if (!this.trustedCaller() || typeof raw !== 'string' || raw.length > 4096) return;
    let request: BridgeRequest;
    try { request = JSON.parse(raw) as BridgeRequest; } catch { return; }
    if (!request || typeof request.id !== 'string' || !/^hs-[A-Za-z0-9-]{1,90}$/.test(request.id)) return;
    const generation = this.generation;
    if (this.pending.size >= 64 || this.pending.has(request.id)) {
      this.reply(request.id, generation, false, null, new BridgeError('BUSY', 'Request limit or duplicate id'));
      return;
    }
    this.pending.add(request.id);
    this.handle(request, generation).then(data => { this.reply(request.id, generation, true, data); })
      .catch((error: Error) => { this.reply(request.id, generation, false, null, toBridgeError(error)); })
      .finally(() => { if (generation === this.generation) this.pending.delete(request.id); });
  }

  private async handle(request: BridgeRequest, generation: number): Promise<Object | null> {
    const envelopeKeys: string[] = ['id', 'plugin', 'method', 'options'];
    if (Object.keys(request).some((key: string) => !envelopeKeys.includes(key)) ||
      typeof request.plugin !== 'string' || typeof request.method !== 'string' ||
      !request.options || typeof request.options !== 'object' || Array.isArray(request.options)) {
      throw new BridgeError('INVALID_ARGUMENT', 'Invalid request envelope');
    }
    const options = request.options;
    if (request.plugin === 'App') {
      if (request.method !== 'getInfo') throw new BridgeError('UNSUPPORTED_METHOD', 'Unknown App method');
      this.options(options, []);
      return JSON.parse(APP_INFO) as Object;
    }
    if (request.plugin === 'Permissions') {
      if (!MICROPHONE_ENABLED) throw new BridgeError('UNSUPPORTED', 'Permissions plugin is disabled');
      if (request.method === 'openSettings') {
        this.options(options, []);
        await this.microphone.openSettings();
        return null;
      }
      if (request.method !== 'check' && request.method !== 'request') {
        throw new BridgeError('UNSUPPORTED_METHOD', 'Unknown Permissions method');
      }
      this.options(options, ['names']);
      if (!Array.isArray(options.names) || options.names.length > 5 || options.names.some(name =>
        !['microphone', 'camera', 'notifications', 'photos', 'location'].includes(name))) {
        throw new BridgeError('INVALID_ARGUMENT', 'Invalid permission names');
      }
      if (request.method === 'request' && options.names.includes('microphone')) await this.microphone.request();
      return this.microphone.statuses();
    }
    if (request.plugin === 'WebRecording') {
      if (!RECORDING_ENABLED) throw new BridgeError('UNSUPPORTED', 'WebRecording plugin is disabled');
      if (request.method !== 'setState') throw new BridgeError('UNSUPPORTED_METHOD', 'Unknown WebRecording method');
      this.options(options, ['active', 'finishing']);
      if (typeof options.active !== 'boolean' || typeof options.finishing !== 'boolean') {
        throw new BridgeError('INVALID_ARGUMENT', 'Recording state must contain two booleans');
      }
      if (options.active && this.microphone.status().microphone !== 'granted') {
        throw new BridgeError('PERMISSION_DENIED', 'Microphone permission is not granted');
      }
      const operation = this.queue.then(async () => {
        if (!this.isCurrent(generation)) throw new BridgeError('PAGE_CLOSED', 'Document changed');
        try { await this.recording.update(options.active, options.finishing); }
        catch {
          this.interrupt('lease-failed');
          throw new BridgeError('RECORDING_LEASE_FAILED', 'Unable to maintain recording lease');
        }
      });
      this.queue = operation.catch(() => {});
      await operation;
      return null;
    }
    throw new BridgeError('UNSUPPORTED_PLUGIN', 'Unknown plugin');
  }
  private options(value: BridgeOptions, allowed: string[]): void {
    const keys = Object.keys(value);
    if (keys.length !== allowed.length || keys.some(key => !allowed.includes(key))) {
      throw new BridgeError('INVALID_ARGUMENT', 'Invalid method options');
    }
  }
  private reply(id: string, generation: number, ok: boolean, data: Object | null, failure?: BridgeError): void {
    if (!this.isCurrent(generation)) return;
    let error: ReplyError | null = null;
    if (!ok) {
      const cause = failure ?? new BridgeError('NATIVE_ERROR', 'Harmony request failed');
      error = { code: cause.code, message: cause.message };
    }
    const envelope: ReplyEnvelope = { id: id, ok: ok, data: data, error: error };
    this.emitResponse(envelope);
  }
  private emitResponse(envelope: ReplyEnvelope): void {
    if (!this.isCurrent(this.generation)) return;
    try { this.controller.runJavaScript(`window.dispatchEvent(new CustomEvent('appshell:response',{detail:${JSON.stringify(envelope)}}))`).catch(() => {}); }
    catch { /* Renderer is gone; lifecycle invalidation releases its lease. */ }
  }
  private emitInterruption(event: InterruptionEvent): void {
    if (!this.isCurrent(this.generation)) return;
    try { this.controller.runJavaScript(`window.dispatchEvent(new CustomEvent('appshell:event',{detail:${JSON.stringify(event)}}))`).catch(() => {}); }
    catch { /* Renderer is gone; lifecycle invalidation releases its lease. */ }
  }

  captureChanged(state: MicrophoneCaptureState): void {
    if (!RECORDING_ENABLED) return;
    if (state !== MicrophoneCaptureState.ACTIVE && this.recording.active) {
      this.interrupt('capture-stopped');
      return;
    }
    const generation = this.generation;
    this.queue = this.queue.then(async () => {
      if (this.isCurrent(generation)) await this.recording.setCapturing(state === MicrophoneCaptureState.ACTIVE);
    }).catch(() => { if (this.isCurrent(generation)) this.interrupt('lease-failed'); });
  }
  private stopMicrophone(): void {
    try { this.controller.stopMicrophone(); } catch { /* Renderer may already have exited. */ }
  }
  private interrupt(reason: string): void {
    this.recording.invalidate();
    this.stopMicrophone();
    this.queue = this.queue.then(() => this.recording.release()).catch(() => {});
    const data: InterruptionData = { reason: reason };
    const event: InterruptionEvent = { plugin: 'WebRecording', event: 'interrupted', data: data };
    this.emitInterruption(event);
  }
  background(): void {
    this.recording.setForeground(false);
    if (this.recording.active && !this.recording.hasRecordingTask()) this.interrupt('background-without-lease');
  }
  foreground(): void {
    this.recording.setForeground(true);
    if (this.recording.active && this.microphone.status().microphone !== 'granted') this.interrupt('permission-revoked');
  }
  pageChanged(): void {
    this.generation++;
    this.pending.clear();
    this.recording.invalidate();
    this.stopMicrophone();
    this.queue = this.queue.then(() => this.recording.release()).catch(() => {});
  }
  dispose(): void {
    this.disposed = true;
    if (RECORDING_ENABLED) backgroundTaskManager.off('continuousTaskCancel', this.cancellation);
    this.pageChanged();
  }
}
