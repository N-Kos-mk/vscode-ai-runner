import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { CommandStore } from './core/commandStore';
import { GitBranchTracker } from './core/gitBranch';
import { WorkspacePaths } from './core/paths';
import { RequestStore } from './core/requestStore';
import { Runner } from './core/runner';
import { readIndex, writeTerminalLog } from './core/logStore';
import { CommandSpec, RequestFile } from './core/types';
import { AI_SPEC_MD, GITIGNORE, SAMPLE_COMMANDS_JSON } from './templates';
import { HistoryNode, HistoryTreeProvider } from './ui/historyTree';
import { LogDocumentProvider } from './ui/logDocument';
import { RequestPanel } from './ui/requestPanel';
import { RunnerStatusBar } from './ui/statusBar';
import { CommandTreeProvider, Node, RequestTreeProvider } from './ui/trees';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return;
  }

  const paths = new WorkspacePaths(folder);
  const runner = new Runner();
  activeRunner = runner;
  const commandStore = new CommandStore(paths, context.workspaceState);
  const requestStore = new RequestStore(paths);
  const git = new GitBranchTracker(paths.workspaceRoot, folder);
  const statusBar = new RunnerStatusBar(runner);

  const commandTree = new CommandTreeProvider(commandStore, runner, git);
  const requestTree = new RequestTreeProvider(requestStore, runner);
  const historyTree = new HistoryTreeProvider(paths);
  const logProvider = new LogDocumentProvider();
  // パネルのボタンから既存の実行/拒否ロジックを呼ぶ。requestStore から最新の
  // リクエスト内容を引き直すのは、パネル表示中にファイルが書き換わる可能性があるため。
  const requestPanel = new RequestPanel({
    onRun: (requestId, file) => {
      const req = requestStore.get(requestId)?.request;
      if (req) {
        void runRequest(req, file, { viaPanel: true });
      }
    },
    onReject: (requestId, file) => {
      const req = requestStore.get(requestId)?.request;
      if (req) {
        void rejectByRequest(req, file);
      }
    },
  });

  // logs/index.json の変更を監視する。同一プロセスの実行は runner.onDidChange で
  // 拾えるが、別ウィンドウやAIによる外部変更にも追従できるようファイルも見る。
  const indexWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(folder, '.vscode/ai-runner/logs/index.json'),
  );
  indexWatcher.onDidCreate(() => void historyTree.load());
  indexWatcher.onDidChange(() => void historyTree.load());
  indexWatcher.onDidDelete(() => void historyTree.load());

  context.subscriptions.push(
    runner,
    commandStore,
    requestStore,
    git,
    statusBar,
    indexWatcher,
    requestPanel,
    vscode.workspace.registerTextDocumentContentProvider(LogDocumentProvider.scheme, logProvider),
  );

  // バッジを更新するためツリービューは参照を保持する。アクティビティバーのアイコンには
  // 各ビューのバッジの合計が1つ表示され、内訳は各ビューのタイトル横に出る（VSCodeの仕様）。
  const requestsView = vscode.window.createTreeView('aiRunner.requests', { treeDataProvider: requestTree });
  const commandsView = vscode.window.createTreeView('aiRunner.commands', { treeDataProvider: commandTree });
  const historyView = vscode.window.createTreeView('aiRunner.history', { treeDataProvider: historyTree });
  context.subscriptions.push(requestsView, commandsView, historyView);

  const refreshAll = () => {
    commandTree.refresh();
    requestTree.refresh();
    statusBar.update();
    // 実行の開始・終了で index.json が更新されるため、履歴も読み直す。
    void historyTree.load();
    // 承認・拒否されたリクエストは requests/ から消える。表示中のパネルを閉じる。
    requestPanel.closeIfStale((id) => requestStore.get(id) !== undefined);
    updateBadges();
    syncTicker();
  };

  function updateBadges(): void {
    // 実行可能な承認待ち（検証を通ったもの）のみ数える。壊れたリクエストは実行要求ではない。
    const pending = requestStore.all.filter((item) => item.request).length;
    requestsView.badge = badgeFor(pending, `件の承認待ちリクエスト`);
    historyView.badge = badgeFor(runner.runningCount, `件を実行中`);
  }

  /**
   * 実行中は経過時間・最終出力からの経過を毎秒更新する。これがないと表示が
   * 固まり、「動いているのか止まっているのか分からない」状態自体は変わらない。
   * 実行中が無ければタイマーを止め、常時稼働させない。
   */
  let ticker: NodeJS.Timeout | undefined;
  function syncTicker(): void {
    const needed = runner.runningCount > 0;
    if (needed && !ticker) {
      ticker = setInterval(() => {
        commandTree.refresh();
        requestTree.refresh();
        // 実行中の項目の相対時刻を更新する。データは読み直さず再描画のみ。
        historyTree.refresh();
      }, 1000);
    } else if (!needed && ticker) {
      clearInterval(ticker);
      ticker = undefined;
    }
  }
  context.subscriptions.push({
    dispose: () => {
      if (ticker) {
        clearInterval(ticker);
      }
    },
  });
  context.subscriptions.push(
    runner.onDidChange(refreshAll),
    commandStore.onDidChange(refreshAll),
    requestStore.onDidChange(refreshAll),
    git.onDidChange(refreshAll),
  );

  const register = (id: string, handler: (...args: never[]) => unknown) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: never[]) => {
        try {
          await handler(...args);
        } catch (err) {
          vscode.window.showErrorMessage(`AI Runner: ${err instanceof Error ? err.message : String(err)}`);
        }
      }),
    );

  register('aiRunner.run', (node: Node) => runNode(node));
  register('aiRunner.stop', (node: Node) => runner.stop(keyOf(node)));
  register('aiRunner.reject', (node: Node) => rejectRequest(node));
  register('aiRunner.openLog', (node: Node) => openLog(node));
  register('aiRunner.openHistoryLog', (node: HistoryNode) => openHistoryLog(node));
  register('aiRunner.showRequest', (node: Node) => {
    if (node.type === 'request' && node.request) {
      requestPanel.show(node.request, node.file);
    }
  });
  register('aiRunner.showOutput', () => runner.showOutput());
  register('aiRunner.pin', (node: Node) => commandStore.setPinned(keyOf(node), true));
  register('aiRunner.unpin', (node: Node) => commandStore.setPinned(keyOf(node), false));
  register('aiRunner.refresh', async () => {
    await Promise.all([commandStore.load(), requestStore.load(), git.load(), historyTree.load()]);
  });
  register('aiRunner.refreshHistory', () => historyTree.load());
  register('aiRunner.editCommands', () => openCommandsFile());
  register('aiRunner.initWorkspace', () => initWorkspace());
  register('aiRunner.openReadme', () => openReadme());

  await Promise.all([commandStore.load(), requestStore.load(), git.load(), historyTree.load()]);

  // ── 以下、上のコマンド登録から呼ばれる実装 ──

  async function runNode(node: Node): Promise<void> {
    if (node.type === 'command') {
      await runSpec(node.spec, 'command');
      return;
    }
    if (node.type === 'request' && node.request) {
      await runRequest(node.request, node.file);
    }
  }

  async function runSpec(spec: CommandSpec, source: 'request' | 'command'): Promise<boolean> {
    if (spec.confirm && !(await confirmDestructive(spec))) {
      return false;
    }
    await runner.run({ paths, spec, source, resolveStep: commandStore.resolveStep });
    return true;
  }

  /**
   * リクエストの実行。ユーザーのクリックが唯一の起点であり、自動実行の経路は存在しない。
   * requests/ には外部AIだけでなく、リポジトリをcloneした第三者もファイルを置けるため。
   */
  async function runRequest(
    request: RequestFile,
    file: string,
    opts?: { viaPanel?: boolean },
  ): Promise<void> {
    const spec: CommandSpec = { ...request, id: request.requestId };
    // 詳細パネル経由の場合はパネル自体が全文確認を兼ねるため、一般の確認は省く。
    // ただし破壊的（confirm: true）だけは、経路に関わらず追加のダイアログを残す。
    const needsConfirm = opts?.viaPanel
      ? !!spec.confirm
      : spec.confirm || vscode.workspace.getConfiguration('aiRunner').get<boolean>('requests.confirm', true);
    if (needsConfirm && !(await confirmRequest(request))) {
      return;
    }
    // confirm 済みなので runSpec 側で二重に聞かせない
    await runner.run({ paths, spec: { ...spec, confirm: false }, source: 'request', resolveStep: commandStore.resolveStep });
    // 実行が終わったリクエストは取り下げる。結果は logs/ に残るため情報は失われない。
    await requestStore.consume(file);
  }

  function rejectRequest(node: Node): Promise<void> {
    if (node.type !== 'request' || !node.request) {
      return Promise.resolve();
    }
    return rejectByRequest(node.request, node.file);
  }

  /**
   * 拒否は「何もしない」では済まない。AI側は結果ファイルの出現を待っているため、
   * 拒否したことを logs/<requestId>.json に必ず書き残す。
   */
  async function rejectByRequest(request: RequestFile, file: string): Promise<void> {
    const note = await vscode.window.showInputBox({
      title: `「${request.label}」を拒否`,
      prompt: 'AIに伝える理由（省略可）。ここに書いた内容はログに記録され、AIが読みます',
      placeHolder: '例: このコマンドは本番環境に影響するため手動で行います',
    });
    if (note === undefined) {
      return; // 入力ボックス自体のキャンセル。拒否も実行もしない
    }
    await writeTerminalLog(
      paths,
      {
        runId: request.requestId,
        source: 'request',
        requestId: request.requestId,
        label: request.label,
        kind: request.kind,
        command: request.kind === 'sequence' ? (request.steps ?? []) : (request.command ?? ''),
        cwd: request.cwd ?? '.',
      },
      'rejected',
      note.trim() || 'ユーザーが実行を拒否しました',
    );
    await requestStore.consume(file);
  }

  function confirmDestructive(spec: CommandSpec): Thenable<boolean> {
    const command = spec.kind === 'sequence' ? (spec.steps ?? []).join('\n') : (spec.command ?? '');
    return vscode.window
      .showWarningMessage(
        `「${spec.label}」を実行しますか?`,
        { modal: true, detail: command },
        '実行',
      )
      .then((picked) => picked === '実行');
  }

  /** AIが書いたコマンドは未レビューの外部入力なので、既定で全文を見せて確認する。 */
  function confirmRequest(request: RequestFile): Thenable<boolean> {
    const command = request.kind === 'sequence' ? (request.steps ?? []).join('\n') : (request.command ?? '');
    const detail = [
      request.description ? `理由: ${request.description}` : undefined,
      `実行されるコマンド:\n${command}`,
      `作業ディレクトリ: ${request.cwd ?? '.'}`,
    ]
      .filter(Boolean)
      .join('\n\n');
    return vscode.window
      .showWarningMessage(
        `AIからのリクエスト「${request.label}」を実行しますか?`,
        { modal: true, detail },
        '実行',
      )
      .then((picked) => picked === '実行');
  }

  async function openLog(node: Node): Promise<void> {
    const key = keyOf(node);
    const active = runner.getActive(key);
    // 実行中なら現在のログ、そうでなければ最後の実行のログを探す
    const target = active?.writer.logPath ?? (await findLatestLog(key));
    if (!target) {
      vscode.window.showInformationMessage('このコマンドの実行ログはまだありません。');
      return;
    }
    await showLog(target);
  }

  function openHistoryLog(node: HistoryNode): Promise<void> {
    return showLog(path.join(paths.workspaceRoot, node.entry.logFile));
  }

  /**
   * ログを仮想ドキュメントとして開く。実ファイルを開くとエクスプローラーが logs/ を
   * 自動展開して大量のログで埋まるため（LogDocumentProvider を参照）。
   */
  async function showLog(absLogPath: string): Promise<void> {
    const uri = LogDocumentProvider.uriFor(absLogPath);
    // 同じログを既に開いている場合に備え、最新内容へ更新してから表示する。
    logProvider.refresh(uri);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  async function findLatestLog(key: string): Promise<string | undefined> {
    const index = await readIndex(paths);
    const entry = index.runs.find((r) => r.commandId === key || r.requestId === key);
    return entry ? path.join(paths.workspaceRoot, entry.logFile) : undefined;
  }

  async function openCommandsFile(): Promise<void> {
    await ensureWorkspaceFiles();
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(paths.commandsFile));
    await vscode.window.showTextDocument(doc);
  }

  async function openReadme(): Promise<void> {
    await ensureWorkspaceFiles();
    const uri = vscode.Uri.file(path.join(paths.root, 'README.md'));
    await vscode.commands.executeCommand('markdown.showPreview', uri);
  }

  async function initWorkspace(): Promise<void> {
    await ensureWorkspaceFiles();
    await commandStore.load();
    const openSpec = 'AI向け仕様を見る';
    const picked = await vscode.window.showInformationMessage(
      `${paths.relative(paths.root)}/ を作成しました。AIに ${paths.relative(paths.root)}/README.md を読ませてください。`,
      openSpec,
    );
    if (picked === openSpec) {
      await openReadme();
    }
  }

  /** 既存ファイルは上書きしない。ユーザーが育てた commands.json を壊さないため。 */
  async function ensureWorkspaceFiles(): Promise<void> {
    await fs.mkdir(paths.requestsDir, { recursive: true });
    await fs.mkdir(paths.logsDir, { recursive: true });
    await writeIfAbsent(paths.commandsFile, SAMPLE_COMMANDS_JSON);
    await writeIfAbsent(path.join(paths.root, 'README.md'), AI_SPEC_MD);
    await writeIfAbsent(path.join(paths.root, '.gitignore'), GITIGNORE);
    await copyBundledSkill();
  }

  /**
   * 拡張に同梱したスキルを配置元としてコピーする。README の誘導に従い、
   * AI がこれをユーザーのプロジェクトの .claude/skills/ へ登録する。
   * 同梱ファイルを実行時に読むことで、templates.ts への文字列二重管理を避けている。
   */
  async function copyBundledSkill(): Promise<void> {
    const src = path.join(context.extensionUri.fsPath, 'skills', 'ai-runner-request', 'SKILL.md');
    const dest = path.join(paths.root, 'claude', 'skills', 'ai-runner-request', 'SKILL.md');
    try {
      const content = await fs.readFile(src, 'utf8');
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await writeIfAbsent(dest, content);
    } catch {
      // 同梱スキルが見つからなくても初期化自体は成立させる（致命ではない）。
    }
  }
}

