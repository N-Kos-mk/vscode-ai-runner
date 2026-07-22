import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { WorkspacePaths } from './paths';
import { RequestFile } from './types';
import { parseRequestFile } from './validate';

const RELOAD_DEBOUNCE_MS = 200;

export interface RequestItem {
  /** requests/<requestId>.json の絶対パス。 */
  file: string;
  request?: RequestFile;
  /** 検証に失敗した場合の理由。AIが仕様どおりに書けているか気づけるようUIに出す。 */
  error?: string;
}

/**
 * `.vscode/ai-runner/requests/` の監視。
 *
 * ここに置かれるファイルは外部AI（あるいはリポジトリをcloneした誰か）が書いたもので、
 * 内容は信用できない。このクラスは検知と検証だけを行い、実行は一切しない。
 * 実行の起点は必ずユーザーのクリックであること。
 */
export class RequestStore implements vscode.Disposable {
  private items: RequestItem[] = [];
  private readonly watcher: vscode.FileSystemWatcher;
  private reloadTimer: NodeJS.Timeout | undefined;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly paths: WorkspacePaths) {
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(paths.folder, '.vscode/ai-runner/requests/*.json'),
    );
    const reload = () => this.scheduleReload();
    this.watcher.onDidCreate(reload);
    this.watcher.onDidChange(reload);
    this.watcher.onDidDelete(reload);
  }

  get all(): RequestItem[] {
    return this.items;
  }

  get(requestId: string): RequestItem | undefined {
    return this.items.find((i) => i.request?.requestId === requestId);
  }

  /**
   * AIによる書き込みは非アトミックなことが多く、watcher は書き込み途中にも発火する。
   * 少し待ってからまとめて読み直すことで、途中状態を掴む頻度を下げる。
   * それでも掴んだ場合は error 付きで表示され、書き込み完了時の change で解消される。
   */
  private scheduleReload(): void {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
    }
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = undefined;
      void this.load();
    }, RELOAD_DEBOUNCE_MS);
  }

  async load(): Promise<void> {
    let files: string[];
    try {
      files = (await fs.readdir(this.paths.requestsDir)).filter((f) => f.endsWith('.json'));
    } catch {
      this.items = [];
      this._onDidChange.fire();
      return;
    }

    const items: RequestItem[] = [];
    for (const file of files.sort()) {
      const full = path.join(this.paths.requestsDir, file);
      const baseName = path.basename(file, '.json');
      try {
        const raw = await fs.readFile(full, 'utf8');
        items.push({ file: full, request: parseRequestFile(JSON.parse(raw), baseName) });
      } catch (err) {
        items.push({ file: full, error: err instanceof Error ? err.message : String(err) });
      }
    }
    this.items = items;
    this._onDidChange.fire();
  }

  /** 処理済みリクエストを取り下げる。ログは logs/ 側に残るため情報は失われない。 */
  async consume(file: string): Promise<void> {
    try {
      await fs.unlink(file);
    } catch {
      /* 既に消えている場合は何もしない */
    }
    await this.load();
  }

  dispose(): void {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
    }
    this.watcher.dispose();
    this._onDidChange.dispose();
  }
}
