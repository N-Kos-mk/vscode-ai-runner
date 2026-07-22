import * as vscode from 'vscode';
import { Runner } from '../core/runner';

/** 常駐コマンドが動いていることを常時可視化する。停止し忘れに気づけるようにするのが目的。 */
export class RunnerStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);

  constructor(private readonly runner: Runner) {
    this.item.command = 'aiRunner.showOutput';
    this.update();
  }

  update(): void {
    const count = this.runner.runningCount;
    if (count === 0) {
      this.item.hide();
      return;
    }
    this.item.text = `$(loading~spin) AI Runner: ${count}`;
    this.item.tooltip = `${count} 件のコマンドを実行中`;
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
