import assert from "node:assert/strict";
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
			JSON.stringify({ notify: { backend: "osc777", timeoutMs: 9000, done: { message: "Done" } } }),
		);
		await writeFile(
			join(root, "project", ".pi", "pi-lab", "notify.json"),
			JSON.stringify({ notify: { askUserDetail: "question", done: { icon: "bell" } } }),
		);

		const config = loadNotificationConfig(join(root, "project"), root);
		assert.equal(config.backend, "osc777");
		assert.equal(config.timeoutMs, 9000);
		assert.equal(config.askUserDetail, "question");
		assert.equal(config.done.message, "Done");
		assert.equal(config.done.icon, "bell");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
