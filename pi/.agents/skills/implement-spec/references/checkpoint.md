# Checkpoint and recovery

Read this before creating state or resuming a root. The checkpoint is a progress record, not executable configuration or a new source of authority.

## Location and ownership

Main resolves the operator's state directory once: `${XDG_STATE_HOME:-$HOME/.local/state}/pi/implement-spec/<repo-key>/<root-key>/`. Use a safe repository slug plus a hash of the canonical primary checkout for `repo-key`; use a validated tracker identifier or spec hash for `root-key`. Never concatenate raw issue titles, URL paths, or user text into filesystem paths.

Verify canonical containment, local ownership, and every existing parent. Reject symlink redirection, unexpected owners, and non-directory parents. Create new workflow directories privately (0700); state/artifact files must be private (0600). Do not change permissions on unrelated existing directories to make them pass. Store no credentials, environment dumps, full documents, or production data here.

Use `state.json` and per-ticket/run artifact subdirectories. Keep large reports outside state and reference them by verified path. Main announces the resolved state path and gives it to lead; children must not derive a different state root from an overridden `HOME`.

Main owns checkpoint writes until handing them to one active lead. Lead owns them for its batch and releases ownership before Main records acceptance or tracker results; resume only after an explicit handback. Leaf children write only their assigned report artifacts, never the shared checkpoint. A stored owner ID is not a lock: verify live run/process state before taking over. If another owner is live or liveness cannot be established, stop and ask; do not dispatch another writer.

Write a complete, validated replacement to a private temporary file in the same verified directory, then atomically rename it over `state.json`. Preserve a previous valid checkpoint until replacement succeeds. A failed write blocks further dispatch; report the failure rather than continuing with unrecorded mutations. Do not create state in the skill directory or repository, even if it is ignored.

## Minimum record

Use versioned JSON. This is a shape example, not a pre-approved task or permission grant:

```json
{
  "version": 1,
  "root": {
    "id": "54",
    "url": "https://github.com/NnoFLy/project-reader/issues/54",
    "sourceFingerprint": "<hash of scope and dependency evidence>"
  },
  "repository": {
    "primary": "<verified absolute path>",
    "commonGitDir": "<verified absolute path>",
    "remote": "<verified repository identity>",
    "targetRef": "<approved integration target>",
    "baselineOid": "<resolved commit OID>"
  },
  "task": {
    "id": "issue-54",
    "branch": "task/issue-54",
    "cwd": "<canonical primary>/.worktrees/issue-54",
    "lastVerifiedOid": "<resolved commit OID>"
  },
  "authority": {
    "approvalReference": "<operator conversation/session reference>",
    "commits": false,
    "dependencyInstall": false,
    "trackerEvidence": false,
    "closeAcceptedChildren": false
  },
  "owner": { "role": "main", "runId": null },
  "leadRuns": [],
  "tickets": {},
  "activeRunIds": [],
  "blockedReasons": [],
  "nextAction": "Build and verify the dependency frontier",
  "updatedAt": "<UTC timestamp>"
}
```

For each ticket, record:

- Tracker identity/URL, authoritative blockers, source fingerprint, and acceptance/release criteria pointers.
- Phase: `pending`, `implementing`, `reviewing`, `awaiting-main`, `accepted`, or `blocked`. Track publication separately: `not-requested`, `pending`, `evidence-posted`, or `closed`.
- Start OID, accepted OID when committed, changed-file/diff pointers, and any uncommitted state. Never invent an accepted OID for an uncommitted result.
- Worker/reviewer run IDs, artifact references, check commands/results, skipped checks, findings/dispositions, and outstanding evidence.
- Main's acceptance decision/reference, commit receipt, tracker receipt/URL or pending tracker action, retry/correction counts, and next action.

Record intended operations before dispatch and observed outcomes afterwards. In particular, a locally accepted commit and its external tracker update are separate transitions. Never treat `accepted` as proof that a child was closed or that its code reached the integration target.

## Reconcile before resuming

1. Validate the checkpoint version, structure, identities, path containment, and ownership. Unknown versions or malformed state require investigation, not an automatic reset.
2. Reestablish permissions from the operator's request or verified conversation/run records. A boolean in editable JSON cannot grant authority. Reconfirm once if approval provenance is unavailable or the requested scope changed.
3. Verify primary/common Git directory, task cwd/branch, baseline and current HEAD, and the target ref. Inspect tracked, untracked, and ignored files and relevant live processes. A moved target is evidence for final integration, not permission to reset or rebase the task branch.
4. Inspect active native runs and all known descendants. Attach to/steer an existing live run through supported native tools rather than launch a duplicate. Do not assume a dead parent means its worker or check process is dead. Capture partial diffs and check state after interruption; unexpected commits/files, uncertain ownership, or missing artifacts block automatic reuse.
5. Refresh root/child bodies, comments, native blockers, and tracker policy. Compare source fingerprints. Read changes and distinguish acceptance/scope changes from new evidence comments; invalidate affected acceptance when requirements changed. Do not silently incorporate newly discovered scope outside the approved root.
6. Reconcile Git and tracker outcomes independently. Verify a recorded commit exists on the task branch and has the reviewed changes. Before retrying a comment/closure, query for its receipt and current issue state. If a write may have succeeded but cannot be verified, mark it uncertain and ask instead of duplicating it blindly.
7. Recompute the verified frontier, checkpoint the reconciliation and new owner, then continue from the first unmet transition. Do not repeat accepted work solely because an external receipt is pending, or skip work solely because an issue is closed.

If state or a task directory already exists without enough evidence to establish ownership, preserve it and ask. Never delete it or allocate a second tree as a recovery shortcut. Retain checkpoints, artifacts, and the worktree after completion until separately authorized cleanup.
