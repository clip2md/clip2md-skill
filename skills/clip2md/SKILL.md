---
name: clip2md
description: Use Clip2MD to connect an AI assistant, save web pages as Markdown, check quota, query task status, wait for completion, and retrieve results. Use when the user mentions Clip2MD, 剪藏, 保存网页为 Markdown, 查询额度, 提交链接, or 查询任务.
metadata:
  openclaw:
    requires:
      bins:
        - node
    emoji: "✂️"
---

# Clip2MD user Skill

Run the bundled CLI from this skill directory:

```bash
node scripts/clip2md.js <command>
```

Install the `skills/clip2md` directory under the assistant's Skill location:
use `~/.claude/skills/clip2md` for Claude Code, `~/.codex/skills/clip2md`
for Codex, or the OpenClaw workspace's `skills/clip2md` directory.

The CLI supports two connection flows. The normal flow prints a short binding
code for the user to confirm on the Clip2MD Web page or mini-program. The web
generated flow accepts a one-time authorization code through standard input;
it never prints the code or a complete credential.

## Workflow

- Use `connect` when no Skill credential exists, when the user asks to connect, or when the credential is expired or revoked.
- Use `connect --authorization-code-stdin` when the user provides a web generated authorization sentence. Pass only the authorization code through stdin; do not put it in a shell argument, URL, log, or chat response. The CLI stores a short lived claim identifier locally so a lost response can be retried safely.
- Use `clip` only for a single HTTP(S) URL. Return the task ID and current status.
- Use `wait` only when the user asks to wait, or when the saved execution preference requests it.
- Use `result` only after the task succeeds. Respect the saved Markdown preference unless the user explicitly asks for another kind.
- Use `quota` and `status` for read-only checks.
- Use `disconnect` when the user asks to remove this assistant's access.
- Do not retry a POST whose result is ambiguous; query the task by ID first.
- Do not paste full Markdown unless the user asks for it. Summarize title, status, quota, and readiness by default.

## Commands

```text
connect [--name <device name>]
connect --authorization-code-stdin [--name <device name>]
disconnect
config show [--json]
config <legacy token>       # deprecated compatibility command
quota [--json]
clip <url> [--json]
status <task_id> [--json]
wait <task_id> [--timeout 120] [--interval 5] [--json]
result <task_id> [--kind note|source|both] [--json]
```

`--json` 可用于自动化调用。成功时 stdout 只输出一条 JSON，诊断、兼容迁移提示和凭证到期提醒输出到 stderr；`status` 和 `wait` 的任务对象会增加 `status_kind`，取值为 `success`、`failed`、`pending` 或 `unknown`。未知任务状态使用退出码 4，已知失败使用退出码 2，等待超时使用退出码 3。

`result` 未指定 `--kind` 时，每次通过 Skill 身份读取 `/skill/me` 的 `preferences.markdown_content`；读取失败会在 stderr 提示并使用 `note` 继续。显式的 `--kind` 优先于云端偏好。

The device credential is stored in `~/.clip2md/credentials.json` with owner
only permissions. The legacy token, if present, remains in
`~/.clip2md/config.json` only until the user completes a Skill connection.
After a successful migration, an expired or revoked Skill credential must not
fall back to the legacy token.

Legacy token compatibility is retained until the next minor CLI release and
for at most 90 days after the first Skill CLI release, whichever comes first.

Skill usage is limited by the account-wide server budget. For the current
Pro policy this is 20 automatic creations per Shanghai calendar day and 300
per calendar month, shared by all Skill devices. Server quota and queue
limits still apply.

Never include credentials in user-facing output, JSON output, logs, shell
arguments, or generated files. Unknown response fields are ignored; unknown
task states are reported as unresolved rather than successful.

The web page's “生成授权语句” action authorizes the request immediately. The
sentence includes the official Skill repository and the one-time code, which
expires after 10 minutes. Only send it to an assistant you trust. The agent
should invoke `node scripts/clip2md.js connect --authorization-code-stdin` and
provide the code through stdin. A generated code is not a long lived API key.

The CLI defaults to `https://api.clip2md.cn/api/v1`, matching the production API
configuration. Set `CLIP2MD_API_BASE` only for tests or private deployments.

Run the local smoke tests with `npm test` from `skills/clip2md`.
