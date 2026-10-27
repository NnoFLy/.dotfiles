# Pi configuration

## Worktree workflow

Run `./setup.sh config` from the dotfiles root to install these resources with the existing GNU Stow `pi` package:

- `pi/.agents/skills/git-worktree/SKILL.md` → `~/.agents/skills/git-worktree/SKILL.md`
- `pi/.agents/skills/implement-spec/` → `~/.agents/skills/implement-spec/`
- `pi/.pi/agent/agents/lead.md` → `~/.pi/agent/agents/lead.md`

Pi discovers skills in `~/.agents/skills/`; the configured `pi-subagents` package discovers the user-level `lead` agent. Reload Pi after installation. Neither resource depends on a specific username or checkout path.

Use a task worktree for feature implementation or substantial code changes, as well as explicit worktree requests and established worktree tasks. Small localized fixes, routine maintenance, and documentation-only changes stay in the current checkout unless a worktree is explicitly requested or already assigned. A standalone request to commit or push without worktree context must not load it, create a worktree, or prompt for Local merge / Create PR. Once a worktree task is active, every delegated assignment must carry the verified absolute skill path and require the child to read it before acting. Fresh workers do not automatically inherit global instructions or skill discovery.

Use `lead` only for explicitly authorized nested coordination. Its assignment must authorize scout, worker, and reviewer children, bound their scope and worktree ownership, and prohibit further delegation. Main keeps final acceptance and publication authority. The agent's availability alone does not authorize spawning it or its children.

Worktree checks require a separately installed, compatible upstream `heavy` executable supporting `--dir`, `--pool`, `--slots`, `--no-skip-ci`, and `--on-timeout fail`. Setup does not install it. The skill requires stopping heavy checks if it is missing; never bypass the queue. Resolve the queue under the operator's home once and pass the same absolute path to children.

Existing regular files at these destinations will conflict with Stow. Compare and back them up, then move them aside only with the owner's approval before rerunning setup. Do not use `stow --adopt` or overwrite them automatically. This also applies to the previously hand-installed copies of these resources.

To test fresh installation, repeated setup, conflict preservation, and the policy's activation/handoff wording without touching your real home:

```sh
node --test pi/tests/worktree-workflow.test.mjs
```

These tests check deployment and policy text, not a model's compliance or a live nested run.

## Implement a root spec

The explicit-only `implement-spec` skill runs a root spec's dependency graph through Main → lead → scout/worker/reviewer, without requiring a separate kickoff for each ticket. It uses one task branch/worktree, sequential writers, independent reviews, and checkpoints outside the repository. It does not create an unattended background service.

After installation and `/reload`, invoke it from the verified repository:

```text
/skill:implement-spec https://github.com/NnoFLy/project-reader/issues/54
```

Use any supported root issue URL, or a number such as `#54` once its repository is verified. Invocation starts preflight and bounded implementation; commits, dependency installation, and child-ticket updates need explicit permission. Grant the required permissions once at kickoff to let ordinary accepted tickets advance automatically. Main retains final acceptance and tracker/publication actions. Without commit authority, the workflow stops at the first accepted uncommitted ticket rather than mix ticket changes.

Reinvoke with the same root to reconcile the checkpoint, actual Git state, native runs, and tracker receipts before resuming. Live/uncertain writers, unavailable device evidence, and failed feasibility or security gates remain blockers. The workflow never resets a dirty checkout or treats tracker closure alone as implementation evidence.

At the end it asks Local merge or Create PR; neither implementation permission nor integration approval authorizes cleanup or parent closure. The skill's [checkpoint reference](.agents/skills/implement-spec/references/checkpoint.md) describes state ownership and recovery.

