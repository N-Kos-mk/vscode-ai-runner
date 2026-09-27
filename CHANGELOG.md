# 変更履歴

このファイルには、リリースごとの利用者向けの変更点を記録します。
各バージョンの `.vsix` は [Releases](https://github.com/N-Kos-mk/vscode-ai-runner/releases) から入手できます。

## [0.1.1] - 2026-09-27

### 修正

- 実行したコマンドの色付き出力（Vite など）で、出力パネルとログに `[32m` のような制御コードの断片が表示される問題を修正しました。
  - ANSI エスケープシーケンスを取り込み時に除去するため、AI が読む `.log` とメタ JSON の `tail` にも制御コードが残りません。
  - Windows では picocolors などが TTY でなくても色を付けるため、特に発生しやすい問題でした。

### アップデート方法

1. Releases から `ai-runner-0.1.1.vsix` をダウンロードします。
2. `code --install-extension ai-runner-0.1.1.vsix` を実行するか、拡張パネルの「…」→「VSIX からのインストール」で上書きインストールします。
3. VSCode のウィンドウを再読み込みします（コマンドパレット →「Developer: Reload Window」）。

設定・`commands.json`・ログの形式に変更はないため、移行作業は不要です。

## [0.1.0] - 2026-07-22

- 初回リリース。

[0.1.1]: https://github.com/N-Kos-mk/vscode-ai-runner/releases/tag/v0.1.1
[0.1.0]: https://github.com/N-Kos-mk/vscode-ai-runner/releases/tag/v0.1.0
