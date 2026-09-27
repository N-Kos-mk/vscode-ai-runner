'use strict';
/**
 * 実行エンジンの結合テスト。`node test/run.js` で実行する。
 * 実際に子プロセスを起動し、生成されたログファイルを検証する。
 */

const Module = require('module');
const assert = require('assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { test } = require('node:test');

// require('vscode') をスタブに向ける。コンパイル済みコードを読み込む前に仕込む必要がある。
const stub = require('./stub-vscode');
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  return request === 'vscode' ? stub : originalLoad.call(this, request, ...rest);
};

const { Runner } = require('../out/core/runner');
const { WorkspacePaths } = require('../out/core/paths');
const { RequestStore } = require('../out/core/requestStore');
const { parseCommandsFile, parseRequestFile, ValidationError } = require('../out/core/validate');
const { readIndex, writeTerminalLog, RunLogWriter } = require('../out/core/logStore');
const { formatAgo, formatDuration, runningDescription } = require('../out/ui/trees');
const { LogDocumentProvider } = require('../out/ui/logDocument');
const { HistoryTreeProvider } = require('../out/ui/historyTree');
const { renderRequestHtml, escapeHtml } = require('../out/ui/requestPanel');
const { badgeFor } = require('../out/extension');
const { AnsiStripper } = require('../out/core/ansi');

async function makeWorkspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-runner-test-'));
  const paths = new WorkspacePaths({ uri: { fsPath: dir }, name: 'test', index: 0 });
  return { dir, paths };
}

const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));

test('oneshot: 成功時に status=success と stdout がログに残る', async () => {
  const { paths } = await makeWorkspace();
  const runner = new Runner();
  const log = await runner.run({
    paths,
    source: 'command',
    spec: { id: 'hello', label: 'hello', kind: 'oneshot', command: 'echo こんにちは' },
  });

  assert.equal(log.status, 'success');
  assert.equal(log.exitCode, 0);
  assert.ok(log.tail.some((line) => line.includes('こんにちは')), 'tail に stdout が含まれること');

  const meta = await readJson(path.join(paths.workspaceRoot, log.logFile.replace(/\.log$/, '.json')));
  assert.equal(meta.status, 'success');
  const raw = await fs.readFile(path.join(paths.workspaceRoot, log.logFile), 'utf8');
  assert.match(raw, /こんにちは/);
  runner.dispose();
});

test('oneshot: 失敗時に status=failed と終了コードが記録される', async () => {
  const { paths } = await makeWorkspace();
  const runner = new Runner();
  const log = await runner.run({
    paths,
    source: 'command',
    spec: { id: 'boom', label: 'boom', kind: 'oneshot', command: 'echo なにか問題 >&2; exit 3' },
  });

  assert.equal(log.status, 'failed');
  assert.equal(log.exitCode, 3);
  assert.ok(log.tail.some((line) => line.includes('[stderr]')), 'stderr が識別可能な形で残ること');
  runner.dispose();
});

test('sequence: 失敗した時点で打ち切り、以降のstepを実行しない', async () => {
  const { paths } = await makeWorkspace();
  const runner = new Runner();
  const log = await runner.run({
    paths,
    source: 'command',
    spec: {
      id: 'seq',
      label: 'seq',
      kind: 'sequence',
      steps: ['echo ステップ1', 'exit 9', 'echo ステップ3'],
    },
  });

  assert.equal(log.status, 'failed');
  assert.equal(log.exitCode, 9);
  const raw = await fs.readFile(path.join(paths.workspaceRoot, log.logFile), 'utf8');
  assert.match(raw, /ステップ1/);
  assert.doesNotMatch(raw, /ステップ3/, '失敗後のstepは実行されないこと');
  assert.match(log.note ?? '', /step 2\/3/);
  runner.dispose();
});

