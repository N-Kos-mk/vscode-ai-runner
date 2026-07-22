import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * ログを「仮想ドキュメント」として開くためのプロバイダ。
 *
 * ログの実ファイル（.vscode/ai-runner/logs/*.log）を直接開くと、
 * エクスプローラーが logs/ を自動展開し、大量のログファイルで埋まってしまう
 * （explorer.autoReveal の仕様。アクティブなエディタのファイルをツリー上で
 * 選択するために、そこへ至るディレクトリを開く）。
 *
 * 独自スキームの読み取り専用ドキュメントとして中身だけを表示すれば、
 * エクスプローラーには映す対象となる実ファイルが存在しないため、ツリーは動かない。
 * 併せて、表示専用になることで誤ってログを編集・保存する事故も防げる。
 *
 * AIが読むのは従来どおり実ファイルなので、そちらの扱いは変えない。
 * これはあくまで人間向けの表示窓。
 */
export class LogDocumentProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = 'ai-runner-log';

  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const filePath = uri.query;
    if (!filePath) {
      return '(ログファイルが指定されていません)';
    }
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return '(ログファイルが見つかりません。まだ実行されていないか、削除された可能性があります)';
      }
      return `(ログを読み込めません: ${err instanceof Error ? err.message : String(err)})`;
    }
  }

  /**
   * 既に開いている仮想ドキュメントを、最新の実ファイル内容で再読み込みさせる。
   * 同じログを再度開いたとき、VSCodeのキャッシュではなく現在の中身を出すために使う。
   */
  refresh(uri: vscode.Uri): void {
    this._onDidChange.fire(uri);
  }

  /** ログの実ファイルの絶対パスから、表示用の仮想ドキュメントURIを作る。 */
  static uriFor(logAbsPath: string): vscode.Uri {
    return vscode.Uri.from({
      scheme: LogDocumentProvider.scheme,
      // タブに表示される名前。basename にして「run-tests.log」のように見せる。
      path: path.basename(logAbsPath),
      // 実ファイルの場所。provideTextDocumentContent が query から読む。
      query: logAbsPath,
    });
  }
}
