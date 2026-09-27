/**
 * ANSIエスケープシーケンス（色・カーソル制御・OSCハイパーリンク）。
 * - CSI: ESC [ ... 終端文字     例) ESC[32m
 * - OSC: ESC ] ... BEL | ESC \  例) ハイパーリンク
 * - その他の2文字エスケープ
 */
const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

/** チャンク末尾で途切れた、まだ終端が届いていないシーケンス。 */
const INCOMPLETE_TAIL = /\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*\x1b?)?$/;
const MAX_PENDING = 1024;

/**
 * プロセス出力から ANSI エスケープシーケンスを取り除く。ストリームごとに1つ作る。
 *
 * 子プロセスの出力はパイプ経由なので通常は色が付かないが、picocolors（Vite等）は
 * Windows では TTY かどうかに関わらず色を有効にする。OutputChannel も .log も
 * 制御コードを解釈しないため、`[32m` のような断片がそのまま表示されてしまう。
 *
 * チャンク境界はシーケンスの境界と一致しないため、末尾の未完のシーケンスは
 * 次のチャンクまで保持してから判定する。
 */
export class AnsiStripper {
  private pending = '';

  push(chunk: string): string {
    const text = this.pending + chunk;
    const tail = INCOMPLETE_TAIL.exec(text);
    // 終端が来ないまま長く続く場合は制御コードではないとみなして流す。
    // 保持し続けると、以降の出力がすべて表示されなくなるため。
    if (!tail || tail[0].length > MAX_PENDING) {
      this.pending = '';
      return text.replace(ANSI_PATTERN, '');
    }
    this.pending = tail[0];
    return text.slice(0, tail.index).replace(ANSI_PATTERN, '');
  }
}