test('daemon: 停止すると子プロセスツリーごと終了する', async () => {
  const { paths } = await makeWorkspace();
  const runner = new Runner();
  // シェル(child)が sleep(孫)を起動する。child.kill() だけでは孫が生き残り、
  // `npm run dev` を止めたのにポートが解放されない、という状況になる。
  // source='request' にすると runId=id となり、ログのパスが実行前に確定する。
  // ここでは実行中にログを覗きたいのでこちらを使う（'command' は runId に時刻が付く）。
  const running = runner.run({
    paths,
    source: 'request',
    spec: { id: 'dev', label: 'dev', kind: 'daemon', command: 'sleep 60 & echo PID=$!; wait' },
  });

  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(runner.isRunning('dev'), true, '停止前は実行中として見えること');

  // 孫のPIDは実行中のログから読む。run() の解決を待ってから確認したのでは、
  // 「孫が sleep 60 を全うして自然死しただけ」のケースと区別がつかない。
  const raw = await fs.readFile(paths.logFileFor('dev'), 'utf8');
  const pid = Number(raw.match(/PID=(\d+)/)?.[1]);
  assert.ok(Number.isInteger(pid), '孫プロセスのPIDが取得できること');
  assert.doesNotThrow(() => process.kill(pid, 0), '停止前は孫プロセスが生きていること');

  await runner.stop('dev');
  await new Promise((resolve) => setTimeout(resolve, 500));
  // シグナル0は存在確認のみ行う。プロセスが生きていれば例外は飛ばない。
  assert.throws(
    () => process.kill(pid, 0),
    /ESRCH/,
    '停止要求から間もなく孫プロセス(sleep)も終了していること',
  );

  const log = await running;
  assert.equal(log.status, 'stopped');
  assert.equal(runner.isRunning('dev'), false);
  runner.dispose();
});

test('stopAll: VSCode終了時に実行中プロセスを全て止め、終了まで待つ', async () => {
  const { paths } = await makeWorkspace();
  const runner = new Runner();
  const daemon = (id) => ({
    id,
    label: id,
    kind: 'daemon',
    command: `sleep 60 & echo PID=$!; wait`,
  });
  const running = [
    runner.run({ paths, source: 'request', spec: daemon('dev') }),
    runner.run({ paths, source: 'request', spec: daemon('watch') }),
  ];

  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(runner.runningCount, 2);
  const pids = await Promise.all(
    ['dev', 'watch'].map(async (id) => {
      const raw = await fs.readFile(paths.logFileFor(id), 'utf8');
      return Number(raw.match(/PID=(\d+)/)?.[1]);
    }),
  );
  assert.ok(pids.every(Number.isInteger), '各孫プロセスのPIDが取得できること');

  await runner.stopAll(3000);

  // stopAll の解決時点で全て終わっていること。ここが投げっぱなしだと、
  // VSCodeが先に終了してプロセスが取り残される。
  assert.equal(runner.runningCount, 0, 'stopAll の完了時に実行中のものが残っていないこと');
  for (const pid of pids) {
    assert.throws(() => process.kill(pid, 0), /ESRCH/, `孫プロセス ${pid} が終了していること`);
  }
  for (const id of ['dev', 'watch']) {
    const meta = await readJson(paths.metaFileFor(id));
    assert.equal(meta.status, 'stopped', 'ログが running のまま放置されないこと');
    assert.ok(meta.endedAt, '終了時刻が記録されること');
  }

  await Promise.all(running);
  runner.dispose();
});

test('stopAll: 実行中のものが無ければ即座に返る', async () => {
  const runner = new Runner();
  const started = Date.now();
  await runner.stopAll(3000);
  assert.ok(Date.now() - started < 100, '予算を待たずに返ること');
  runner.dispose();
});

test('cwd がワークスペース外を指す場合、実行せず status=error のログを残す', async () => {
  const { paths } = await makeWorkspace();
  const runner = new Runner();
  const log = await runner.run({
    paths,
    source: 'request',
    spec: { id: 'escape', label: 'escape', kind: 'oneshot', command: 'echo x', cwd: '../../etc' },
  });

  // AIは結果ファイルの出現を待つため、実行に至らなかった場合でもログは必須。
  assert.equal(log.status, 'error');
  assert.match(log.note ?? '', /ワークスペース外/);
  await fs.access(paths.metaFileFor('escape'));
  runner.dispose();
});

test('request の結果は requestId と同じ名前で書き出される', async () => {
  const { paths } = await makeWorkspace();
  const runner = new Runner();
  await runner.run({
    paths,
    source: 'request',
    spec: { id: 'my-request', label: 'r', kind: 'oneshot', command: 'echo ok' },
  });

  // AIがリクエスト送信時点で結果の場所を確定できることが、この設計の前提。
  const meta = await readJson(paths.metaFileFor('my-request'));
  assert.equal(meta.requestId, 'my-request');
  assert.equal(meta.status, 'success');
  runner.dispose();
});

