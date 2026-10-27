---
name: git-worktree
description: Use only for explicit Git worktree requests or continuing an established worktree task, including its checks, integration, and cleanup. Do not use for ordinary Git operations, including standalone commit or push requests without worktree context.
---

# Git task worktrees

## Activation boundary

Load this skill only when the user explicitly asks to create, use, inspect, integrate, or clean up a worktree, or when the current assignment continues an established worktree task. An assigned linked task worktree is worktree context; merely being in a Git repository, having a branch, or having unrelated worktrees is not.

Standalone requests such as "commit these changes" or "push this branch" without worktree context do not activate this skill. Do not create a worktree or ask for an integration choice just to satisfy those requests. Normal authorization and repository rules still apply.

Within a worktree task, apply only the relevant phase: a read-only inspection does not authorize creation, and a commit or push request does not authorize integration or cleanup. Ask Local merge / Create PR only when proposing integration of the completed task, not after every Git command.

## Worktree layout

Use native Git, not a custom worktree CLI. Each task gets a named branch and a worktree at the canonical primary checkout's `.worktrees/<safe-task-id>`. Never create `.worktrees` recursively inside a linked worktree. Assign one active writer per tree; readers may share it. State the owner, absolute cwd, branch, baseline commit, and intended integration target before writing.

Worktrees and these instructions are not a security sandbox. Commands still have the account's filesystem, credential, process, and network access. Review untrusted project instructions and commands; expose only the resources needed. Stop and report missing authority or runtime/tool failures rather than silently changing execution modes.

## Prepare and create

1. Read the project's instructions and discover its existing development and check commands. Inspect `git worktree list --porcelain`, `git rev-parse --show-toplevel --git-common-dir`, refs, remotes, and `git status --short --branch`. Locate the primary checkout from Git's worktree metadata and verify its canonical path and common Git directory; do not equate the current cwd with the primary. For bare repositories, missing primaries, or ambiguous ownership, stop and ask.
2. Establish the intended baseline and target with the user/project context. Do not assume `main`, `master`, `dev`, the current branch, or a remote's default is correct. Resolve the approved baseline to a commit with `git rev-parse --verify "${baseline}^{commit}"` and record it. Do not switch branches, reset, or stash someone else's work. A dirty primary is not input to copy blindly: inspect it and ask about relevant changes; an independent committed baseline may still be safe.
3. Choose a task ID matching `[a-z0-9]+(-[a-z0-9]+)*` and a branch such as `task/<safe-task-id>`; validate the branch with `git check-ref-format --branch`. Inspect local/remote refs and registered worktrees for collisions. If the branch or destination already exists (including a dangling symlink), stop; reuse only after explicit ownership and baseline verification, never delete or overwrite it to make room.
4. Resolve `PRIMARY`, its `.worktrees` parent, and the proposed destination canonically. Verify ownership and path containment, including every existing parent; reject symlink redirection, traversal, unexpected mounts/owners, and a destination registered to another tree. Recheck before creating. Create a missing `.worktrees` directory only within the verified primary.
5. Before creation, check that `.worktrees/` is excluded from Git tracking (`git check-ignore -v` and tracked-path inspection), Docker build contexts, file watchers, and root-recursive build/test/lint tools. Git ignore does **not** isolate Docker contexts, bind mounts, or watchers. Read the actual context/ignore/tool configuration. If exclusions need project changes, obtain authorization first; do not silently edit config or proceed with unsafe recursion.
6. With those preconditions satisfied, create from the recorded commit:

   ```sh
   git -C "$PRIMARY" worktree add -b "$branch" "$PRIMARY/.worktrees/$task_id" "$baseline_oid"
   ```

   Verify the resulting canonical root, branch, HEAD, common Git directory, and clean status. Record ownership outside any assumption that Git itself locks out other writers. Commit only when authorized.

### Pi delegation

Installed `pi-subagents` managed allocation rejects a native worktree base inside the checkout and has its own allocation/cleanup lifecycle. Do not change its configuration to force this layout. Prepare task worktrees manually with Git, then pass the verified **absolute** `cwd` and explicit `worktree: false` to delegated runs. For workflows, set the outer cwd/default and explicitly override every writing `runs.run` / `runs.all` child with its assigned absolute cwd and `worktree: false`, so inherited managed isolation cannot allocate another tree. Include branch, baseline, ownership, allowed writes, and stop conditions in each assignment. Before launching any child for this worktree task (direct workers, leads, and their descendants, including checks and review), verify this skill's absolute path and require the child to read it before acting. Explicitly pass the worktree context, applicable constraints, and resolved global heavy-queue path; do not rely on global instruction inheritance or skill discovery. If the child cannot read the skill, it must stop and report the blocker. Each coordinating child must repeat this handoff for its own children. Main retains integration/publication authority and gathers user approvals; children report proposals and blockers to their parent. Serialize writers sharing a tree; do not invoke managed cleanup for manually owned trees.