This adapts [Matt Pocock's implement-spec](https://github.com/mattpocock/skills/tree/main/skills/engineering/implement-spec) to the local Pi/worktree policy. Creating or installing the skill does not execute the example issue.

## Manual commit and push

The `commit` and `push` skills live in `.agents/skills/` in this Stow package and install under `~/.agents/skills/`. Both disable automatic model invocation. After installation and `/reload`, use:

```text
/skill:commit
/skill:push
```

`commit` reviews staged changes, or clearly identified task changes when nothing is staged, and creates focused Conventional Commits. It can split clearly separable changes without modifying file contents. `push` reads and follows the sibling `commit` skill, then fetches the configured upstream, reviews all outgoing commits, and pushes only the current branch.

Neither workflow runs agent-initiated tests or checks, launches subagents, or creates a worktree. Git hooks remain enabled and may run checks. Review concerns, ambiguous scope, hook failures, missing upstreams, and behind/divergent branches stop the workflow. Neither skill forces a push or rewrites history. The global checks exception applies only to these explicit invocations, not independent repository requirements.

## Emacs editor

The extension in `.pi/agent/extensions/emacs-eat-editor.ts` adds Emacs-style editing to Pi. Keep the `extensions/emacs-eat/` helper directory alongside the entry point, including in symlink-based installations. An existing entry-point symlink does not install newly added sibling files automatically. Run `/reload` after linking the files and updating `keybindings.json`.

## Keys

`C-` means Control; `M-` means Alt/Meta. For a `C-x` sequence, release Control before pressing the second key. Escape or `C-g` cancels a prefix; it also expires after 1.5 seconds.

| Keys                                | Action                                                   |
| ----------------------------------- | -------------------------------------------------------- |
| `C-/`, `C-_`, `C--`, `C-x u`        | Undo                                                     |
| `C-?`, `C-x r`                      | Redo on the selected branch                              |
| `C-x [`, `C-x ]`                    | Chronologically older/newer change, across branches      |
| `C-M-b`, `C-M-f`                    | Beginning/end of a whitespace-delimited WORD             |
| `C-M-Backspace`, `C-M-d`            | Kill backward/forward WORD                               |
| `C-Backspace`, `M-Backspace`, `C-w` | Kill the previous small word                             |
| `C-y`                               | Yank the latest kill-ring entry                          |
| `M-y`                               | Replace the preceding yank with the next kill-ring entry |
| `M-b`, `M-f`                        | Pi's existing small-word movement                        |
| `C-p`, `C-n`                        | Move through editor text, not prompt history             |
| `M-p`, `M-n`                        | Browse prompt history and restore saved undo trees       |
| `C-x m`, `C-x t`, `C-x s`, `C-x h`  | Model, thinking level, session tree, Pi hotkeys          |

A WORD is a non-whitespace run: `foo/bar-baz` is one WORD. WORD movement and killing cross line breaks. A collapsed paste label is indivisible. These `C-M-` bindings are WORD operations, not Emacs balanced-expression operations.

Undo history branches when you undo and type something different. Ordinary redo follows the selected branch; the chronological shortcuts recover the other branches, like Vim's `g-` and `g+`. Typing keeps Pi's existing word-sized undo groups. Pasting, killing, yanking, and each yank-pop are separate undo units. Cursor movement and history restoration invalidate yank-pop. The kill ring does not use the system clipboard, and is not saved across restarts.

Punctuation and combined-modifier shortcuts depend on terminal support. Use `C-x u/r` if undo/redo punctuation is unavailable. Legacy `C-?` can be indistinguishable from Backspace, so ordinary Backspace is never interpreted as redo. `C-M-Backspace` requires explicit Kitty/CSI-u or modifyOtherKeys reporting; ambiguous legacy Meta-Backspace sequences keep their existing small-word behavior. Russian physical-key aliases remain supported for letter commands and prefixes.

## Persistent history

Each submitted prompt has a separate undo tree. Recalling a prompt copies its tree into the draft; editing it does not modify the submitted prompt's archive. Submission starts a fresh draft tree. The current draft and its branches are restored when the same Pi session resumes. Live editor text takes priority if it differs from the saved draft.

`M-p/M-n` keep the full prompt history for the current Pi session, including its conversation branches, without Pi's native 100-prompt cap. Reload/resume restores the list from the archive index and the original session log, not the compacted model context. Prompts that predate the extension can be recovered as text, but cannot acquire undo branches that were never saved. Only consecutive identical prompts are collapsed. Built-in commands are archived but do not participate in recall ordering unless Pi adds them to prompt history. Other sessions remain separate.

Raw inputs and their undo trees keep their own stable submission IDs. Delivery checkpoints separately record the actual session-entry IDs, so a template, skill, or input transformation does not become an extra recalled prompt when Pi persists expanded text. Recovery imports only session entries not already represented by the captured-input history.

Older indexes lack delivery identity. Their text and archive files are retained, but text matching alone never authorizes restoring an old tree onto a recovered occurrence. Unmatched legacy inputs may remain separately visible rather than being guessed or discarded.

Archives live under `~/.pi/agent/emacs-undo/<hashed-session-id>/`, or under the configured Pi agent directory. They contain **plaintext deleted text**, including secrets removed before submission. Directories use mode `0700`; files use `0600`. Nothing is added to the model's context or the dotfiles repository.

Draft saves are debounced by 300 ms. Submission and normal shutdown/reload flush pending writes. Abrupt termination can lose unsaved edits. Writes use private temporary files and atomic replacement; archive reads reject symlinks and invalid data. A second live editor for the same session falls back to in-memory history rather than overwrite the first editor's files. Storage errors warn without blocking editing. Files larger than 64 MiB are refused without pruning existing history.

There is no automatic expiry. Run `/emacs-undo-clear` and confirm to delete the current session's saved trees and reset its in-memory undo history, keeping visible text and submitted-prompt recall. This does not erase the kill ring, Pi's conversation transcript, backups, or filesystem snapshots. If storage is unavailable, close Pi and remove that session's archive directory manually. Only trusted local processes running as your account (or privileged processes) should access these files.

The compatibility adapter uses private Pi editor methods. After a Pi upgrade, run the tests below. If the required methods change, the extension disables itself and warns instead of installing a partial adapter.

## Tests

From the dotfiles repository root, with Node 24 or another Node release supporting TypeScript stripping:

```sh
node --test pi/tests/*.test.ts pi/tests/*.test.mjs
```

To also test the deployed extension path and its helper links:

```sh
PI_TEST_EXTENSION="$HOME/.pi/agent/extensions/emacs-eat-editor.ts" \
  node --test pi/tests/*.test.ts pi/tests/*.test.mjs
```

The integration tests load the real installed Pi editor through Pi's bundled `jiti`. They use the managed installation's `current-version` file by default. For a different installation, set `PI_TEST_NODE_MODULES` to its `node_modules` directory. Persistence tests use temporary directories, not your real prompt archives.
