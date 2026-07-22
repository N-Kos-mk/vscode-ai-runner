import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * 現在のブランチ名を追跡する。`branches` 指定のあるコマンドの表示制御に使う。
 *
 * git拡張のAPIではなく .git/HEAD を直接読む。理由は、git拡張の有効化を待つ必要がなく、
 * 依存も増えないため。ブランチ切り替えは HEAD の書き換えとして必ず現れる。
 */
export class GitBranchTracker implements vscode.Disposable {
  private branch: string | undefined;
  private readonly watcher: vscode.FileSystemWatcher;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly workspaceRoot: string, folder: vscode.WorkspaceFolder) {
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '.git/HEAD'));
    const reload = () => void this.load();
    this.watcher.onDidCreate(reload);
    this.watcher.onDidChange(reload);
    this.watcher.onDidDelete(reload);
  }

  get current(): string | undefined {
    return this.branch;
  }

  async load(): Promise<void> {
    const previous = this.branch;
    try {
      const head = await fs.readFile(path.join(this.workspaceRoot, '.git', 'HEAD'), 'utf8');
      const match = head.trim().match(/^ref:\s*refs\/heads\/(.+)$/);
      // detached HEAD の場合はブランチ名を持たない
      this.branch = match ? match[1] : undefined;
    } catch {
      this.branch = undefined;
    }
    if (previous !== this.branch) {
      this._onDidChange.fire();
    }
  }

  /** branches 未指定なら常に表示。gitリポジトリでない場合も制限しない。 */
  matches(branches: string[] | undefined): boolean {
    if (!branches || branches.length === 0) {
      return true;
    }
    if (!this.branch) {
      return true;
    }
    return branches.some((pattern) => globMatch(pattern, this.branch!));
  }

  dispose(): void {
    this.watcher.dispose();
    this._onDidChange.dispose();
  }
}

/** `feature/*` のような単純なワイルドカードのみ対応する。 */
function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(value);
}
