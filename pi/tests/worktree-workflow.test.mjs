import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const resources = [
	".agents/skills/git-worktree/SKILL.md",
	".pi/agent/agents/lead.md",
	".pi/agent/AGENTS.md",
];

// Relocate the Stow packages and HOME so no live configuration is read or changed.
function fixture(t) {
	const directory = mkdtempSync(join(tmpdir(), "pi-worktree-workflow-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const home = join(directory, "test home");
	const checkout = join(directory, "dotfiles checkout");
	mkdirSync(home);
	mkdirSync(checkout);
	for (const entry of ["setup.sh", "bashrc", "tmux", "pi", "codex"]) {
		cpSync(join(repository, entry), join(checkout, entry), { recursive: true, verbatimSymlinks: true });
	}
	return { home, checkout };
}

function setup({ home, checkout }) {
	return spawnSync("bash", [join(checkout, "setup.sh"), "config"], {
		cwd: home,
		env: { ...process.env, HOME: home, DOTFILES: checkout },
		encoding: "utf8",
		timeout: 10_000,
	});
}

test("fresh and repeated setup install workflow resources from a relocated checkout", t => {
	const f = fixture(t);
	for (let attempt = 0; attempt < 2; attempt++) {
		const result = setup(f);
		assert.equal(result.status, 0, result.error?.message ?? result.stderr);
		for (const resource of resources) {
			const installed = join(f.home, resource);
			assert.ok(lstatSync(installed).isSymbolicLink(), resource);
			assert.equal(realpathSync(installed), realpathSync(join(f.checkout, "pi", resource)));
		}
		assert.equal(
			realpathSync(join(f.home, ".codex/AGENTS.md")),
			realpathSync(join(f.home, ".pi/agent/AGENTS.md")),
		);
	}
});

for (const resource of resources.slice(0, 2)) {
	test(`setup preserves an existing regular file at ${resource}`, t => {
		const f = fixture(t);
		const existing = join(f.home, resource);
		mkdirSync(dirname(existing), { recursive: true });
		writeFileSync(existing, "Operator-owned configuration; do not overwrite.\n");
		const source = join(f.checkout, "pi", resource);
		const originalSource = readFileSync(source, "utf8");
		const result = setup(f);
		assert.ifError(result.error);
		assert.notEqual(result.status, 0, "Stow must report the conflict");
		assert.ok(lstatSync(existing).isFile());
		assert.equal(readFileSync(existing, "utf8"), "Operator-owned configuration; do not overwrite.\n");
		assert.equal(readFileSync(source, "utf8"), originalSource);
	});
}

test("policy limits activation to worktree context and explicitly forwards it to children", () => {
	const [skill, lead, instructions] = resources.map(resource =>
		readFileSync(join(repository, "pi", resource), "utf8"),
	);
	const description = skill.match(/^description: (.+)$/m)?.[1];
	assert.ok(description, "Skill discovery needs a description");
	assert.match(description, /Use only for explicit Git worktree requests or continuing an established worktree task/);
	assert.match(description, /Do not use for ordinary Git operations/);
	for (const policy of [skill, lead, instructions]) {
		assert.match(policy, /standalone commit or push requests without worktree context/);
		assert.doesNotMatch(policy, /\/home\/nnofly\//);
	}
	assert.match(instructions, /require the child to read the verified absolute skill path before acting/);
	assert.match(skill, /require the child to read it before acting/);
	assert.match(skill, /Each coordinating child must repeat this handoff/);
	assert.match(lead, /require every child to read that same path before acting/);
	assert.match(skill, /Ask Local merge \/ Create PR only when proposing integration/);
	assert.match(skill, /child with an overridden `HOME` must not derive a different queue/);
	assert.match(skill, /explicit `worktree: false`/);
	assert.match(lead, /^allowedAgents: scout, worker, reviewer$/m);
	assert.match(lead, /^maxSubagentDepth: 2$/m);
});