test('index.json に新しい順で実行履歴が積まれる', async () => {
  const { paths } = await makeWorkspace();
  const runner = new Runner();
  await runner.run({ paths, source: 'command', spec: { id: 'a', label: 'a', kind: 'oneshot', command: 'echo a' } });
  await runner.run({ paths, source: 'command', spec: { id: 'b', label: 'b', kind: 'oneshot', command: 'echo b' } });

  const index = await readIndex(paths);
  assert.equal(index.runs[0].commandId, 'b', '最新の実行が先頭に来ること');
  assert.equal(index.runs[1].commandId, 'a');
  runner.dispose();
});

test('ログは maxLines を超えると古い行から破棄される', async () => {
  const { paths } = await makeWorkspace();
  stub.__setConfig('logs.maxLines', 100);
  const runner = new Runner();
  const log = await runner.run({
    paths,
    source: 'command',
    spec: { id: 'noisy', label: 'noisy', kind: 'oneshot', command: 'seq 1 5000' },
  });

  const raw = await fs.readFile(path.join(paths.workspaceRoot, log.logFile), 'utf8');
  const lines = raw.trim().split('\n');
  assert.ok(lines.length <= 102, `行数が上限付近に収まること (実際: ${lines.length})`);
  assert.match(raw, /5000/, '直近の出力は残ること');
  assert.match(raw, /上限/, '破棄が起きたことが明示されること');
  runner.dispose();
  stub.__setConfig('logs.maxLines', 5000);
});

test('チャンク境界で分断された出力が1行として復元される', async () => {
  const { paths } = await makeWorkspace();
  const runner = new Runner();
  // 1行を細切れに出力し、chunk が行境界と一致しない状況を作る。
  // 未完の行をバッファしないと、これが複数行に分断されて記録される。
  const script = `node -e "
    process.stdout.write('AAA');
    process.stderr.write('EEE');
    setTimeout(() => process.stdout.write('BBB'), 60);
    setTimeout(() => process.stderr.write('FFF\\n'), 90);
    setTimeout(() => process.stdout.write('CCC\\n'), 120);
  "`;
  const log = await runner.run({
    paths,
    source: 'request',
    spec: { id: 'chunked', label: 'chunked', kind: 'oneshot', command: script },
  });

  const raw = await fs.readFile(paths.logFileFor('chunked'), 'utf8');
  assert.match(raw, /^AAABBBCCC$/m, '分割して届いた出力が1行に結合されること');
  assert.ok(log.tail.includes('AAABBBCCC'), 'tail 側でも1行として見えること');
  // プレフィックスはチャンクではなく行に付ける。チャンク単位で付けると
  // '[stderr] EEE[stderr] FFF' のように行の途中に紛れ込む。
  assert.match(raw, /^\[stderr\] EEEFFF$/m, 'stderrのプレフィックスが行頭にのみ付くこと');
  runner.dispose();
});

test('同じコマンドの二重起動を拒否する', async () => {
  const { paths } = await makeWorkspace();
  const runner = new Runner();
  const spec = { id: 'dup', label: 'dup', kind: 'oneshot', command: 'sleep 1' };
  const first = runner.run({ paths, source: 'command', spec });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const second = await runner.run({ paths, source: 'command', spec });

  assert.equal(second, undefined, '実行中の再実行は無視されること');
  await first;
  runner.dispose();
});

test('通し: AIがリクエストを書いてから結果を読むまで', async () => {
  const { paths } = await makeWorkspace();
  const runner = new Runner();
  const store = new RequestStore(paths);
  await fs.mkdir(paths.requestsDir, { recursive: true });

  // ① AIがリクエストファイルを書く
  await fs.writeFile(
    path.join(paths.requestsDir, 'run-tests.json'),
    JSON.stringify({
      requestId: 'run-tests',
      label: 'テストを実行',
      description: '回帰を確認したいため',
      kind: 'oneshot',
      command: 'echo 3 tests failed; exit 1',
    }),
  );

  // ② 拡張機能が検知し、承認待ちとして見えるようになる
  await store.load();
  assert.equal(store.all.length, 1);
  const item = store.get('run-tests');
  assert.ok(item?.request, 'リクエストが仕様に適合していること');
  assert.equal(item.error, undefined);

  // ③ ユーザーが承認して実行する（自動実行の経路は存在しない）
  const spec = { ...item.request, id: item.request.requestId };
  await runner.run({ paths, spec, source: 'request' });
  await store.consume(item.file);

  // ④ AIが結果を読む。パスはリクエストを書いた時点で確定している
  const meta = await readJson(paths.metaFileFor('run-tests'));
  assert.equal(meta.status, 'failed');
  assert.equal(meta.exitCode, 1);
  assert.ok(meta.tail.some((l) => l.includes('3 tests failed')));
  assert.equal(meta.logFile, '.vscode/ai-runner/logs/run-tests.log');

  // 処理済みリクエストは取り下げられ、UIから消える
  assert.equal(store.all.length, 0);
  await assert.rejects(fs.access(item.file), 'リクエストファイルが削除されること');

  store.dispose();
  runner.dispose();
});

