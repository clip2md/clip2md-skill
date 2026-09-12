# clip2md-skill

clip2md 项目的 Claude Code、Codex 和 OpenClaw Skill 集合。

## 概述

本仓库包含 Clip2MD 面向用户的通用剪藏 Skill，用于在 Claude Code、Codex 和 OpenClaw 中连接账号、提交网页剪藏并获取 Markdown。

## 目录结构

```
clip2md-skill/
├── README.md
├── .gitignore
└── skills/clip2md/  # 用户剪藏 Skill 与 CLI
```

## 使用方式

将 `skills/clip2md` 安装到对应助手的 Skill 目录：Claude Code 使用 `~/.claude/skills/clip2md`，Codex 使用 `~/.codex/skills/clip2md`，OpenClaw 使用工作区的 `skills/clip2md`。安装后有两种连接方式：运行 `clip2md connect`，再在 Clip2MD Web 端或小程序的“AI 助手”页面确认绑定码；或者在 Web 端点击“生成授权语句”，把整段语句交给助手，让助手通过 `clip2md connect --authorization-code-stdin` 读取一次性授权码完成连接。生成授权语句即授权，请只发给你信任的助手。

CLI 默认访问生产 API `https://api.clip2md.cn/api/v1`；本地 mock 或私有部署可通过 `CLIP2MD_API_BASE` 覆盖，升级引导地址可通过 `CLIP2MD_APP_URL` 覆盖。AI 助手 Skill 业务能力只对当前生效的 Pro 年卡开放，CLI 会保留结构化资格错误并显示年卡开通地址。CLI smoke test 位于 `skills/clip2md/test`，执行 `npm test`。

## 许可证

Private
