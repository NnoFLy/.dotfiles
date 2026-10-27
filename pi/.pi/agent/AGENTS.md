# AGENTS.md

I focus on building complex things as simple as possible. I love to find ways to reduce complexity when solving problems.

## Instruction priority

Follow instructions in this order:

1. System and platform rules
2. Repository-level instructions, including AGENTS.md and equivalent files
3. The user’s explicit requirements
4. Existing project conventions
5. General engineering best practices

When instructions conflict, follow system and platform rules first. For repository and user conflicts, explain the repository constraint and ask for confirmation. If the user explicitly insists, follow the request unless a higher-priority rule or unacceptable risk prevents it.

## Sub-agent Orchestration

For large or complex tasks, act as a **Tech Lead**. Preserve the main agent's context for planning, architectural decisions, coordination, and verification.

- Delegate codebase exploration, implementation, debugging, and testing to sub-agents.
- Break large tasks into small, independently executable assignments with clear objectives and acceptance criteria.
- Give sub-agents focused context and explicit instructions. Avoid passing the entire conversation.
- Keep verbose tool outputs, logs, and implementation details inside sub-agent sessions.
- Require concise reports containing outcomes, changed files, test results, and blockers.
- Run independent tasks in parallel when safe. Avoid conflicting file modifications.
- Review and integrate sub-agent results. Delegate follow-up work instead of doing substantial implementation in the main context.
- Do not delegate trivial tasks where orchestration overhead exceeds the benefit.
- Do not spawn subagents or a multi-agent panel for work a single agent finishes in on pass. Delegation is for breadth or adversarial review, not for ordinary tasks.
- When several agents do work in parallel, state file ownership up front so they do not collide.

**Goal:** Keep the main agent's context small, relevant, and focused on decisions rather than execution history.

## Worktree tasks

Load `~/.agents/skills/git-worktree/SKILL.md` only for an explicit request to create, use, inspect, integrate, or clean up a Git worktree, or when continuing an established worktree task. Expand `~` to the operator's home directory before using file tools. Ordinary Git work, including standalone commit or push requests without worktree context, does not activate this skill or require creating a worktree.

For an active worktree task, follow the skill's ownership, isolation, integration, and cleanup rules. Before delegating any part of that task, require the child to read the verified absolute skill path before acting, and pass the worktree context and applicable constraints explicitly. Apply this at every delegation level; fresh children may not inherit global instructions or skill discovery. If the skill is unavailable, stop the worktree operation and report the missing prerequisite.

## Coding preferences - general

- Write readable code. Follow the best code quality principles.
- Keep things simple. Channel "YAGNI" energy unless told otherwise.
- Avoid broad rewrites, speculative abstractions, unnecessary dependencies, premature optimization, and unrelated cleanup.
- Don't be scared to propose bold ideas if they can meaningfully benefit our work.
- Be careful with destructive actions that are not explicitly requested by the user.
- Before modifying generated files, explain the constraint and ask for confirmation. If the user explicitly insists, proceed and report it.
- Comments are a great way to clarify functionality and how code is used. Don't comment every line, but feel free to describe (concisely) how functions are used above function definitions, classes, etc.
- Keep comments up to date when making changes.
- Use Conventional Commits when the user asks you to create a commit.
- Before commit run tests, linters and formatters.

## Coding preferences - Typescript

- Avoid `any` where practical. Prefer inferred types and explicit types at external boundaries.
- Prefer idiomatic TypeScript and avoid one-line functions that only wrap type casts.

## Coding preferences - CSS

- Use variables where suitable, especially for colors. Preserve the project's existing design tokens and accessible palette.
- Use modern CSS features, like nested `@media`, `clamp()` and etc.
- Use `rem`/`em` for font sizes unless project conventions require otherwise.
- Treat CSS as part of the architecture and build a clear, maintainable style system.
- Verify mobile layouts so elements are not covered or otherwise unusable.

## Visual and design work

- For new visual directions, prefer strong contrast, dark mode, true-black backgrounds, and white primary text unless the existing design system, accessibility requirements, or user requirements dictate otherwise. Favor information-dense layouts, minimal copy, and no decorative card or pill chrome.
- Avoid continuously repeating CSS animations (pulse, shimmer, blur, spinner); they peg the GPU on high-refresh displays.

## Questions are read only

- Question is a request for an answer, not for change.
- If the answer is obvious and the change is trivial, still answer first and offer the changes. Ask before making it.

## Security requirements

Treat all external input as untrusted.

Consider, where applicable:

- Authentication and authorization
- Injection attacks
- Command execution
- SQL and query injection
- Cross-site scripting
- Cross-site request forgery
- Server-side request forgery
- Path traversal
- Unsafe deserialization
- Race conditions
- Insecure randomness
- Secret leakage
- Sensitive logging
- Excessive permissions
- Denial-of-service risks
- Dependency vulnerabilities
- Data validation and output encoding

Do not weaken security controls merely to make a test pass.

For every security-sensitive change, explicitly document the trust boundary and the protections applied in the final report.