test('通し: 拒否してもAIが待ち続けないようログが残る', async () => {
  const { paths } = await makeWorkspace();
  await fs.mkdir(paths.requestsDir, { recursive: true });

  // 拒否は「何もしない」では済まない。AIは結果ファイルの出現を待っているため。
  await writeTerminalLog(
    paths,
    {
      runId: 'deploy',
      source: 'request',
      requestId: 'deploy',
      label: '本番にデプロイ',
      kind: 'oneshot',
      command: 'npm run deploy:prod',
      cwd: '.',
    },
    'rejected',
    '本番環境への操作は手動で行います',
  );

  const meta = await readJson(paths.metaFileFor('deploy'));
  assert.equal(meta.status, 'rejected');
  assert.equal(meta.exitCode, null);
  assert.match(meta.note, /手動で行います/);

  const index = await readIndex(paths);
  assert.equal(index.runs[0].status, 'rejected');
});

test('詳細パネル: AIが書いた文字列はHTMLエスケープされる（XSS対策）', () => {
  // label や command は外部AIが書く未検証の文字列。マークアップがそのまま
  // Webviewに入るとスクリプトが実行されうるため、無害化されることを確認する。
  const html = renderRequestHtml(
    {
      requestId: 'evil',
      label: '<img src=x onerror=alert(1)>',
      kind: 'oneshot',
      command: 'echo "</pre><script>alert(1)</script>"',
      description: 'a & b < c',
    },
    'testnonce',
  );

  assert.doesNotMatch(html, /<img src=x/, 'labelの生タグが埋め込まれないこと');
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/, 'command内のscriptタグが生で入らないこと');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/, 'エスケープ済みで表示されること');
  assert.match(html, /a &amp; b &lt; c/);
  // CSPとnonceが効いていること（自前スクリプト以外を弾く）
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /script-src 'nonce-testnonce'/);
  assert.match(html, /default-src 'none'/);
});

test('詳細パネル: escapeHtml が主要な文字を変換する', () => {
  assert.equal(escapeHtml(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
  assert.equal(escapeHtml('plain text'), 'plain text');
});

test('詳細パネル: 拒否ボタンは警告色クラスを持つ', () => {
  const html = renderRequestHtml({ requestId: 'r', label: 'r', kind: 'oneshot', command: 'x' }, 'n');
  assert.match(html, /id="reject" class="danger"/, '拒否ボタンが danger クラスであること');
  assert.match(html, /\.danger[\s\S]*errorForeground/, 'danger が警告色を使うこと');
});

test('バッジ: 0件では非表示、1件以上で件数とツールチップを出す', () => {
  assert.equal(badgeFor(0, '件の承認待ち'), undefined);
  assert.deepEqual(badgeFor(3, '件の承認待ち'), { value: 3, tooltip: '3 件の承認待ち' });
  assert.deepEqual(badgeFor(1, '件を実行中'), { value: 1, tooltip: '1 件を実行中' });
});

test('詳細パネル: sequenceのstepsとコマンドが表示に反映される', () => {
  const html = renderRequestHtml(
    { requestId: 'seq', label: 'ビルド一式', kind: 'sequence', steps: ['npm ci', 'npm run build'] },
    'n',
  );
  assert.match(html, /npm ci\nnpm run build/, 'stepsが順に表示されること');
  assert.match(html, /sequence/);
});

test('履歴: 実行すると新しい順で履歴に載り、ログパスが辿れる', async () => {
  const { paths } = await makeWorkspace();
  const runner = new Runner();
  await runner.run({ paths, source: 'command', spec: { id: 'first', label: '最初', kind: 'oneshot', command: 'echo 1' } });
  await runner.run({
    paths,
    source: 'request',
    spec: { id: 'second', label: '次', kind: 'oneshot', command: 'echo 2; exit 1' },
  });
  runner.dispose();

  const history = new HistoryTreeProvider(paths);
  await history.load();
  const nodes = history.getChildren();
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].entry.label, '次', '最新が先頭に来ること');
  assert.equal(nodes[0].entry.status, 'failed');
  assert.equal(nodes[1].entry.label, '最初');

  // TreeItem が status を反映し、クリックでログを開くコマンドが割り当たること
  const item = history.getTreeItem(nodes[0]);
  assert.match(String(item.description), /失敗/);
  assert.equal(item.command.command, 'aiRunner.openHistoryLog');
  assert.equal(item.command.arguments[0], nodes[0]);

  // 履歴項目の logFile から実ログへ辿れること（クリック時の解決と同じ経路）
  const provider = new LogDocumentProvider();
  const abs = path.join(paths.workspaceRoot, nodes[0].entry.logFile);
  const content = await provider.provideTextDocumentContent(LogDocumentProvider.uriFor(abs));
  assert.match(content, /echo 2/);
});

