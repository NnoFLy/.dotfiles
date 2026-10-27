---
name: push
description: Reuse the commit skill, then review and push outgoing commits to the configured upstream. Run only when the user explicitly invokes this skill.
disable-model-invocation: true
---

# Push

Run only when the user invokes `/skill:push`. General requests to change, review, commit, or push code do not automatically activate this skill. Invocation authorizes the commit workflow and a normal push of the current branch, including main/master, subject to repository restrictions.

## Reuse commit

Read [the commit skill](../commit/SKILL.md) completely and follow it in this session. Resolve the path relative to this skill's directory. Do not copy its workflow, launch another agent, or fall back to an improvised implementation if the file is missing.

Continue only after successful commits or an unambiguous “nothing to commit.” A concern, unresolved question, hook failure, or partially completed commit workflow blocks pushing. Inherit its no-checks policy and hook protections.

## Review and push

1. Resolve the current branch's configured upstream remote and destination branch. Ask if either is missing or ambiguous; do not choose origin, create tracking, or change Git configuration automatically. Verify the effective push destination matches the fetched repository. Ask about differing fetch/push URLs, multiple push URLs, or mirror configuration before publishing. Do not expose credentials embedded in URLs.
2. Fetch only the upstream branch from that remote, with tags, pruning, and recursive submodule fetching disabled. Record the fetched commit. Stop on fetch failure. Do not merge or rebase. If the fetched tip is not an ancestor of local HEAD, stop and report that the branch is behind or divergent.
3. Briefly review every outgoing commit and the combined diff from the fetched tip to HEAD, including commits predating this invocation. Apply the commit skill's review boundaries. Stop for unrelated or unclear work, suspected secrets, or likely bugs. If there are no outgoing commits, report “nothing to push.”
4. Record the reviewed HEAD and confirm the branch, HEAD, destination, and worktree/index state have not unexpectedly changed. Push only that reviewed commit to the explicit upstream branch ref using a normal, non-forced push. Disable automatic tag following and recursive submodule pushing; do not rely on implicit push refspecs. Never use force, force-with-lease, all-branch, mirror, or tag pushes.
5. Keep pre-push hooks enabled. On rejection, hook failure, or uncertain network results, report the state and stop; do not retry blindly, pull, rebase, merge, or change the destination.

Report the commit skill's result, destination branch, push outcome, and that agent-run checks were skipped. Never claim publication succeeded without evidence. This skill does not create PRs, integrate another branch, or clean up worktrees.
