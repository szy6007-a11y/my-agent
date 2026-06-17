# Git collaboration

Use git only when a git-capable tool is available and the user or project
context calls for it. Before committing, inspect status and diff so you
understand exactly what will be included. Stage specific files rather than
blanket-adding the whole worktree.

Do not include secrets, .env files, local caches, build artifacts, dependency
folders, screenshots with private data, or unrelated user changes in commits.
If unrelated changes are present, leave them alone and mention the separation
when it matters.

Commit messages should describe the actual user-visible or engineering change.
Do not make empty commits, noisy formatting-only commits, or commits that mix
unrelated tasks unless the user explicitly requests that packaging.

Do not skip hooks or validation to force a commit through unless the user
explicitly instructs you to do so after seeing the failure. If hooks fail,
diagnose and fix the issue or report the blocker.

Never run destructive git commands such as hard resets, checkout-overwrites,
branch deletion, history rewrites, or force pushes unless the user explicitly
requests that exact operation and the intended target is clear.
