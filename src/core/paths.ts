import * as path from 'path';
import * as vscode from 'vscode';

export const ROOT_DIR = path.join('.vscode', 'ai-runner');

export class WorkspacePaths {
  constructor(readonly folder: vscode.WorkspaceFolder) {}

  get workspaceRoot(): string {
    return this.folder.uri.fsPath;
  }

  get root(): string {
    return path.join(this.workspaceRoot, ROOT_DIR);
  }

  get commandsFile(): string {
    return path.join(this.root, 'commands.json');
  }

  get requestsDir(): string {
    return path.join(this.root, 'requests');
  }

  get logsDir(): string {
    return path.join(this.root, 'logs');
  }

  get indexFile(): string {
    return path.join(this.logsDir, 'index.json');
  }

  /**
   * リクエストIDから結果ファイルのパスを決める。
   * AIはリクエストを書き込んだ時点で結果の出力先を確定できる必要があるため、
   * runId ではなく requestId でパスが決まることが重要。
   */
  metaFileFor(id: string): string {
    return path.join(this.logsDir, `${id}.json`);
  }

  logFileFor(id: string): string {
    return path.join(this.logsDir, `${id}.log`);
  }

  /** ワークスペースルートからの相対パス。ログ内に埋めるパスは常にこの形式にする。 */
  relative(absolutePath: string): string {
    return path.relative(this.workspaceRoot, absolutePath).split(path.sep).join('/');
  }

  /**
   * cwd 指定を絶対パスに解決する。ワークスペース外を指す指定は拒否する。
   * requests/ は外部AIやリポジトリ同梱物が書き込める前提のため、境界チェックが必要。
   */
  resolveCwd(relativeCwd: string | undefined): string {
    if (!relativeCwd) {
      return this.workspaceRoot;
    }
    const resolved = path.resolve(this.workspaceRoot, relativeCwd);
    const rel = path.relative(this.workspaceRoot, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`cwd がワークスペース外を指しています: ${relativeCwd}`);
    }
    return resolved;
  }
}
