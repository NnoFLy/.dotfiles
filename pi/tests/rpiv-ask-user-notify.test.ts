import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createNotifier,
	formatAskUserMessage,
	formatProjectPath,
	isMainSession,
	loadNotificationConfig,
	resolveBackend,
	shouldNotifyCompletion,
} from "../.pi/agent/extensions/rpiv-ask-user-notify.ts";

test("filters child sessions from completion notifications", () => {
	const root = {
		cwd: "/tmp/project",
		sessionManager: { getHeader: () => null },
		isIdle: () => true,
		hasPendingMessages: () => false,
	};
	const child = {
		cwd: "/tmp/project",
		sessionManager: { getHeader: () => ({ parentSession: "/tmp/parent.jsonl" }) },
		isIdle: () => true,
		hasPendingMessages: () => false,
	};
	const previousChild = process.env.PI_SUBAGENT_CHILD;
	const previousParent = process.env.PI_SUBAGENT_PARENT_SESSION;
	try {
		delete process.env.PI_SUBAGENT_CHILD;
		delete process.env.PI_SUBAGENT_PARENT_SESSION;
		assert.equal(isMainSession(root), true);
		assert.equal(isMainSession(child), false);
		assert.equal(isMainSession({ ...child, hasUI: true }), true, "interactive forks are not subagents");
		process.env.PI_SUBAGENT_CHILD = "1";
		assert.equal(isMainSession(root), false);
		assert.equal(shouldNotifyCompletion(root, false), false);
		assert.equal(shouldNotifyCompletion(child, false), false);
		delete process.env.PI_SUBAGENT_CHILD;
		assert.equal(shouldNotifyCompletion(root, true), true);
		assert.equal(shouldNotifyCompletion(root, false), false);
		assert.equal(
			shouldNotifyCompletion({ ...root, hasPendingMessages: () => true }, true),
			false,
		);
	} finally {
		if (previousChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
		else process.env.PI_SUBAGENT_CHILD = previousChild;
		if (previousParent === undefined) delete process.env.PI_SUBAGENT_PARENT_SESSION;
		else process.env.PI_SUBAGENT_PARENT_SESSION = previousParent;
	}
});

test("formats project paths for the notification body", () => {
	assert.equal(formatProjectPath("/home/alice", "/home/alice"), "~");
	assert.equal(formatProjectPath("/home/alice/project", "/home/alice"), "~/project");
	assert.equal(formatProjectPath("/srv/project", "/home/alice"), "/srv/project");
});

test("selects notification backends from the terminal environment", () => {
	assert.equal(resolveBackend("auto", { WT_SESSION: "1" }, "linux"), "powershell");
	assert.equal(resolveBackend("auto", { KITTY_WINDOW_ID: "1" }, "linux"), "osc99");
	assert.equal(resolveBackend("auto", {}, "linux"), "notify-send");
	assert.equal(resolveBackend("auto", {}, "darwin"), "osc777");
	assert.equal(resolveBackend("osc777", { KITTY_WINDOW_ID: "1" }, "linux"), "osc777");
});

test("adds the ask-user header without leaking the full questionnaire by default", () => {
	const prompt = {
		questions: [
			{ header: "Storage", question: "Which storage strategy should we use?" },
			{ header: "Testing", question: "Which tests should be added?" },
		],
	};

	assert.equal(
		formatAskUserMessage("Waiting for your answer", prompt, "header"),
		"Waiting for your answer: Storage (+1 more)",
	);
	assert.equal(
		formatAskUserMessage("Waiting for your answer", prompt, "question"),
		"Waiting for your answer: Which storage strategy should we use? (+1 more)",
	);
	assert.equal(formatAskUserMessage("Waiting for your answer", prompt, "none"), "Waiting for your answer");
});

test("uses the configured backend and suppresses duplicate notifications", async () => {
	const config = loadNotificationConfig("/tmp/project", "/tmp/nonexistent-home");
	config.backend = "notify-send";
	config.dedupeMs = 1_000;
	const calls: Array<{ command: string; args: string[]; timeoutMs: number }> = [];
	const notify = createNotifier(config, {
		env: {},
		platform: "linux",
		now: () => 1_000,
		runCommand: async (command, args, timeoutMs) => {
			calls.push({ command, args, timeoutMs });
		},
	});

	notify("agent_settled", config.done, "Ready for input", "/tmp/project");
	notify("agent_settled", config.done, "Ready for input", "/tmp/project");
	await new Promise((resolve) => setImmediate(resolve));

	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.command, "notify-send");
	assert.ok(calls[0]?.args.includes("--urgency=normal"));
	assert.ok(calls[0]?.args.includes("--icon=dialog-information"));
	assert.ok(calls[0]?.args.includes("Ready for input\n/tmp/project"));
	assert.equal(calls[0]?.timeoutMs, 5_000);
});

test("passes structured payloads to the optional script hook", async () => {
	const config = loadNotificationConfig("/tmp/project", "/tmp/nonexistent-home");
	config.enable = false;
	config.script = "/tmp/notify.sh";
	let payload: { event?: string; cwd?: string; message?: string } | undefined;
	const notify = createNotifier(config, {
		runScript: async (_script, nextPayload) => {
			payload = nextPayload;
		},
	});

	notify("ask_user_blocked", config.askUser, "Waiting for your answer: Storage", "/tmp/project");
	await new Promise((resolve) => setImmediate(resolve));

	assert.deepEqual(payload && { event: payload.event, cwd: payload.cwd, message: payload.message }, {
		event: "ask_user_blocked",
		cwd: "/tmp/project",
		message: "Waiting for your answer: Storage",
	});
});

