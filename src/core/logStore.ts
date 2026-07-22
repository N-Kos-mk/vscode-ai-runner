import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import { WorkspacePaths } from './paths';
import { LogIndex, LogIndexEntry, RunLog, RunStatus, SCHEMA_VERSION } from './types';

const FLUSH_DEBOUNCE_MS = 250;
const INDEX_LIMIT = 200;

/** ログに取り込む出力の系統。stderr は行頭で識別できるようにする。 */
export type Channel = 'stdout' | 'stderr';

function decorate(line: string, channel: Channel): string {
  return channel === 'stderr' ? `[stderr] ${line}` : line;
}

function config<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration('aiRunner').get<T>(key) ?? fallback;
}

/**
 * 1回の実行に対応するログ書き出し。
 *
 * 生出力は .log に、メタ情報は .json に分離する。要件では単一JSONにstdout全文を
 * 入れる想定だったが、常駐コマンドの出力をJSON文字列に押し込むと肥大化して
 * AI側もパースできなくなるため分離した。JSON側には末尾N行だけ抜粋を持たせ、
 * 「軽い確認はJSON1枚、詳細は.logをgrep」という使い分けができるようにしている。
 */
export class RunLogWriter {
  /** 直近 maxLines 行のみ保持するリングバッファ。ファイルはこれを丸ごと書き戻す。 */
  private readonly lines: string[] = [];
  private readonly maxLines = Math.max(100, config('logs.maxLines', 5000));
  private readonly tailLines = Math.max(1, config('logs.tailLines', 50));
  private flushTimer: NodeJS.Timeout | undefined;
  private flushing: Promise<void> = Promise.resolve();
  private truncated = false;
  /**
   * 改行で終わらなかった直近のチャンク。次のチャンクの先頭と結合する。
   * stdout と stderr は独立して届くため、バッファも分ける。
   */
  private readonly partials: Record<Channel, string> = { stdout: '', stderr: '' };
  private lastOutputAtMs: number | undefined;
  /** ローテーションで破棄した分も数え続ける。lines.length では総量が分からないため。 */
  private outputLines = 0;

  private constructor(
    private readonly paths: WorkspacePaths,
    private readonly meta: RunLog,
  ) {}

  static async create(
    paths: WorkspacePaths,
    base: Omit<RunLog, 'schemaVersion' | 'startedAt' | 'status' | 'exitCode' | 'logFile' | 'tail'>,
  ): Promise<RunLogWriter> {
    await fs.mkdir(paths.logsDir, { recursive: true });
    const meta: RunLog = {
      ...base,
      schemaVersion: SCHEMA_VERSION,
      status: 'running',
      exitCode: null,
      startedAt: new Date().toISOString(),
      logFile: paths.relative(paths.logFileFor(base.runId)),
      tail: [],
    };
    const writer = new RunLogWriter(paths, meta);
    await fs.writeFile(paths.logFileFor(base.runId), '', 'utf8');
    await writer.writeMeta();
    await writer.updateIndex();
    return writer;
  }

  get runId(): string {
    return this.meta.runId;
  }

  get metaPath(): string {
    return this.paths.metaFileFor(this.meta.runId);
  }

  get logPath(): string {
    return this.paths.logFileFor(this.meta.runId);
  }

  /**
   * プロセスの出力を取り込む。チャンク境界は行境界と一致しないため、
   * 改行で終わらなかった末尾は「未完の行」として保持し、次のチャンクと結合する。
   * これをしないと1行のログが複数行に分断されて記録される。
   *
   * `[stderr] ` のような装飾は、チャンクではなく「行が完成した時点」で付ける。
   * チャンク単位で付けると、行の途中で分割されたときに行の中央に紛れ込む。
   */
  append(chunk: string, channel: Channel = 'stdout'): void {
    const parts = (this.partials[channel] + chunk).split(/\r?\n/);
    this.partials[channel] = parts.pop() ?? '';
    this.lines.push(...parts.map((line) => decorate(line, channel)));
    this.outputLines += parts.length;
    // 「動きがあるか」の判断材料。拡張機能自身の注記ではなく、
    // プロセスからの出力が届いたときだけ更新する。
    this.lastOutputAtMs = Date.now();
    this.trim();
  }

  /** 拡張機能自身が出す注記。プロセスの出力とは独立した1行として記録する。 */
  appendLine(text: string): void {
    this.lines.push(text);
    this.trim();
  }

  /** プロセスから最後に出力が届いた時刻。一度も無ければ undefined。 */
  get lastOutputAt(): number | undefined {
    return this.lastOutputAtMs;
  }

  /** プロセスが出力した総行数。ローテーションで破棄した分も含む。 */
  get outputLineCount(): number {
    return this.outputLines;
  }

