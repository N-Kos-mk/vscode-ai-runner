import { CommandKind, CommandSpec, RequestFile } from './types';

/**
 * commands.json / requests/*.json は拡張機能の外部（人間の手書き、外部AI、
 * リポジトリ同梱物）から与えられる入力なので、型を信用せず全て検証する。
 */

const KINDS: CommandKind[] = ['oneshot', 'daemon', 'sequence'];
const ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export class ValidationError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${field} は空でない文字列である必要があります`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireString(value, field);
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new ValidationError(`${field} は文字列の配列である必要があります`);
  }
  return value as string[];
}

function optionalEnv(value: unknown, field: string): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value) || Object.values(value).some((v) => typeof v !== 'string')) {
    throw new ValidationError(`${field} は文字列を値に持つオブジェクトである必要があります`);
  }
  return value as Record<string, string>;
}

/**
 * ファイル名とIDの一致を強制する。IDにパス区切りや `..` が入ると、
 * ログ出力先がワークスペース外に逃げうるため。
 */
function requireId(value: unknown, field: string): string {
  const id = requireString(value, field);
  if (!ID_PATTERN.test(id)) {
    throw new ValidationError(`${field} に使えるのは英数字・ドット・ハイフン・アンダースコアのみです: ${id}`);
  }
  if (id === '.' || id === '..' || id === 'index') {
    throw new ValidationError(`${field} に予約語は使えません: ${id}`);
  }
  return id;
}

function parseKind(value: unknown): CommandKind {
  if (value === undefined) {
    return 'oneshot';
  }
  if (typeof value !== 'string' || !KINDS.includes(value as CommandKind)) {
    throw new ValidationError(`kind は ${KINDS.join(' | ')} のいずれかである必要があります`);
  }
  return value as CommandKind;
}

function parseBody(raw: Record<string, unknown>, id: string): Omit<CommandSpec, 'id'> {
  const kind = parseKind(raw.kind);
  const command = optionalString(raw.command, 'command');
  const steps = optionalStringArray(raw.steps, 'steps');

  if (kind === 'sequence') {
    if (!steps || steps.length === 0) {
      throw new ValidationError(`kind が sequence の場合、steps に1つ以上の要素が必要です (${id})`);
    }
  } else if (!command) {
    throw new ValidationError(`kind が ${kind} の場合、command が必要です (${id})`);
  }

  return {
    label: optionalString(raw.label, 'label') ?? id,
    kind,
    command,
    steps,
    cwd: optionalString(raw.cwd, 'cwd'),
    env: optionalEnv(raw.env, 'env'),
    description: optionalString(raw.description, 'description'),
    pinned: raw.pinned === true,
    confirm: raw.confirm === true,
    branches: optionalStringArray(raw.branches, 'branches'),
  };
}

export function parseCommandSpec(raw: unknown): CommandSpec {
  if (!isRecord(raw)) {
    throw new ValidationError('コマンド定義はオブジェクトである必要があります');
  }
  const id = requireId(raw.id, 'id');
  return { id, ...parseBody(raw, id) };
}

export function parseCommandsFile(raw: unknown): CommandSpec[] {
  if (!isRecord(raw)) {
    throw new ValidationError('commands.json のトップレベルはオブジェクトである必要があります');
  }
  if (!Array.isArray(raw.commands)) {
    throw new ValidationError('commands.json には commands 配列が必要です');
  }
  const specs = raw.commands.map(parseCommandSpec);
  const seen = new Set<string>();
  for (const spec of specs) {
    if (seen.has(spec.id)) {
      throw new ValidationError(`id が重複しています: ${spec.id}`);
    }
    seen.add(spec.id);
  }
  return specs;
}

/** requests/<name>.json を検証する。requestId はファイル名と一致していなければならない。 */
export function parseRequestFile(raw: unknown, fileBaseName: string): RequestFile {
  if (!isRecord(raw)) {
    throw new ValidationError('リクエストはオブジェクトである必要があります');
  }
  const requestId = requireId(raw.requestId, 'requestId');
  if (requestId !== fileBaseName) {
    throw new ValidationError(
      `requestId (${requestId}) がファイル名 (${fileBaseName}.json) と一致していません。` +
        `ログの出力先がファイル名から一意に決まる必要があるため、両者は一致させてください`,
    );
  }
  return {
    requestId,
    ...parseBody(raw, requestId),
    createdAt: optionalString(raw.createdAt, 'createdAt'),
  };
}