test("merges global and project notification configuration", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-notify-test-"));
	try {
		await mkdir(join(root, ".pi", "agent", "pi-lab"), { recursive: true });
		await mkdir(join(root, "project", ".pi", "pi-lab"), { recursive: true });
		await writeFile(
			join(root, ".pi", "agent", "pi-lab", "notify.json"),
			JSON.stringify({ notify: { backend: "osc777", diagnostics: true, script: "./global-hook", timeoutMs: 9000, done: { message: "Done" } } }),
		);
		await writeFile(
			join(root, "project", ".pi", "pi-lab", "notify.json"),
			JSON.stringify({ notify: { script: "./repo-hook", diagnostics: false, askUserDetail: "question", done: { icon: "bell" } } }),
		);

		const config = loadNotificationConfig(join(root, "project"), root);
		assert.equal(config.backend, "osc777");
		assert.equal(config.diagnostics, true, "diagnostic logging is controlled by the global user config");
		assert.equal(config.timeoutMs, 9000);
		assert.equal(config.askUserDetail, "question");
		assert.equal(config.done.message, "Done");
		assert.equal(config.done.icon, "bell");
		assert.equal(config.script, join(root, ".pi", "agent", "pi-lab", "global-hook"),
			"relative global hooks must not resolve against the repository cwd");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("project-only scripts are ignored, including when notifications are disabled", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-notify-untrusted-"));
	try {
		const cwd = join(root, "repo");
		await mkdir(join(cwd, ".pi", "pi-lab"), { recursive: true });
		await writeFile(join(cwd, ".pi", "pi-lab", "notify.json"), JSON.stringify({
			notify: { enable: false, diagnostics: true, script: "./repo-owned-script", done: { message: "Local appearance" } },
		}));
		const config = loadNotificationConfig(cwd, join(root, "clean-home"));
		assert.equal(config.script, undefined);
		assert.equal(config.diagnostics, false, "a repository cannot opt the user into diagnostic logging");
		assert.equal(config.done.message, "Local appearance");
		let executions = 0;
		createNotifier(config, { runScript: async () => { executions++; } })(
			"agent_settled", config.done, "Ready for input", cwd,
		);
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(executions, 0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("global home-relative and absolute script paths remain supported", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-notify-global-hook-"));
	try {
		const dir = join(home, ".pi", "agent", "pi-lab");
		await mkdir(dir, { recursive: true });
		for (const [script, expected] of [["~/.local/bin/notify", join(home, ".local/bin/notify")], ["/opt/notify", "/opt/notify"]]) {
			await writeFile(join(dir, "notify.json"), JSON.stringify({ notify: { script } }));
			assert.equal(loadNotificationConfig("/untrusted/repo", home).script, expected);
		}
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("OSC backends and automatic fallback cannot emit controls from notification text", async () => {
	for (const backend of ["osc99", "osc777", "auto"] as const) {
		const config = loadNotificationConfig("/nonexistent-project", "/nonexistent-home");
		config.backend = backend;
		const attack = `S${String.fromCharCode(27, 92, 27)}]52;c;QQ==\x07`;
		assert.equal(attack.length, 15, "the attack fits the question header limit");
		config.askUser.title = `Pi;${attack}\x9c\x9d`;
		const message = formatAskUserMessage("Waiting", { questions: [{ header: attack }] }, "header");
		const writes: string[] = [];
		createNotifier(config, {
			env: {}, platform: "linux", write: text => { writes.push(text); },
			runCommand: async () => { throw new Error("No desktop notification service"); },
		})("ask_user_blocked", config.askUser, message, `/tmp/project${attack}`);
		await new Promise(resolve => setImmediate(resolve));
		const output = writes.join("");
		assert.equal((output.match(/\x1b\]/g) ?? []).length, backend === "osc99" ? 2 : 1);
		assert.equal(output.includes("\x1b]52;"), false);
		assert.equal(/[\x80-\x9f]/.test(output), false);
		assert.equal((output.match(/\x07/g) ?? []).length, backend === "osc99" ? 0 : 1);
		assert.ok(output.includes("\n/tmp/project"), "project formatting remains readable");
		if (backend !== "osc99") assert.equal(output.split(";").length, 4, "OSC 777 field delimiters cannot come from text");
	}
});

test("backend error diagnostics do not echo terminal controls", async t => {
	const config = loadNotificationConfig("/nonexistent-project", "/nonexistent-home");
	config.backend = "notify-send";
	const warnings: string[] = [];
	t.mock.method(console, "warn", (text: string) => { warnings.push(text); });
	createNotifier(config, { runCommand: async () => { throw new Error("failed\x1b]52;c;QQ==\x07"); } })(
		"agent_settled", config.done, "Done", "/tmp/project",
	);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(warnings.length, 1);
	assert.equal(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/.test(warnings[0]), false);
});

test("an early-exiting hook cannot crash the notification host with EPIPE", {
	skip: process.platform !== "linux",
}, () => {
	const plugin = new URL("../.pi/agent/extensions/rpiv-ask-user-notify.ts", import.meta.url).href;
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
		import { loadNotificationConfig, createNotifier } from ${JSON.stringify(plugin)};
		const config = loadNotificationConfig('/nonexistent', '/nonexistent');
		config.enable = false;
		config.script = '/usr/bin/true';
		config.dedupeMs = 0;
		const notify = createNotifier(config, { env: {} });
		for (let i = 0; i < 24; i++) notify('agent_settled', config.done, 'Ready for input', '/tmp');
		notify('agent_settled', config.done, 'x'.repeat(1048576), '/tmp');
	`], { encoding: "utf8", timeout: 10_000 });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stderr.includes("Unhandled 'error' event"), false);
	assert.match(result.stderr, /Pi notification script failed:.*EPIPE/);
});
