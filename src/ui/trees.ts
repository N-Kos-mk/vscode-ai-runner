import * as vscode from 'vscode';
import { CommandStore } from '../core/commandStore';
import { GitBranchTracker } from '../core/gitBranch';
import { RequestStore } from '../core/requestStore';
import { ActiveRun, Runner } from '../core/runner';
import { CommandSpec, RequestFile } from '../core/types';

export type Node = CommandNode | RequestNode | MessageNode;

export interface CommandNode {
  type: 'command';
  spec: CommandSpec;
}

export interface RequestNode {
  type: 'request';
  request?: RequestFile;
  file: string;
  error?: string;
}

export interface MessageNode {
  type: 'message';
  text: string;
  detail?: string;
  isError: boolean;
}

/** 実行されるコマンド全文。UIで隠さないこと（任意コード実行の同意判断に必要なため）。 */
function commandText(spec: { kind: string; command?: string; steps?: string[] }): string {
  return spec.kind === 'sequence' ? (spec.steps ?? []).join(' && ') : (spec.command ?? '');
}

function kindIcon(kind: string, running: boolean): vscode.ThemeIcon {
  if (running) {
    return new vscode.ThemeIcon('loading~spin');
  }
  switch (kind) {
    case 'daemon':
      return new vscode.ThemeIcon('server-process');
    case 'sequence':
      return new vscode.ThemeIcon('list-ordered');
    default:
      return new vscode.ThemeIcon('terminal');
  }
}

/** `2:31` / `1:02:31`。実行が継続していること自体を示すため、秒まで出す。 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = String(total % 60).padStart(2, '0');
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

export function formatAgo(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) {
    return `${seconds}秒前`;
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}分前`;
  }
  return `${Math.floor(seconds / 3600)}時間前`;
}

/**
 * 実行中の項目に出す一行。スピナーだけでは「生きているのか固まっているのか」が
 * 分からないため、経過時間（実行が続いていること）と最終出力からの経過（動きがあるか）を示す。
 *
 * なお常駐コマンドは正常でも無出力が続くので、無出力は異常の証拠ではない。
 * あくまで判断材料として出す。
 */
export function runningDescription(run: ActiveRun, now: number): string {
  const elapsed = formatDuration(now - run.startedAtMs);
  const lastOutputAt = run.writer.lastOutputAt;
  const activity = lastOutputAt === undefined ? '出力なし' : `最終出力 ${formatAgo(now - lastOutputAt)}`;
  return `実行中 ${elapsed} · ${activity}`;
}

function runningTooltip(run: ActiveRun, now: number, command: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${run.label}** — 実行中\n\n`);
  md.appendMarkdown(`経過: ${formatDuration(now - run.startedAtMs)}\n\n`);
  const lastOutputAt = run.writer.lastOutputAt;
  md.appendMarkdown(
    lastOutputAt === undefined
      ? 'まだ出力がありません\n\n'
      : `最終出力: ${formatAgo(now - lastOutputAt)}（計 ${run.writer.outputLineCount} 行）\n\n`,
  );
  const recent = run.writer.recent(5).filter((line) => line !== '');
  if (recent.length > 0) {
    md.appendMarkdown('直近の出力:\n\n');
    md.appendCodeblock(recent.join('\n'), 'log');
  }
  md.appendMarkdown('\n');
  md.appendCodeblock(command, 'shell');
  md.appendMarkdown('\nクリックで実行中のログを開きます');
  return md;
}

function tooltip(
  spec: { label: string; kind: string; command?: string; steps?: string[]; cwd?: string; description?: string },
  hint: string,
): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${spec.label}**\n\n`);
  if (spec.description) {
    md.appendMarkdown(`${spec.description}\n\n`);
  }
  if (spec.kind === 'sequence') {
    md.appendMarkdown('順に実行されます:\n\n');
    md.appendCodeblock((spec.steps ?? []).join('\n'), 'shell');
  } else {
    md.appendCodeblock(spec.command ?? '', 'shell');
  }
  md.appendMarkdown(`\n作業ディレクトリ: \`${spec.cwd ?? '.'}\`\n\n`);
  md.appendMarkdown(hint);
  return md;
}