test('履歴: 拒否したリクエストも履歴に残る', async () => {
  const { paths } = await makeWorkspace();
  await writeTerminalLog(
    paths,
    {
      runId: 'deploy',
      source: 'request',
      requestId: 'deploy',
      label: '本番デプロイ',
      kind: 'oneshot',
      command: 'npm run deploy',
      cwd: '.',
    },
    'rejected',
    '手動で行うため',
  );

  const history = new HistoryTreeProvider(paths);
  await history.load();
  const nodes = history.getChildren();
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].entry.status, 'rejected');
  // リクエストを requests/ から消しても、何を拒否したかがここに残る
  const item = history.getTreeItem(nodes[0]);
  assert.match(String(item.description), /拒否/);
});

test('ログ表示: 仮想ドキュメントが実ファイルの中身を返す', async () => {
  const { paths } = await makeWorkspace();
  const runner = new Runner();
  await runner.run({
    paths,
    source: 'request',
    spec: { id: 'show', label: 'show', kind: 'oneshot', command: 'echo 表示テスト' },
  });
  runner.dispose();

  const provider = new LogDocumentProvider();
  const uri = LogDocumentProvider.uriFor(paths.logFileFor('show'));
  // タブに出る名前は basename、実ファイルの場所は query に入る。
  assert.equal(uri.scheme, 'ai-runner-log');
  assert.equal(uri.path, 'show.log');
  assert.equal(uri.query, paths.logFileFor('show'));

  const content = await provider.provideTextDocumentContent(uri);
  assert.match(content, /表示テスト/, '実ファイルの中身が表示されること');
});

test('ログ表示: 存在しないログでも壊れず案内を返す', async () => {
  const provider = new LogDocumentProvider();
  const missing = await provider.provideTextDocumentContent(
    LogDocumentProvider.uriFor('/no/such/path/run.log'),
  );
  assert.match(missing, /見つかりません/, 'ENOENTでも例外を投げず案内文を返すこと');

  const empty = await provider.provideTextDocumentContent({ scheme: 'ai-runner-log', path: 'x', query: '' });
  assert.match(empty, /指定されていません/);
});

test('表示: 経過時間の整形', () => {
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(9_000), '0:09');
  assert.equal(formatDuration(61_000), '1:01');
  assert.equal(formatDuration(600_000), '10:00');
  assert.equal(formatDuration(3_599_000), '59:59');
  assert.equal(formatDuration(3_600_000), '1:00:00');
  assert.equal(formatDuration(3_661_000), '1:01:01');
  // 時計のずれ等で負になっても壊れないこと
  assert.equal(formatDuration(-5_000), '0:00');
});

test('表示: 最終出力からの経過の整形', () => {
  assert.equal(formatAgo(0), '0秒前');
  assert.equal(formatAgo(59_999), '59秒前');
  assert.equal(formatAgo(60_000), '1分前');
  assert.equal(formatAgo(3_599_000), '59分前');
  assert.equal(formatAgo(3_600_000), '1時間前');
});

test('表示: 実行中は経過時間と最終出力からの経過を示す', () => {
  const now = 1_000_000;
  const withOutput = { startedAtMs: now - 150_000, writer: { lastOutputAt: now - 3_000 } };
  assert.equal(runningDescription(withOutput, now), '実行中 2:30 · 最終出力 3秒前');

  // 起動直後などまだ何も出ていない場合。「出力なし」と「出力が古い」を区別する。
  const noOutput = { startedAtMs: now - 5_000, writer: { lastOutputAt: undefined } };
  assert.equal(runningDescription(noOutput, now), '実行中 0:05 · 出力なし');
});

