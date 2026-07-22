import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import { WorkspacePaths } from './paths';
import { CommandSpec } from './types';
import { parseCommandsFile } from './validate';

const PIN_STATE_KEY = 'aiRunner.pinned';

/** commands.json の読み込みと監視。ピン留め状態の管理も担う。 */
export class CommandStore implements vscode.Disposable {
  private specs: CommandSpec[] = [];
  private loadError: string | undefined;
  private readonly watcher: vscode.FileSystemWatcher;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(
    private readonly paths: WorkspacePaths,
    private readonly memento: vscode.Memento,
  ) {
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(paths.folder, '.vscode/ai-runner/commands.json'),
    );
    const reload = () => void this.load();
    this.watcher.onDidCreate(reload);
    this.watcher.onDidChange(reload);
    this.watcher.onDidDelete(reload);
  }

  get all(): CommandSpec[] {
    return this.specs;
  }

  get error(): string | undefined {
    return this.loadError;
  }

  get(id: string): CommandSpec | undefined {
    return this.specs.find((s) => s.id === id);
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.paths.commandsFile, 'utf8');
      this.specs = parseCommandsFile(JSON.parse(raw));
      this.loadError = undefined;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.specs = [];
        this.loadError = undefined;
      } else {
        // 定義が壊れていても拡張は動き続け、UIにエラーを出して直せるようにする
        this.specs = [];
        this.loadError = err instanceof Error ? err.message : String(err);
      }
    }
    this._onDidChange.fire();
  }

  /**
   * sequence の step 解決。commands.json 内の id にマッチすればその定義の
   * command に、しなければ生のコマンド文字列として扱う。
   */
  resolveStep = (idOrCommand: string): string => {
    const found = this.get(idOrCommand);
    if (!found) {
      return idOrCommand;
    }
    if (found.kind === 'sequence') {
      throw new Error(`sequence を step から参照することはできません: ${idOrCommand}`);
    }
    if (found.kind === 'daemon') {
      throw new Error(`終了しない daemon を step に含めることはできません: ${idOrCommand}`);
    }
    return found.command ?? idOrCommand;
  };

  /**
   * ピン留めは commands.json ではなく workspaceState に保存する。
   * commands.json はGitで共有されうるため、個人の並び順の好みを書き戻すと
   * チームに無関係な差分が出てしまう。ファイル側の `pinned` は初期値として扱う。
   */
  isPinned(spec: CommandSpec): boolean {
    const overrides = this.memento.get<Record<string, boolean>>(PIN_STATE_KEY, {});
    return overrides[spec.id] ?? spec.pinned ?? false;
  }

  async setPinned(id: string, pinned: boolean): Promise<void> {
    const overrides = { ...this.memento.get<Record<string, boolean>>(PIN_STATE_KEY, {}) };
    overrides[id] = pinned;
    await this.memento.update(PIN_STATE_KEY, overrides);
    this._onDidChange.fire();
  }

  dispose(): void {
    this.watcher.dispose();
    this._onDidChange.dispose();
  }
}
