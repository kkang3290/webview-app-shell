import { common, wantAgent } from '@kit.AbilityKit';
import { backgroundTaskManager } from '@kit.BackgroundTasksKit';
import { window } from '@kit.ArkUI';
import { RECORDING_ENABLED } from '../generated/WebBundle';

// Serial callers reconcile actual ArkWeb capture with the page's active/finishing declaration.
export class RecordingLease {
  active: boolean = false;
  private mode: string = '';
  private taskId: number = -1;
  private revision: number = 0;
  private capturing: boolean = false;
  private finishing: boolean = false;
  private foreground: boolean = true;
  private screenHeld: boolean = false;
  private context: common.UIAbilityContext;
  constructor(context: common.UIAbilityContext) { this.context = context; }
  setForeground(value: boolean): void { this.foreground = value; }
  hasRecordingTask(): boolean { return this.mode === 'audioRecording'; }
  invalidate(): void { this.revision++; this.active = false; this.finishing = false; this.capturing = false; }
  cancelTask(id: number): boolean {
    if (id !== this.taskId || id < 0) return false;
    this.mode = '';
    this.taskId = -1;
    this.invalidate();
    return true;
  }

  async setCapturing(capturing: boolean): Promise<void> {
    this.capturing = capturing;
    await this.update(this.active, this.finishing);
  }

  async update(active: boolean, finishing: boolean): Promise<void> {
    if (!RECORDING_ENABLED && (active || finishing)) throw new Error('Recording helper is disabled');
    this.active = active;
    this.finishing = finishing;
    const capturing = active && this.capturing;
    const next = capturing ? 'audioRecording' : finishing ? 'dataTransfer' : '';
    const revision = this.revision;
    await this.holdScreen(capturing);
    if (revision !== this.revision) throw new Error('Recording task invalidated');
    if (this.mode === next) return;
    if (this.mode && next) {
      await backgroundTaskManager.updateBackgroundRunning(this.context, [next]);
      if (revision !== this.revision) throw new Error('Recording task invalidated');
      this.mode = next;
      return;
    }
    if (this.mode) {
      this.taskId = -1;
      try { await backgroundTaskManager.stopBackgroundRunning(this.context); } finally { this.mode = ''; }
    }
    if (!next) return;
    if (revision !== this.revision || !this.foreground) throw new Error('Start continuous tasks in foreground');
    const agent = await wantAgent.getWantAgent({
      wants: [{ bundleName: this.context.abilityInfo.bundleName, abilityName: this.context.abilityInfo.name }],
      operationType: wantAgent.OperationType.START_ABILITY, requestCode: 1,
      wantAgentFlags: [wantAgent.WantAgentFlags.UPDATE_PRESENT_FLAG]
    });
    if (revision !== this.revision || !this.foreground) throw new Error('Recording task invalidated');
    const task = await backgroundTaskManager.startBackgroundRunning(this.context, [next], agent);
    this.taskId = task.continuousTaskId ?? -1;
    this.mode = next;
    if (revision !== this.revision) {
      await this.release();
      throw new Error('Recording task invalidated');
    }
  }

  async release(): Promise<void> {
    this.invalidate();
    await this.holdScreen(false);
    if (this.mode) {
      this.taskId = -1;
      try { await backgroundTaskManager.stopBackgroundRunning(this.context); } finally { this.mode = ''; }
    }
  }
  private async holdScreen(held: boolean): Promise<void> {
    if (held === this.screenHeld) return;
    try {
      const mainWindow = await window.getLastWindow(this.context);
      await mainWindow.setWindowKeepScreenOn(held);
      this.screenHeld = held;
    } catch { /* Optional screen wake lock; the continuous task must still be reconciled. */ }
  }
}