async function writeIfAbsent(file: string, content: string): Promise<void> {
  try {
    await fs.writeFile(file, content, { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw err;
    }
  }
}

function keyOf(node: Node): string {
  if (node.type === 'command') {
    return node.spec.id;
  }
  if (node.type === 'request' && node.request) {
    return node.request.requestId;
  }
  throw new Error('この項目には実行できる対象がありません。');
}

/** ツリービューのバッジ。0件のときは undefined を返してバッジ自体を消す。 */
export function badgeFor(count: number, unitLabel: string): vscode.ViewBadge | undefined {
  return count > 0 ? { value: count, tooltip: `${count} ${unitLabel}` } : undefined;
}

/**
 * VSCode終了時に実行中プロセスを止めるため、activate 側の Runner をモジュールに保持する。
 * deactivate() には引数が渡らないため、この参照がないと停止対象に手が届かない。
 */
let activeRunner: Runner | undefined;

/**
 * VSCodeはこの関数が返すPromiseを待ってから終了する。
 * ここで待たないと、SIGTERM が届く前に拡張ホストが消え、`npm run dev` などが
 * 取り残されてポートを掴んだままになる。
 *
 * ただしVSCodeが待つ時間は無制限ではないため、予算内で打ち切る。時間切れの場合でも
 * SIGKILL は送出済みなので、プロセスは遅れて終了する。
 */
export async function deactivate(): Promise<void> {
  await activeRunner?.stopAll(3000);
  activeRunner = undefined;
}
