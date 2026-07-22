---
name: ai-runner-request
description: >-
  Route a command through the AI Command Runner VSCode extension for
  user-approved execution, then read its structured result logs. Use this ONLY
  when the user explicitly asks to run something via AI Command Runner / the
  ai-runner extension / "承認付きで" / "承認待ちに出して", OR when a command genuinely
  needs interactive stdin the running agent cannot supply, is a long-running dev
  server the user should start/stop and watch (e.g. npm run dev), or when you
  (the AI) have no shell of your own to execute commands (e.g. Claude Desktop).
  Applies only in projects that contain a `.vscode/ai-runner/` directory. Do NOT
  use this for ordinary commands you can just run yourself — a normal
  test/build/lint the user simply asked you to run belongs in your own shell,
  not in a request. When in doubt, run directly or ask the user first; never
  create a request the user did not ask for.
---

# AI Command Runner — writing execution requests

The **AI Command Runner** VSCode extension lets you (an AI) ask the user to run a
command on their machine, get their explicit approval, and then read the result.
You never execute the command yourself. You write a small request file; the user
reviews and approves it in VSCode; the extension runs it and writes back
structured logs that you read to decide what to do next.

This skill only makes sense in a project where that extension is set up.

## Before anything: is a request actually wanted?

Creating a request interrupts the user — it puts an item in their "承認待ち"
(Pending) sidebar that they must click and approve. So the bar for creating one
is high. Creating requests the user did not ask for is the main failure mode of
this skill; avoid it.

Create a request only when **at least one** of these is clearly true:

1. **The user explicitly asked for it** — they mentioned AI Command Runner, the
   ai-runner extension, "承認付きで実行", "承認待ちに出して", or otherwise asked to run
   this *through the extension / with their approval*.
2. **Interactive input is required** that your own shell cannot reasonably
   provide (a command that prompts for input at a TTY).
3. **It is a long-running / daemon process** the user should start, watch, and
   stop themselves (e.g. `npm run dev`, a watch task).
4. **You have no shell of your own** — you can read and write files but cannot
   run commands (e.g. Claude Desktop). Then a request is your only way to run
   anything.

If none of these hold, do **not** create a request:

- If you can just run the command yourself (you have a shell and the user only
  asked you to "run the tests / build / lint"), run it directly. That is faster
  and doesn't interrupt the user.
- If you're unsure whether the user wants the extension involved, **ask them**
  ("Run this directly, or send it to AI Command Runner for you to approve?")
  rather than guessing. A wrongly created request is worse than a question.

The safe default is: **no explicit signal, no request.**

## Hard guard: is the extension even here?

Check that the directory `.vscode/ai-runner/` exists in the current workspace.
If it does not, the extension is not set up here — do **not** create files under
it. Tell the user the AI Command Runner workspace isn't initialized (they can run
"AI Runner: ワークスペースを初期化" from the VSCode command palette) and stop.

## Workflow

1. Confirm `.vscode/ai-runner/` exists (see the hard guard). If not, stop.
2. Confirm a request is actually warranted (see the section above). If you could
   just run it yourself, do that instead.
3. Pick a `requestId`: short, unique, and using only `A-Z a-z 0-9 . _ -`. It
   becomes the filename and the result path, so make it descriptive
   (`run-tests`, `dev-server`).
4. Write `.vscode/ai-runner/requests/<requestId>.json` (schema below). The
   filename base **must equal** `requestId` or the extension rejects it.
5. Tell the user a request named `<requestId>` is waiting in the "承認待ち" view,
   and briefly what it will run. Then wait — do not poll aggressively.
6. Read `.vscode/ai-runner/logs/<requestId>.json`. If it does not exist yet, the
   user simply hasn't approved it — keep waiting; do **not** rewrite the request.
7. Branch on `status` (table below). Continue based on the result.

## Request file format

Path: `.vscode/ai-runner/requests/<requestId>.json`

| Field | Required | Meaning |
|---|---|---|
| `requestId` | yes | Must equal the filename base. Allowed chars: `A-Z a-z 0-9 . _ -`. |
| `label` | yes | Short human-readable description shown in the sidebar. Must honestly match the command — the user sees the full command, so a misleading label destroys trust. |
| `kind` | no | `oneshot` (default), `daemon` (never-ending), or `sequence` (run several in order; stops at the first failure). |
| `command` | for oneshot/daemon | The command. Runs via the shell (pipes, `&&` work). |
| `steps` | for sequence | Array of command strings, run in order. |
| `description` | no | Why you want it run. Helps the user decide whether to approve. |
| `cwd` | no | Path relative to the workspace root. Pointing outside the workspace is rejected. |
| `env` | no | Object of extra environment variables (string values). |
| `confirm` | no | `true` adds an extra confirmation dialog before running. Set it for destructive operations (delete, deploy, force-push, DB migration, …). |

**Example (oneshot):**

```json
{
  "requestId": "run-tests",
  "label": "テストを実行して失敗箇所を特定する",
  "description": "リファクタリング後の回帰を確認したいため",
  "kind": "oneshot",
  "command": "npm test",
  "cwd": "."
}
```

**Example (daemon):**

```json
{
  "requestId": "dev-server",
  "label": "開発サーバーを起動する",
  "kind": "daemon",
  "command": "npm run dev"
}
```

## Reading the result

Two files share the `requestId`, and you already know their paths the moment you
write the request:

- `.vscode/ai-runner/logs/<requestId>.json` — **read this first.** It has
  `status`, `exitCode`, and `tail` (the last ~50 output lines). Usually enough.
- `.vscode/ai-runner/logs/<requestId>.log` — the full output. Read it (or `grep`
  it) only when `tail` isn't enough; daemon logs can be thousands of lines.

`status` values and what to do:

| `status` | Meaning | What you do |
|---|---|---|
| `running` | Still running (normal for daemons) | Wait and re-read later. |
| `success` | Exit code 0 | Proceed using the result. |
| `failed` | Non-zero exit code | Read `tail` / the `.log` for the cause. |
| `stopped` | The user stopped it | Normal end for daemons. |
| `rejected` | The user declined to run it | Do **not** resend. Read `note` for the reason and propose an alternative. |
| `error` | Couldn't even start (bad command or cwd) | Fix the command/cwd, then reconsider. |

If you need history, `.vscode/ai-runner/logs/index.json` lists recent runs,
newest first.

## Rules of thumb

- **One request, one purpose.** Don't bundle unrelated commands into a
  `sequence` just to save a round-trip.
- **Never resend a `rejected` request.** The user said no on purpose. Understand
  the `note`, then propose a different approach — don't try again with the same
  thing.
- **Mark destructive work with `confirm: true`.** Anything you couldn't undo.
- **Keep `label` honest.** It must describe the actual command.
- You may delete your own request file; the extension also auto-cleans requests
  once they've been processed.
