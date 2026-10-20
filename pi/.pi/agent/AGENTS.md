I focus on building complex things as simple as possible. I love to find ways to reduce complexity when solving problems.

# Instruction priority

Follow instructions in this order:

1. System and platform rules
2. Repository-level instructions, including AGENTS.md and equivalent files
3. The user’s explicit requirements
4. Existing project conventions
5. General engineering best practices

When instructions conflict, follow system and platform rules first. For repository and user conflicts, explain the repository constraint and ask for confirmation. If the user explicitly insists, follow the request unless a higher-priority rule or unacceptable risk prevents it.

When you're working on a hard task or a task involving many sub-agents, you can use git worktrees to organize the workflow.

# Coding preferences - general

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

# Coding preferences - Typescript

- Avoid `any` where practical. Prefer inferred types and explicit types at external boundaries.
- Prefer idiomatic TypeScript and avoid one-line functions that only wrap type casts.
- If the project does not already specify a stack, I generally prefer Svelte/SvelteKit, Drizzle, Dexie.js, and oxlint/oxfmt. Do not replace an existing project stack to follow this preference.
- With Svelte, use native CSS.

# Coding preferences - CSS

- Use variables where suitable, especially for colors. Preserve the project's existing design tokens and accessible palette.
- Use modern CSS, including nested `@media` queries, where supported and appropriate.
- Use `rem`/`em` for font sizes unless project conventions require otherwise.
- Treat CSS as part of the architecture and build a clear, maintainable style system.
- Verify mobile layouts so elements are not covered or otherwise unusable.

# Visual and design work

- For new visual directions, prefer strong contrast, dark mode, true-black backgrounds, and white primary text unless the existing design system, accessibility requirements, or user requirements dictate otherwise. Favor information-dense layouts, minimal copy, and no decorative card or pill chrome.
- Avoid continuously repeating CSS animations (pulse, shimmer, blur, spinner); they peg the GPU on high-refresh displays.

# Questions are read only

- Question is a request for an answer, not for change.
- If the answer is obvious and the change is trivial, still answer first and offer the changes. Ask before making it.

# Match ceremony of the task

- Do not spawn subagents or a multi-agent panel for work a single agent finishes in on pass. Delegation is for breadth or adversarial review, not for ordinary tasks.
- When several agents do work in parallel, state file ownership up front so they do not collide.

# Core principles

## Request sufficient information

Before starting substantial work, determine whether the request contains enough information to produce a correct result.

Ask the user for additional information when missing details could materially affect:

- Functional requirements
- Acceptance criteria
- Architecture or implementation approach
- Security, privacy, or authorization behavior
- Data formats or compatibility
- Destructive or irreversible operations
- Deployment environment or runtime constraints
- Expected error handling
- Testing and validation requirements

Before asking the user:

1. Inspect the available repository, files, documentation, configuration, tests, and tool output.
2. Do not ask for information that can be obtained reliably through available tools.
3. Separate essential missing information from details that can be inferred safely.
4. Make reasonable, reversible assumptions for minor ambiguities and state them clearly.

When clarification is required:

- Ask focused and specific questions.
- Explain briefly why each answer matters.
- Group related questions into one concise request.
- Present concrete options when that reduces ambiguity.
- Recommend a default when appropriate.
- Do not begin risky, destructive, security-sensitive, or architecture-defining work until the required information is available.

Do not delay work with unnecessary questions. Continue without clarification when the ambiguity is minor, the safest interpretation is clear, and the decision is easy to reverse.

## Default agent workflow

Use this default loop for code changes:

1. Clarify the goal, scope, constraints, and acceptance criteria. Ask only when ambiguity could materially affect behavior, security, compatibility, architecture, or an irreversible action.
2. Scout before editing when the task is unfamiliar, cross-cutting, security-sensitive, or spans multiple files. Keep scouting read-only.
3. Implement the smallest approved change.
4. For broad, complex, or high-risk changes, run a fresh independent review after implementation. For small or straightforward changes, perform and document a self-review. A reviewer may make small local fixes, but must not change behavior or architecture without returning the finding to the primary agent.
5. Verify with relevant tests, typecheck, and lint commands when available. If checks are unavailable, perform manual verification and report the limitation. If available checks fail, stop and report instead of claiming completion unless the user explicitly authorizes an override.
6. Summarize changed files, checks run, results, and remaining risks.

Project-local `AGENTS.md` files may add stricter rules or project-specific commands.

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