export class CommandTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly store: CommandStore,
    private readonly runner: Runner,
    private readonly git: GitBranchTracker,
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getChildren(element?: Node): Node[] {
    if (element) {
      return [];
    }
    if (this.store.error) {
      return [
        {
          type: 'message',
          text: 'commands.json を読み込めません',
          detail: this.store.error,
          isError: true,
        },
      ];
    }
    const visible = this.store.all.filter((spec) => this.git.matches(spec.branches));
    // ピン留めを常に上部に固定する。同一グループ内は定義順を保つ（ユーザーが並べた順に意味があるため）。
    const pinned = visible.filter((s) => this.store.isPinned(s));
    const rest = visible.filter((s) => !this.store.isPinned(s));
    return [...pinned, ...rest].map((spec) => ({ type: 'command', spec }));
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.type === 'message') {
      return messageItem(node);
    }
    const spec = (node as CommandNode).spec;
    const active = this.runner.getActive(spec.id);
    const isPinned = this.store.isPinned(spec);
    const now = Date.now();

    const item = new vscode.TreeItem(spec.label, vscode.TreeItemCollapsibleState.None);
    item.description = active ? runningDescription(active, now) : commandText(spec);
    item.tooltip = active
      ? runningTooltip(active, now, commandText(spec))
      : tooltip(spec, 'クリックで最後の実行ログを開きます。実行は▶ボタンから。');
    item.iconPath = isPinned && !active ? new vscode.ThemeIcon('pinned') : kindIcon(spec.kind, !!active);
    item.contextValue = `command.${isPinned ? 'pinned' : 'unpinned'}.${active ? 'running' : 'idle'}`;
    // クリックはログ表示に割り当てる。実行は▶ボタンに限定することで、
    // 一覧を眺めているだけのつもりが誤って実行される事故を防ぐ。
    item.command = { command: 'aiRunner.openLog', title: 'ログを開く', arguments: [node] };
    return item;
  }
}

export class RequestTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly store: RequestStore,
    private readonly runner: Runner,
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getChildren(element?: Node): Node[] {
    if (element) {
      return [];
    }
    return this.store.all.map((item) => ({
      type: 'request',
      request: item.request,
      file: item.file,
      error: item.error,
    }));
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.type === 'message') {
      return messageItem(node);
    }
    const req = node as RequestNode;
    if (!req.request) {
      const item = new vscode.TreeItem(basename(req.file), vscode.TreeItemCollapsibleState.None);
      item.description = '仕様に適合していません';
      item.tooltip = new vscode.MarkdownString(`**このリクエストは実行できません**\n\n${req.error ?? ''}`);
      item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
      item.contextValue = 'request.invalid';
      item.command = { command: 'vscode.open', title: '開く', arguments: [vscode.Uri.file(req.file)] };
      return item;
    }

    const spec = req.request;
    const label = spec.label ?? spec.requestId;
    const active = this.runner.getActive(spec.requestId);
    const now = Date.now();

    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.description = active ? runningDescription(active, now) : commandText(spec);
    item.tooltip = active
      ? runningTooltip(active, now, commandText(spec))
      : tooltip({ ...spec, label }, 'クリックでリクエスト本文を開きます。実行は▶ボタンから。');
    item.iconPath = active
      ? new vscode.ThemeIcon('loading~spin')
      : new vscode.ThemeIcon('question', new vscode.ThemeColor('charts.yellow'));
    item.contextValue = `request.${active ? 'running' : 'idle'}`;
    // 承認前はリクエスト本文を開いて中身を確認できることを優先する。
    // 実行中はログの方が知りたい情報になる。
    item.command = active
      ? { command: 'aiRunner.openLog', title: 'ログを開く', arguments: [node] }
      : { command: 'vscode.open', title: '内容を確認', arguments: [vscode.Uri.file(req.file)] };
    return item;
  }
}

function messageItem(node: MessageNode): vscode.TreeItem {
  const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
  item.description = node.detail;
  item.tooltip = node.detail;
  item.iconPath = new vscode.ThemeIcon(
    node.isError ? 'error' : 'info',
    node.isError ? new vscode.ThemeColor('problemsErrorIcon.foreground') : undefined,
  );
  item.contextValue = 'message';
  return item;
}

function basename(file: string): string {
  return file.split(/[\\/]/).pop() ?? file;
}
