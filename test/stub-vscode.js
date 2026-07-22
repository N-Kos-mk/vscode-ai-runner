'use strict';
/**
 * `vscode` モジュールのスタブ。
 *
 * vscode は VSCode 本体が実行時に注入するモジュールで、npm 上には存在しない。
 * そのため拡張機能のコアロジックは通常 Extension Development Host を立ち上げないと
 * 動かせないが、ここを差し替えることで core/ を素の node で実行できるようにする。
 * 実行エンジン（プロセス起動・停止・ログ書き出し）の検証が目的なので、UI系は
 * 呼ばれても落ちない程度の最小実装にとどめる。
 */

class EventEmitter {
  constructor() {
    this.listeners = [];
  }
  get event() {
    return (listener) => {
      this.listeners.push(listener);
      return { dispose: () => {} };
    };
  }
  fire(value) {
    for (const listener of this.listeners) {
      listener(value);
    }
  }
  dispose() {
    this.listeners = [];
  }
}

const settings = {};

const vscode = {
  EventEmitter,
  ThemeIcon: class {
    constructor(id, color) {
      this.id = id;
      this.color = color;
    }
  },
  ThemeColor: class {
    constructor(id) {
      this.id = id;
    }
  },
  Uri: {
    file: (p) => ({ fsPath: p, scheme: 'file', path: p, query: '' }),
    // 実物は query をURIエンコードするが、テストではロジック検証のため生値を保持する。
    from: (c) => ({ scheme: c.scheme, path: c.path ?? '', query: c.query ?? '', fsPath: c.path ?? '' }),
  },
  workspace: {
    getConfiguration: () => ({
      get: (key, fallback) => (key in settings ? settings[key] : fallback),
    }),
    createFileSystemWatcher: () => ({
      onDidCreate: () => ({ dispose: () => {} }),
      onDidChange: () => ({ dispose: () => {} }),
      onDidDelete: () => ({ dispose: () => {} }),
      dispose: () => {},
    }),
  },
  window: {
    createOutputChannel: () => ({
      append: () => {},
      appendLine: () => {},
      show: () => {},
      dispose: () => {},
    }),
    showWarningMessage: () => Promise.resolve(undefined),
    showInformationMessage: () => Promise.resolve(undefined),
    showErrorMessage: () => Promise.resolve(undefined),
    showTextDocument: () => Promise.resolve(undefined),
    showInputBox: () => Promise.resolve(undefined),
    createWebviewPanel: () => ({
      title: '',
      webview: { html: '', onDidReceiveMessage: () => ({ dispose: () => {} }), postMessage: () => {} },
      onDidDispose: () => ({ dispose: () => {} }),
      reveal: () => {},
      dispose: () => {},
    }),
  },
  ViewColumn: { Active: -1 },
  RelativePattern: class {
    constructor(base, pattern) {
      this.base = base;
      this.pattern = pattern;
    }
  },
  TreeItem: class {
    constructor(label) {
      this.label = label;
    }
  },
  TreeItemCollapsibleState: { None: 0 },
  MarkdownString: class {
    constructor() {
      this.value = '';
    }
    appendMarkdown(v) {
      this.value += v;
      return this;
    }
    appendCodeblock(v) {
      this.value += v;
      return this;
    }
  },
  StatusBarAlignment: { Left: 1 },
};

/** テストから設定値を差し替えるための口。 */
vscode.__setConfig = (key, value) => {
  settings[key] = value;
};

module.exports = vscode;
