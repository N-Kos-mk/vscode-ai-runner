import * as vscode from 'vscode';
import { readIndex } from '../core/logStore';
import { WorkspacePaths } from '../core/paths';
import { statusText } from '../core/runner';
import { LogIndexEntry, RunStatus } from '../core/types';
import { formatAgo } from './trees';

export interface HistoryNode {
  entry: LogIndexEntry;
}

/**
 * 実行履歴のビュー。logs/index.json を可視化する（データはそちらが持つ）。
 *
 * 承認待ちの requests/ が処理後に削除されても、「何を実行し・拒否したか」は
 * ここから追える。個々の項目をクリックすると、その実行のログが仮想ドキュメントとして開く。
 */
export class HistoryTreeProvider implements vscode.TreeDataProvider<HistoryNode> {
  private entries: LogIndexEntry[] = [];
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly paths: WorkspacePaths) {}

  /** index.json を読み直してツリーを更新する。 */
  async load(): Promise<void> {
    const index = await readIndex(this.paths);
    this.entries = index.runs;
    this._onDidChangeTreeData.fire();
  }

  /** データは読み直さず再描画だけする。相対時刻の更新用。 */
  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getChildren(element?: HistoryNode): HistoryNode[] {
    if (element) {
      return [];
    }
    return this.entries.map((entry) => ({ entry }));
  }

  getTreeItem(node: HistoryNode): vscode.TreeItem {
    const e = node.entry;
    const now = Date.now();
    const item = new vscode.TreeItem(e.label, vscode.TreeItemCollapsibleState.None);
    item.description = `${statusText(e.status)} · ${formatAgo(now - Date.parse(e.startedAt))}`;
    item.iconPath = statusIcon(e.status);
    item.tooltip = tooltip(e, now);
    item.contextValue = 'history';
    // クリックでその実行のログ（仮想ドキュメント）を開く。
    item.command = { command: 'aiRunner.openHistoryLog', title: 'ログを開く', arguments: [node] };
    return item;
  }
}

function statusIcon(status: RunStatus): vscode.ThemeIcon {
  switch (status) {
    case 'running':
      return new vscode.ThemeIcon('loading~spin');
    case 'success':
      return new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
    case 'failed':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
    case 'error':
      return new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
    case 'stopped':
      return new vscode.ThemeIcon('debug-stop', new vscode.ThemeColor('charts.gray'));
    case 'rejected':
      return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('charts.gray'));
  }
}

function tooltip(e: LogIndexEntry, now: number): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${e.label}** — ${statusText(e.status)}\n\n`);
  const origin = e.requestId ? `AIリクエスト \`${e.requestId}\`` : `コマンド \`${e.commandId ?? '?'}\``;
  md.appendMarkdown(`${origin}\n\n`);
  md.appendMarkdown(`開始: ${new Date(e.startedAt).toLocaleString()}（${formatAgo(now - Date.parse(e.startedAt))}）\n\n`);
  if (e.endedAt) {
    const durationMs = Date.parse(e.endedAt) - Date.parse(e.startedAt);
    md.appendMarkdown(`所要: ${Math.round(durationMs / 1000)} 秒`);
    if (e.exitCode !== null) {
      md.appendMarkdown(` · 終了コード ${e.exitCode}`);
    }
    md.appendMarkdown('\n\n');
  }
  md.appendMarkdown('クリックでログを開きます');
  return md;
}