test('表示: 最終出力の時刻はプロセス出力でのみ更新される', async () => {
  const { paths } = await makeWorkspace();
  const writer = await RunLogWriter.create(paths, {
    runId: 'w',
    source: 'command',
    commandId: 'w',
    label: 'w',
    kind: 'oneshot',
    command: 'x',
    cwd: '.',
  });

  // 拡張機能自身の注記は「動きがあった」ことにはならない。
  writer.appendLine('[ai-runner] $ npm run dev');
  assert.equal(writer.lastOutputAt, undefined, '注記では最終出力時刻が動かないこと');
  assert.equal(writer.outputLineCount, 0);

  writer.append('起動しました\n');
  assert.ok(typeof writer.lastOutputAt === 'number', 'プロセス出力で最終出力時刻が入ること');
  assert.equal(writer.outputLineCount, 1);
  assert.deepEqual(writer.recent(1), ['起動しました']);

  await writer.finalize('stopped', null);
});

test('検証: requestId とファイル名の不一致を拒否する', () => {
  assert.throws(
    () => parseRequestFile({ requestId: 'foo', label: 'l', command: 'echo x' }, 'bar'),
    ValidationError,
  );
  const ok = parseRequestFile({ requestId: 'foo', label: 'l', command: 'echo x' }, 'foo');
  assert.equal(ok.kind, 'oneshot');
});

test('検証: パス区切りを含むIDを拒否する', () => {
  // ログの出力先がワークスペース外に逃げるのを防ぐ。
  assert.throws(() => parseRequestFile({ requestId: '../evil', label: 'l', command: 'x' }, '../evil'), ValidationError);
  assert.throws(() => parseCommandsFile({ commands: [{ id: 'a/b', label: 'l', command: 'x' }] }), ValidationError);
});

test('検証: 不正な定義を拒否する', () => {
  assert.throws(() => parseCommandsFile({ commands: [{ id: 'a', label: 'l', kind: 'sequence' }] }), ValidationError);
  assert.throws(() => parseCommandsFile({ commands: [{ id: 'a', label: 'l' }] }), ValidationError);
  assert.throws(() => parseCommandsFile({ commands: [{ id: 'a', label: 'l', kind: 'nope', command: 'x' }] }), ValidationError);
  assert.throws(
    () =>
      parseCommandsFile({
        commands: [
          { id: 'dup', label: 'l', command: 'x' },
          { id: 'dup', label: 'l', command: 'y' },
        ],
      }),
    ValidationError,
  );
});

test('ANSI: 色付けの制御コードを除去する', () => {
  const stripper = new AnsiStripper();
  const out = stripper.push(
    '\x1b[32m\x1b[1mVITE\x1b[22m v8.3.1\x1b[39m  ➜  \x1b[1mLocal\x1b[22m: \x1b]8;;http://x\x07link\x1b]8;;\x07\n',
  );
  assert.equal(out, 'VITE v8.3.1  ➜  Local: link\n');
});

test('ANSI: チャンク境界で分断されたシーケンスも除去する', () => {
  const stripper = new AnsiStripper();
  const out = ['a\x1b', '[3', '6mb\x1b[', '39m', 'c'].map((c) => stripper.push(c)).join('');
  assert.equal(out, 'abc');
});

test('ANSI: 終端しない断片で以降の出力を止めない', () => {
  const stripper = new AnsiStripper();
  const out = stripper.push('\x1b]' + 'x'.repeat(2000));
  assert.ok(out.length >= 2000);
});

test('oneshot: 子プロセスの色付き出力がログに制御コードなしで残る', async () => {
  const { paths } = await makeWorkspace();
  const runner = new Runner();
  const log = await runner.run({
    paths,
    source: 'command',
    spec: {
      id: 'color',
      label: 'color',
      kind: 'oneshot',
      command: `node -e "process.stdout.write(String.fromCharCode(27) + '[32mgreen' + String.fromCharCode(27) + '[39m')"`,
    },
  });

  assert.equal(log.status, 'success');
  const raw = await fs.readFile(path.join(paths.workspaceRoot, log.logFile), 'utf8');
  // 1行目はコマンドの記録なので、プロセス出力の行だけを見る。
  assert.ok(raw.split('\n').includes('green'), 'ログに制御コードを含まない出力行が残ること');
  assert.doesNotMatch(raw, /\x1b/);
  runner.dispose();
});
