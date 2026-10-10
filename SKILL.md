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

# Clip2MD

This is the entry point for installing the repository root as a Skill.
Keep the bundled `skills/clip2md/` directory with this file.

Before connecting an account or running a command, read the complete
[Clip2MD instructions](skills/clip2md/SKILL.md). They define authorization,
quota disclosure, task handling, credential protection and CLI behavior.

When using this root entry point, run the CLI from this directory:

```bash
node skills/clip2md/scripts/clip2md.js <command>
```

Paths in the linked instructions, including `scripts/clip2md.js`, are
relative to `skills/clip2md/`. If the installer installs that subdirectory
alone, use its own `SKILL.md` and `node scripts/clip2md.js <command>`.
