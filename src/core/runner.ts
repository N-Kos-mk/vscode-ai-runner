import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { RunLogWriter } from './logStore';
import { WorkspacePaths } from './paths';
import { CommandSpec, RunLog, RunStatus } from './types';

/** SIGTERM を送ってから SIGKILL に切り替えるまでの既定の猶予。 */
const DEFAULT_GRACE_MS = 5000;

export interface ActiveRun {
  runId: string;
  /** commands.json の id もしくは requestId。UIの状態表示はこのキーで引く。 */
  key: string;
  label: string;
  child?: ChildProcess;
  writer: RunLogWriter;
  /** 経過時間の表示に使う。 */
  startedAtMs: number;
  /** ユーザーによる停止と、プロセスの異常終了を区別するためのフラグ。 */
  stopping: boolean;
  /** 後始末（プロセス終了とログ確定）まで完了したら解決する。VSCode終了時に待つために使う。 */
  settled: Promise<void>;
}

export interface RunOptions {
  paths: WorkspacePaths;
  spec: CommandSpec;
  source: 'request' | 'command';
  /** sequence の step 解決。id にマッチする定義があれば、その command 文字列を返す。 */
  resolveStep?: (idOrCommand: string) => string;
}

export class Runner implements vscode.Disposable {
  private readonly active = new Map<string, ActiveRun>();
  private readonly output = vscode.window.createOutputChannel('AI Command Runner');
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  isRunning(key: string): boolean {
    return this.active.has(key);
  }

  getActive(key: string): ActiveRun | undefined {
    return this.active.get(key);
  }

  get runningCount(): number {
    return this.active.size;
  }

  showOutput(): void {
    this.output.show(true);
  }