## Environment and checks

- Discover project commands and required services first. Prepare dependencies/services only as needed; do not assume `make start`, install, migrate, or seed is appropriate. Preserve the project's package manager and versions. Download caches may be shared; writable `node_modules`, virtualenvs, and build outputs must not be shared between trees.
- Default to synthetic local development data. Do not blindly copy `.env`, real databases/media, or inherit production credentials/ENV. Inspect configuration without printing secrets, and supply only the required local settings.
- Isolate mutable databases/data, ports, origins, and Compose project namespaces per tree. Use shared PostgreSQL only if the project safely supports per-tree databases/schemas and credentials. Preserve existing test isolation; do not force architectural changes. If safe runtime isolation needs source changes, stop that runtime operation and ask for approval. Code-only work may continue if its own preconditions are safe.
- Run light targeted checks directly. Route heavy local builds/tests/checks through the same global queue from every project and tree:

  ```sh
  heavy --dir "$HOME/.local/state/heavy" --pool checks --slots 1 \
    --no-skip-ci --on-timeout fail -- command arg1 arg2
  ```

  Replace `command arg1 arg2` with the discovered project command and its separate arguments. Resolve the operator's `$HOME/.local/state/heavy` to one verified absolute path and pass that same path to every child; a child with an overridden `HOME` must not derive a different queue. Keep the absolute lock base, pool, and slot count identical across calls, regardless of cwd, `TMPDIR`, or `CI`. If needed, choose an explicit bounded `--timeout <seconds>`; a busy timeout must fail without running the payload. Verify the lock base is on a local filesystem, user-owned, private (mode 0700), and not symlink-redirected; create it privately if absent. Missing or incompatible upstream `heavy` blocks heavy checks: report it, never bypass the queue or install a substitute silently.
- Inspect inherited `HEAVY_HELD` / `HEAVY_SLOT` without exposing secrets. They signal nested admission: a legitimate same-pool child reuses its parent's slot rather than reacquiring it. Stale or spoofed values can bypass admission; stop and resolve provenance before running. Do not blanket-clear them on nested calls, which can deadlock. Do not use environment overrides to silently allow execution.
- One slot controls admission, not CPU/RAM usage. Unwrapped commands are not serialized. Killing `heavy` with SIGKILL may release the lock before its child exits; verify live processes before admitting replacement work. Do not put secrets in command arguments or logs.

## Integration: always ask

Show the task branch, intended target, diff/review summary, and check results (including omissions/failures). Then **always** ask the user to choose exactly **Local merge** or **Create PR**, using `ask_user_question` when available with two options and no assumed default; otherwise ask in text and wait. Earlier preferences do not replace this final choice. Neither option authorizes cleanup.

- **Local merge:** only the main agent integrates, after approval. Serialize integration against other target writers, verify the latest target and a clean, owned integration tree, and merge the reviewed task branch with `git merge --no-ff`. Do not automatically rebase or squash. Run the relevant checks on the combined result. On conflicts or failed checks, stop, report the exact merge/check state, and ask before corrective or destructive actions; do not claim successful integration prematurely. No push is implied.
- **Create PR:** this choice authorizes the necessary publication only when remote, base branch, and scope are known. Verify the actual push destination and PR repository/base before pushing; ask if ambiguous. Publish the task branch without force push and create the PR. Do not merge the local target or implicitly merge the PR. Report the URL and check state. Keep the worktree and data for review; PR creation is not a cleanup trigger.

## Cleanup is separate

Request separate authorization after accepted integration or explicit discard. Before proposing removal, verify exact owned paths/branches and inspect tracked changes, untracked **and ignored** files, local databases/media, and running processes/containers. `git clean` is not a complete inventory or cleanup plan. Preserve review material until authorized; do not remove stale or pre-existing trees just because they look unused.

Stop owned processes only with authorization. No automatic database/volume deletion, broad `rm -rf`, prune, or force operations. Remove only individually verified, owned resources in the approved scope; use non-forced `git worktree remove` only after preserving required files/data and confirming the tree is safe to remove. Branch deletion also needs authorization and integration/discard verification. Report what remains.
