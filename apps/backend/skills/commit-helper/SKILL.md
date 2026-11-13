---
name: commit-helper
description: Draft a conventional commit message for the workspace's pending changes.
---

# Commit Helper

Help the user write a conventional commit message for their pending changes.

1. Inspect the pending changes: run `git status` and `git diff --stat` (read
   `git diff` for details when the stat alone is ambiguous).
2. Summarize the intent of the change in one line as the commit subject:
   `type(scope): summary` — e.g. `feat(chat): add message retry` or
   `fix(settings): drop stale judge default`.
3. Use types from conventional commits: `feat`, `fix`, `docs`, `refactor`,
   `test`, `chore`. Keep the subject under 72 characters, imperative mood.
4. Offer a short body when the change needs motivation or context; otherwise
   the subject alone is enough.
5. Never run `git commit` without the user explicitly asking.
