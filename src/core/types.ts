/**
 * `.vscode/ai-runner/` 配下のファイル仕様。
 * ここの型定義は README のAI向け仕様と1対1で対応する。片方だけ変更しないこと。
 */

export const SCHEMA_VERSION = 1;

export type CommandKind = 'oneshot' | 'daemon' | 'sequence';

/** 実行対象1件の定義。commands.json の項目と requests/*.json の中身で共通。 */
export interface CommandSpec {
  id: string;
  label: string;
  kind: CommandKind;
  /** kind が oneshot | daemon のとき必須。shell 経由で実行される。 */
  command?: string;
  /** kind が sequence のとき必須。commands.json 内の他コマンドの id、または生のコマンド文字列。 */
  steps?: string[];
  /** ワークスペースルートからの相対パス。省略時はルート。 */
  cwd?: string;
  env?: Record<string, string>;
  /** 人間向けの補足。AIがリクエストで「なぜ実行してほしいか」を書く欄でもある。 */
  description?: string;
  pinned?: boolean;
  /** true なら実行前に確認ダイアログを出す（破壊的コマンド用）。 */
  confirm?: boolean;
  /** 指定したGitブランチにいるときだけUIに表示する。 */
  branches?: string[];
}

export interface CommandsFile {
  schemaVersion?: number;
  commands: CommandSpec[];
}

/** requests/<requestId>.json の中身。CommandSpec の id を requestId として扱う。 */
export interface RequestFile extends Omit<CommandSpec, 'id' | 'pinned'> {
  requestId: string;
  createdAt?: string;
}

export type RunStatus =
  /** 実行中。daemon は停止するまでこのまま。 */
  | 'running'
  /** 終了コード0で完了。 */
  | 'success'
  /** 終了コードが非0。 */
  | 'failed'
  /** ユーザーが停止ボタンを押した。 */
  | 'stopped'
  /** ユーザーがリクエストを拒否した。AIを無限に待たせないため必ずログに残す。 */
  | 'rejected'
  /** プロセスを起動できなかった等、実行以前の失敗。 */
  | 'error';

/** logs/<id>.json の中身。外部AIが読む唯一の正式な出力。 */
export interface RunLog {
  schemaVersion: number;
  runId: string;
  /** 'request' = AIリクエスト由来 / 'command' = commands.json 由来 */
  source: 'request' | 'command';
  /** source === 'request' のとき、対応する requestId。 */
  requestId?: string;
  /** source === 'command' のとき、対応する commands.json の id。 */
  commandId?: string;
  label: string;
  kind: CommandKind;
  /** 実際に実行されたコマンド。sequence の場合は steps の解決結果。 */
  command: string | string[];
  cwd: string;
  status: RunStatus;
  exitCode: number | null;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  /** ワークスペースルートからの相対パス。全出力はこちらにある。 */
  logFile: string;
  /** 末尾N行。AIがこのJSON1枚だけで概況を掴めるようにするための抜粋。 */
  tail: string[];
  /** ユーザーが拒否した場合の理由など。 */
  note?: string;
}

/** index.json: AIが最新の実行を素早く見つけるための一覧。新しい順。 */
export interface LogIndex {
  schemaVersion: number;
  updatedAt: string;
  runs: LogIndexEntry[];
}

export interface LogIndexEntry {
  runId: string;
  requestId?: string;
  commandId?: string;
  label: string;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  exitCode: number | null;
  logFile: string;
  metaFile: string;
}
