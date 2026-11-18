import { common } from '@kit.AbilityKit';
import { webview } from '@kit.ArkWeb';
import { picker, fileIo } from '@kit.CoreFileKit';
import { PromptAction } from '@kit.ArkUI';
import { WEB_ORIGIN } from '../generated/WebBundle';

export async function selectWebFiles(context: common.UIAbilityContext, event: OnShowFileSelectorEvent,
  current: () => boolean): Promise<void> {
  let selection: string[] = [];
  try {
    const mode = event.fileSelector.getMode();
    if (current() && (mode === FileSelectorMode.FileOpenMode || mode === FileSelectorMode.FileOpenMultipleMode)) {
      selection = await new picker.DocumentViewPicker(context).select({
        maxSelectNumber: mode === FileSelectorMode.FileOpenMultipleMode ? 50 : 1
      });
    }
  } catch { /* Cancelling the picker is an empty selection. */ }
  try { event.result.handleFileList(current() ? selection : []); } catch { /* Document was closed. */ }
}

export class WebFiles {
  readonly downloads = new webview.WebDownloadDelegate();
  private paths: Map<string, number> = new Map();
  private context: common.UIAbilityContext;
  private prompt: PromptAction;
  private generation: () => number;
  private current: (generation: number) => boolean;
  constructor(context: common.UIAbilityContext, prompt: PromptAction, generation: () => number,
    current: (generation: number) => boolean) {
    this.context = context;
    this.prompt = prompt;
    this.generation = generation;
    this.current = current;
    this.downloads.onBeforeDownload(item => {
      const revision = this.generation();
      const source = item.getUrl();
      if (!this.current(revision) || (!/^https:\/\//.test(source) && !source.startsWith(`blob:${WEB_ORIGIN}/`))) {
        item.cancel();
        return;
      }
      // The URL and suggested filename never become native filesystem paths.
      const path = `${context.cacheDir}/appshell-download-${item.getGuid().replace(/[^a-zA-Z0-9-]/g, '')}`;
      this.paths.set(path, revision);
      item.start(path);
    });
    this.downloads.onDownloadFinish(item => { this.saveDownload(item).catch(() => {}); });
    this.downloads.onDownloadFailed(item => { this.remove(item.getFullPath()); });
  }

  private async saveDownload(item: webview.WebDownloadItem): Promise<void> {
    const path = item.getFullPath();
    const revision = this.paths.get(path);
    if (revision === undefined) return;
    try {
      if (!this.current(revision)) return;
      const name = item.getSuggestedFileName().replace(/[\\/\x00-\x1f\x7f]/g, '_').replace(/^\.+/, '').slice(0, 180) || 'download';
      const destinations = await new picker.DocumentViewPicker(this.context).save({ newFileNames: [name] });
      if (!destinations.length || !this.current(revision)) return;
      const output = await fileIo.open(destinations[0], fileIo.OpenMode.WRITE_ONLY | fileIo.OpenMode.TRUNC);
      try { if (this.current(revision)) await fileIo.copyFile(path, output.fd); }
      finally { await fileIo.close(output); }
    } catch { if (this.current(revision)) this.prompt.showToast({ message: 'Unable to save file. Please retry.' }); }
    finally { this.remove(path); }
  }
  private remove(path: string): void {
    if (!this.paths.delete(path)) return;
    fileIo.unlink(path).catch(() => {});
  }
}