  async run(options: RunOptions): Promise<RunLog | undefined> {
    const { paths, spec, source } = options;
    const key = spec.id;
    if (this.active.has(key)) {
      vscode.window.showWarningMessage(`「${spec.label}」は既に実行中です。`);
      return undefined;
    }

    // requests は AI が結果パスを事前に確定できることが必要なので runId = requestId。
    // commands.json 由来は履歴を残したいので timestamp を付ける（AIは index.json から辿る）。
    const runId = source === 'request' ? spec.id : `${spec.id}_${timestamp()}`;

    // 検証より先にログを作る。cwd不正のような「実行に至らなかった失敗」であっても
    // 結果ファイルは必ず残さなければならない。無ければAIが結果を永久に待つことになる。
    const writer = await RunLogWriter.create(paths, {
      runId,
      source,
      requestId: source === 'request' ? spec.id : undefined,
      commandId: source === 'command' ? spec.id : undefined,
      label: spec.label,
      kind: spec.kind,
      command: spec.kind === 'sequence' ? (spec.steps ?? []) : (spec.command ?? ''),
      cwd: spec.cwd ?? '.',
    });

    let markSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });
    const run: ActiveRun = {
      runId,
      key,
      label: spec.label,
      writer,
      startedAtMs: Date.now(),
      stopping: false,
      settled,
    };
    this.active.set(key, run);
    this._onDidChange.fire();

    this.output.show(true);
    this.output.appendLine(`\n─── ${spec.label} (${spec.kind}) ───`);

    try {
      const cwd = paths.resolveCwd(spec.cwd);
      const commands = this.resolveCommands(spec, options.resolveStep);
      if (commands.length === 0) {
        throw new Error(`コマンドが定義されていません: ${spec.id}`);
      }
      const result = await this.executeAll(run, commands, cwd, spec);
      const log = await writer.finalize(result.status, result.exitCode, result.note);
      this.output.appendLine(`─── ${spec.label}: ${result.status} (exit ${result.exitCode ?? '-'}) ───`);
      this.notify(paths, log);
      return log;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writer.appendLine(`[ai-runner] ${message}`);
      this.output.appendLine(`[error] ${message}`);
      const log = await writer.finalize('error', null, message);
      this.notify(paths, log);
      return log;
    } finally {
      this.active.delete(key);
      markSettled();
      this._onDidChange.fire();
    }
  }

  /** sequence は先頭から順に実行し、失敗した時点で打ち切る。 */
  private async executeAll(
    run: ActiveRun,
    commands: string[],
    cwd: string,
    spec: CommandSpec,
  ): Promise<{ status: RunStatus; exitCode: number | null; note?: string }> {
    for (let i = 0; i < commands.length; i++) {
      const command = commands[i];
      if (commands.length > 1) {
        run.writer.appendLine(`\n[ai-runner] step ${i + 1}/${commands.length}: ${command}`);
        this.output.appendLine(`[step ${i + 1}/${commands.length}] ${command}`);
      }
      const exitCode = await this.executeOne(run, command, cwd, spec);
      if (run.stopping) {
        return { status: 'stopped', exitCode, note: 'ユーザーが停止しました' };
      }
      if (exitCode !== 0) {
        const note =
          commands.length > 1
            ? `step ${i + 1}/${commands.length} が終了コード ${exitCode} で失敗したため、以降のstepは実行していません`
            : undefined;
        if (note) {
          run.writer.appendLine(`[ai-runner] ${note}`);
        }
        return { status: 'failed', exitCode, note };
      }
    }
    return { status: 'success', exitCode: 0 };
  }

  private executeOne(run: ActiveRun, command: string, cwd: string, spec: CommandSpec): Promise<number | null> {
    return new Promise((resolve, reject) => {
      run.writer.appendLine(`[ai-runner] $ ${command}`);
      const child = spawn(command, {
        cwd,
        shell: true,
        env: { ...process.env, ...spec.env },
        // 自身をプロセスグループのリーダーにする。`npm run dev` のように孫プロセスを
        // 生む常駐コマンドを、グループごと確実に停止できるようにするため。
        detached: process.platform !== 'win32',
      });
      run.child = child;

      const consume = (stream: NodeJS.ReadableStream | null, channel: 'stdout' | 'stderr') => {
        stream?.on('data', (data: Buffer) => {
          const text = data.toString();
          run.writer.append(text, channel);
          this.output.append(text);
        });
      };
      consume(child.stdout, 'stdout');
      consume(child.stderr, 'stderr');

      child.on('error', (err) => {
        run.child = undefined;
        reject(new Error(`プロセスを起動できませんでした: ${err.message}`));
      });
      child.on('close', (code, signal) => {
        run.child = undefined;
        if (signal) {
          run.writer.appendLine(`[ai-runner] シグナル ${signal} で終了しました`);
        }
        resolve(code);
      });
    });
  }

  private resolveCommands(spec: CommandSpec, resolveStep?: (s: string) => string): string[] {
    if (spec.kind === 'sequence') {
      return (spec.steps ?? []).map((step) => (resolveStep ? resolveStep(step) : step));
    }
    return spec.command ? [spec.command] : [];
  }

  /**
   * UIから見えている key を止める。プロセスグループ全体を対象にする。
   * 停止要求を送るだけで、プロセスの終了は待たない（待つ場合は run.settled を使う）。
   */
  stop(key: string, graceMs = DEFAULT_GRACE_MS): void {
    const run = this.active.get(key);
    if (!run) {
      return;
    }
    run.stopping = true;
    const child = run.child;
    if (!child?.pid) {
      return;
    }
    this.output.appendLine(`[ai-runner] 停止要求: ${run.label}`);
    killTree(child, graceMs);
  }

  /**
   * 実行中のすべてのプロセスを停止し、終了とログ確定まで待つ。VSCode終了時に呼ぶ。
   *
   * 待つことが重要で、停止要求を投げただけで拡張ホストが終了すると、
   * SIGTERM が届く前に見捨てられた `npm run dev` が居座り続ける。
   * ただしVSCodeがdeactivateを待つ時間には限りがあるため、budgetMs で頭打ちにする。
   */
  async stopAll(budgetMs = 3000): Promise<void> {
    const runs = [...this.active.values()];
    if (runs.length === 0) {
      return;
    }
    // 猶予は budget の半分。残り時間で SIGKILL とログ確定を済ませる。
    const graceMs = Math.max(200, Math.floor(budgetMs / 2));
    for (const run of runs) {
      this.stop(run.key, graceMs);
    }
    await Promise.race([
      Promise.all(runs.map((run) => run.settled)),
      new Promise((resolve) => setTimeout(resolve, budgetMs)),
    ]);
  }

  private notify(paths: WorkspacePaths, log: RunLog): void {
    if (!vscode.workspace.getConfiguration('aiRunner').get<boolean>('notifyOnComplete', true)) {
      return;
    }
    const open = 'ログを開く';
    // log.logFile はワークスペースルートからの相対パス。Uri.file() には絶対パスが必要。
    const logUri = vscode.Uri.file(path.join(paths.workspaceRoot, log.logFile));
    const show = (fn: typeof vscode.window.showInformationMessage) =>
      fn(`${log.label}: ${statusText(log.status)}`, open).then((picked) => {
        if (picked === open) {
          void vscode.window.showTextDocument(logUri, { preview: true });
        }
      });
    if (log.status === 'failed' || log.status === 'error') {
      void show(vscode.window.showErrorMessage);
    } else if (log.status === 'success') {
      void show(vscode.window.showInformationMessage);
    }
  }

  /**
   * 通常の終了経路では deactivate() の stopAll() が先に走り、ここでは何も残っていない。
   * ここでの停止は、ワークスペースを閉じた等で dispose だけが呼ばれた場合の保険。
   */
  dispose(): void {
    for (const key of [...this.active.keys()]) {
      this.stop(key);
    }
    this.output.dispose();
    this._onDidChange.dispose();
  }
}

/**
 * shell 経由で起動したプロセスは、child が shell 自身で、実際の作業をするのは孫。
 * child.kill() だけでは孫が生き残って `npm run dev` がポートを掴んだままになるため、
 * プロセスグループ（unix）/ プロセスツリー（Windows）ごと終了させる。
 */
function killTree(child: ChildProcess, graceMs: number): void {
  const pid = child.pid;
  if (!pid) {
    return;
  }
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F']);
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    // グループが既に消えている場合など。単体killにフォールバックする。
    try {
      child.kill('SIGTERM');
    } catch {
      /* 既に終了済み */
    }
  }
  // SIGTERM を無視する、または後始末に時間をかけるプロセス向けの保険。
  const timer = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* 既に終了済み */
    }
  }, graceMs);
  child.once('close', () => clearTimeout(timer));
}


function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export function statusText(status: RunStatus): string {
  switch (status) {
    case 'running':
      return '実行中';
    case 'success':
      return '成功';
    case 'failed':
      return '失敗';
    case 'stopped':
      return '停止';
    case 'rejected':
      return '拒否';
    case 'error':
      return 'エラー';
  }
}