  /** 直近N行。実行中の様子をUIに出すために使う。 */
  recent(count: number): string[] {
    return this.snapshot().slice(-count);
  }

  private trim(): void {
    if (this.lines.length > this.maxLines) {
      this.lines.splice(0, this.lines.length - this.maxLines);
      this.truncated = true;
    }
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush();
    }, FLUSH_DEBOUNCE_MS);
  }

  /**
   * 確定した行に、未完の行（改行待ち）を加えたもの。
   * 未完の行もログには出す。改行が来るまで進捗が見えないのは不便なため。
   */
  private snapshot(): string[] {
    const pending = (Object.keys(this.partials) as Channel[])
      .filter((channel) => this.partials[channel] !== '')
      .map((channel) => decorate(this.partials[channel], channel));
    return pending.length === 0 ? this.lines : [...this.lines, ...pending];
  }

  /** 書き込みは直列化する。デバウンスflushと finalize が競合するため。 */
  flush(): Promise<void> {
    // 呼び出し時点の内容で固定する。ファイル書き込みの完了を待つ間に
    // 新しい出力が届いても、この回の書き込み内容は変わらないようにするため。
    const body = this.snapshot().join('\n');
    const header = this.truncated
      ? `[ai-runner] 上限 ${this.maxLines} 行を超えたため、これ以前の出力は破棄されています\n`
      : '';
    this.flushing = this.flushing.then(() => fs.writeFile(this.logPath, header + body + '\n', 'utf8'));
    return this.flushing;
  }

  async finalize(status: RunStatus, exitCode: number | null, note?: string): Promise<RunLog> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    await this.flush();
    const endedAt = new Date();
    this.meta.status = status;
    this.meta.exitCode = exitCode;
    this.meta.endedAt = endedAt.toISOString();
    this.meta.durationMs = endedAt.getTime() - new Date(this.meta.startedAt).getTime();
    this.meta.tail = this.snapshot().slice(-this.tailLines);
    if (note) {
      this.meta.note = note;
    }
    await this.writeMeta();
    await this.updateIndex();
    return this.meta;
  }

  private async writeMeta(): Promise<void> {
    await fs.writeFile(this.metaPath, JSON.stringify(this.meta, null, 2) + '\n', 'utf8');
  }

  private async updateIndex(): Promise<void> {
    await updateIndex(this.paths, {
      runId: this.meta.runId,
      requestId: this.meta.requestId,
      commandId: this.meta.commandId,
      label: this.meta.label,
      status: this.meta.status,
      startedAt: this.meta.startedAt,
      endedAt: this.meta.endedAt,
      exitCode: this.meta.exitCode,
      logFile: this.meta.logFile,
      metaFile: this.paths.relative(this.metaPath),
    });
  }
}

/** index.json の更新。複数実行が同時に終わると壊れるため、プロセス内で直列化する。 */
let indexQueue: Promise<void> = Promise.resolve();

export function updateIndex(paths: WorkspacePaths, entry: LogIndexEntry): Promise<void> {
  indexQueue = indexQueue.then(async () => {
    const index = await readIndex(paths);
    const runs = index.runs.filter((r) => r.runId !== entry.runId);
    runs.unshift(entry);
    const next: LogIndex = {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      runs: runs.slice(0, INDEX_LIMIT),
    };
    await fs.mkdir(paths.logsDir, { recursive: true });
    await fs.writeFile(paths.indexFile, JSON.stringify(next, null, 2) + '\n', 'utf8');
  });
  return indexQueue;
}

export async function readIndex(paths: WorkspacePaths): Promise<LogIndex> {
  try {
    const raw = await fs.readFile(paths.indexFile, 'utf8');
    const parsed = JSON.parse(raw) as LogIndex;
    return Array.isArray(parsed.runs) ? parsed : emptyIndex();
  } catch {
    return emptyIndex();
  }
}

function emptyIndex(): LogIndex {
  return { schemaVersion: SCHEMA_VERSION, updatedAt: new Date().toISOString(), runs: [] };
}

/**
 * 実行せずに結果だけを記録する。ユーザーがリクエストを拒否したケース用。
 * これを書かないとAI側が結果ファイルを永久に待つことになる。
 */
export async function writeTerminalLog(
  paths: WorkspacePaths,
  base: Omit<RunLog, 'schemaVersion' | 'startedAt' | 'status' | 'exitCode' | 'logFile' | 'tail'>,
  status: RunStatus,
  note: string,
): Promise<void> {
  const writer = await RunLogWriter.create(paths, base);
  writer.appendLine(`[ai-runner] ${note}`);
  await writer.finalize(status, null, note);
}
