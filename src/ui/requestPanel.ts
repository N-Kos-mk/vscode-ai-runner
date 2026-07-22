import * as vscode from 'vscode';
import { RequestFile } from '../core/types';

/** Webview → 拡張機能へのメッセージ。 */
export type PanelMessage = { type: 'run' } | { type: 'reject' };

export interface RequestPanelHandlers {
  onRun(requestId: string, file: string): void;
  onReject(requestId: string, file: string): void;
}

/**
 * 承認待ちリクエストの詳細を表示するWebviewパネル。
 *
 * 生の requests/*.json を開く代わりに、人が読みやすい形へ整形して見せ、
 * その場で承認（実行）/拒否のボタンを提供する。
 *
 * セキュリティ上の前提: ここに表示する内容（label, command, description 等）は
 * 外部AIが書いた未検証の文字列である。HTMLへ差し込む際は必ずエスケープし、
 * CSPとnonceでスクリプト実行を自前のもの以外禁止する。さもなければ、AIが書いた
 * コマンド文字列に仕込まれたマークアップがWebview内で実行されうる（XSS）。
 */
export class RequestPanel {
  private panel: vscode.WebviewPanel | undefined;
  private current: { requestId: string; file: string } | undefined;

  constructor(private readonly handlers: RequestPanelHandlers) {}

  show(request: RequestFile, file: string): void {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'aiRunner.requestDetail',
        request.label,
        vscode.ViewColumn.Active,
        // スクリプトは許可するが、読み込めるローカルリソースは無し（全てインライン）。
        { enableScripts: true, localResourceRoots: [] },
      );
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.current = undefined;
      });
      this.panel.webview.onDidReceiveMessage((msg: PanelMessage) => {
        const target = this.current;
        if (!target) {
          return;
        }
        if (msg.type === 'run') {
          this.handlers.onRun(target.requestId, target.file);
        } else if (msg.type === 'reject') {
          this.handlers.onReject(target.requestId, target.file);
        }
      });
    }
    this.current = { requestId: request.requestId, file };
    this.panel.title = request.label;
    this.panel.webview.html = renderRequestHtml(request, makeNonce());
    this.panel.reveal(vscode.ViewColumn.Active);
  }

  /** 表示中のリクエストが処理・削除されたときに、パネルを閉じる。 */
  closeIfShowing(requestId: string): void {
    if (this.current?.requestId === requestId) {
      this.panel?.dispose();
    }
  }

  /** 表示中のリクエストがもう存在しないなら閉じる。requestStore の変更時に呼ぶ。 */
  closeIfStale(exists: (requestId: string) => boolean): void {
    if (this.current && !exists(this.current.requestId)) {
      this.panel?.dispose();
    }
  }

  dispose(): void {
    this.panel?.dispose();
  }
}

const KIND_LABEL: Record<string, string> = {
  oneshot: '単発 (oneshot)',
  daemon: '常駐 (daemon)',
  sequence: '順次実行 (sequence)',
};

/** HTMLに差し込む前に必ず通す。AIが書いた文字列を無害化する。 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * リクエスト詳細のHTMLを生成する。テスト可能なよう副作用のない純粋関数にしてある。
 * 動的な値は escapeHtml を通したものだけを埋め込むこと。
 */
export function renderRequestHtml(request: RequestFile, nonce: string): string {
  const commandText =
    request.kind === 'sequence' ? (request.steps ?? []).join('\n') : (request.command ?? '');
  const kindLabel = KIND_LABEL[request.kind] ?? escapeHtml(request.kind);

  const descriptionBlock = request.description
    ? `<p class="desc">${escapeHtml(request.description)}</p>`
    : '';

  const destructiveNote = request.confirm
    ? `<p class="warn">このリクエストは破壊的な操作として指定されています。内容を十分に確認してください。</p>`
    : '';

  // CSP: 既定で全て禁止し、インラインスタイルと nonce 付きスクリプトのみ許可する。
  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    padding: 1.2rem 1.4rem;
    line-height: 1.6;
  }
  h1 { font-size: 1.3rem; margin: 0 0 0.2rem; }
  .origin { color: var(--vscode-descriptionForeground); font-size: 0.85rem; margin: 0 0 1rem; }
  .desc { margin: 0 0 1rem; }
  .warn {
    background: var(--vscode-inputValidation-warningBackground);
    border: 1px solid var(--vscode-inputValidation-warningBorder);
    color: var(--vscode-foreground);
    padding: 0.5rem 0.7rem;
    border-radius: 4px;
    margin: 0 0 1rem;
  }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.3rem 1rem; margin: 0 0 1rem; }
  dt { color: var(--vscode-descriptionForeground); }
  dd { margin: 0; }
  h2 { font-size: 0.95rem; margin: 1.2rem 0 0.4rem; color: var(--vscode-descriptionForeground); }
  pre {
    background: var(--vscode-textCodeBlock-background);
    padding: 0.7rem 0.9rem;
    border-radius: 4px;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-all;
    margin: 0;
  }
  .actions { display: flex; gap: 0.6rem; margin-top: 1.6rem; }
  button {
    font-family: inherit;
    font-size: inherit;
    padding: 0.45rem 1.1rem;
    border: 1px solid transparent;
    border-radius: 3px;
    cursor: pointer;
  }
  .primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .primary:hover { background: var(--vscode-button-hoverBackground); }
  /* 拒否は取り消しのきかない操作なので、警告色（赤）で明示する。 */
  .danger {
    background: transparent;
    color: var(--vscode-errorForeground);
    border-color: var(--vscode-errorForeground);
  }
  .danger:hover {
    background: var(--vscode-errorForeground);
    color: var(--vscode-editor-background);
  }
</style>
</head>
<body>
  <h1>${escapeHtml(request.label)}</h1>
  <p class="origin">AIからの実行リクエスト（${escapeHtml(request.requestId)}）</p>
  ${descriptionBlock}
  ${destructiveNote}
  <dl>
    <dt>種別</dt><dd>${kindLabel}</dd>
    <dt>作業ディレクトリ</dt><dd><code>${escapeHtml(request.cwd ?? '.')}</code></dd>
  </dl>
  <h2>実行されるコマンド</h2>
  <pre>${escapeHtml(commandText)}</pre>
  <div class="actions">
    <button id="run" class="primary">実行を承認</button>
    <button id="reject" class="danger">拒否</button>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('run').addEventListener('click', () => vscode.postMessage({ type: 'run' }));
    document.getElementById('reject').addEventListener('click', () => vscode.postMessage({ type: 'reject' }));
  </script>
</body>
</html>`;
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
