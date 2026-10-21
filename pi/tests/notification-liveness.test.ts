import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerNotifications, { isMainSession, shouldNotifyCompletion } from "../.pi/agent/extensions/rpiv-ask-user-notify.ts";
import { installSessionLivenessMonitor } from "../.pi/agent/pi-lab/notification-liveness.ts";

const SUBAGENTS_LIVENESS_PATH = join(homedir(), ".pi/agent/npm/node_modules/pi-subagents/src/integrations/pi-web-session-liveness.js");

const REGISTRY_KEY = Symbol.for("@agegr/pi-web/session-liveness/v1");
const MONITOR_KEY = Symbol.for("nnofly.pi-notify.session-liveness/v1");
type Provider = { name: string; sessionId: string; isActive(): boolean };
type Registry = { version: number; register(provider: Provider): () => void };
type Host = { [key: symbol]: unknown };

function registry(host: Host): Registry {
	return host[REGISTRY_KEY] as Registry;
}

function context(sessionId = "parent", parentSession?: string, hasUI = true) {
	return {
		cwd: "/project",
		hasUI,
		sessionManager: {
			getHeader: () => parentSession ? { parentSession } : {},
			getSessionId: () => sessionId,
		},
		isIdle: () => true,
		hasPendingMessages: () => false,
	};
}

test("completion requires a non-aborted, idle main session without queued messages", () => {
	const ctx = context();
	assert.equal(shouldNotifyCompletion(ctx, true), true);
	assert.equal(shouldNotifyCompletion(ctx, false), false);
	assert.equal(shouldNotifyCompletion(ctx, true, true), false);
	assert.equal(shouldNotifyCompletion({ ...ctx, isIdle: () => false }, true), false);
	assert.equal(shouldNotifyCompletion({ ...ctx, hasPendingMessages: () => true }, true), false);
	assert.equal(isMainSession(ctx, {}), true);
	assert.equal(isMainSession(context("fork", "parent"), {}), true);
	assert.equal(isMainSession(context("child", "parent", false), {}), false);
	assert.equal(isMainSession(ctx, { PI_SUBAGENT_CHILD: "1" }), false);
	assert.equal(isMainSession(ctx, { PI_SUBAGENT_PARENT_SESSION: "parent" }), false);
});

test("liveness is session-scoped, observes replacement work, and releases registrations", () => {
	const host: Host = {};
	const monitor = installSessionLivenessMonitor(host);
	assert.equal(monitor.hasActiveWork("parent", false), false);
	assert.equal(monitor.hasActiveWork("parent", true), true, "known subagents without a provider must fail closed");
	let active = true;
	const release = registry(host).register({ name: "pi-subagents", sessionId: "parent", isActive: () => active });
	registry(host).register({ name: "pi-subagents", sessionId: "other", isActive: () => true });
	assert.equal(monitor.hasActiveWork("parent", true), true);
	active = false;
	assert.equal(monitor.hasActiveWork("parent", true), false);
	active = true;
	assert.equal(monitor.hasActiveWork("parent", true), true);
	release();
	release();
	assert.equal(monitor.hasActiveWork("parent", false), false);
	assert.equal(monitor.hasActiveWork("parent", true), true);
});

test("reload reuses the monitor and retains already registered work", () => {
	const host: Host = {};
	const first = installSessionLivenessMonitor(host);
	registry(host).register({ name: "pi-subagents", sessionId: "parent", isActive: () => true });
	const second = installSessionLivenessMonitor(host);
	assert.equal(first, second);
	assert.equal(second.hasActiveWork("parent", true), true);
});

test("an existing host retains registry identity, receiver, and disposal behavior", () => {
	let disposed = 0;
	const original = {
		version: 1,
		marker: "host",
		register(this: { marker: string }, _provider: Provider) {
			assert.equal(this.marker, "host");
			return () => { disposed++; };
		},
	};
	const host: Host = { [REGISTRY_KEY]: original };
	const monitor = installSessionLivenessMonitor(host);
	assert.equal(host[REGISTRY_KEY], original);
	const provider = { name: "pi-subagents", sessionId: "parent", isActive: () => true };
	const releaseFirst = original.register(provider);
	const releaseSecond = original.register(provider);
	releaseFirst();
	releaseFirst();
	assert.equal(disposed, 1);
	assert.equal(monitor.hasActiveWork("parent", true), true, "duplicate registrations have independent lifetimes");
	releaseSecond();
	assert.equal(disposed, 2);
	assert.equal(monitor.hasActiveWork("parent", false), false);
});

test("unsupported or replaced registries and broken providers cannot report completion", () => {
	assert.throws(() => installSessionLivenessMonitor({ [REGISTRY_KEY]: { version: 2 } }), /Unsupported/);
	const frozen = Object.freeze({ version: 1, register: () => () => {} });
	assert.throws(() => installSessionLivenessMonitor({ [REGISTRY_KEY]: frozen }), TypeError);
	const host: Host = {};
	const monitor = installSessionLivenessMonitor(host);
	const release = registry(host).register({ name: "pi-subagents", sessionId: "parent", isActive() { throw new Error("broken"); } });
	assert.throws(() => monitor.hasActiveWork("parent", true), /broken/);
	release();
	registry(host).register({ name: "pi-subagents", sessionId: "parent", isActive: () => undefined as unknown as boolean });
	assert.equal(monitor.hasActiveWork("parent", true), true);
	host[REGISTRY_KEY] = { version: 1, register: () => () => {} };
	assert.throws(() => monitor.hasActiveWork("parent", true), /registry changed/);
});

function fixture(t: TestContext, options: { child?: boolean; unsupportedRegistry?: boolean; diagnostics?: boolean } = {}) {
	const host: Host = globalThis;
	const savedRegistry = host[REGISTRY_KEY];
	const savedMonitor = host[MONITOR_KEY];
	delete host[REGISTRY_KEY];
	delete host[MONITOR_KEY];
	if (options.unsupportedRegistry) host[REGISTRY_KEY] = { version: 2 };
	const home = mkdtempSync(join(tmpdir(), "pi-notify-test-"));
	const savedCwd = process.cwd();
	const savedEnv = Object.fromEntries(["HOME", "PI_SUBAGENT_CHILD", "PI_SUBAGENT_PARENT_SESSION"].map(key => [key, process.env[key]]));
	process.env.HOME = home;
	delete process.env.PI_SUBAGENT_CHILD;
	delete process.env.PI_SUBAGENT_PARENT_SESSION;
	process.chdir(home);
	mkdirSync(join(home, ".pi", "agent", "pi-lab"), { recursive: true });
	writeFileSync(join(home, ".pi", "agent", "pi-lab", "notify.json"), JSON.stringify({ notify: {
		backend: "osc777", diagnostics: options.diagnostics ?? false, tmuxBell: false, includeProject: false, dedupeMs: 0,
	} }));

	const notifications: string[] = [];
	const warnings: unknown[][] = [];
	const write = process.stdout.write;
	t.mock.method(process.stdout, "write", (chunk: string | Uint8Array, ...args: unknown[]) => {
		if (typeof chunk === "string" && chunk.startsWith("\x1b]777;notify;")) {
			notifications.push(chunk);
			return true;
		}
		return Reflect.apply(write, process.stdout, [chunk, ...args]);
	});
	t.mock.method(console, "warn", (...args: unknown[]) => { warnings.push(args); });
	t.after(() => {
		process.chdir(savedCwd);
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		if (savedRegistry === undefined) delete host[REGISTRY_KEY];
		else host[REGISTRY_KEY] = savedRegistry;
		if (savedMonitor === undefined) delete host[MONITOR_KEY];
		else host[MONITOR_KEY] = savedMonitor;
		rmSync(home, { recursive: true, force: true });
	});

	const bus = new EventEmitter();
	const handlers = new Map<string, ((event: unknown, ctx: ReturnType<typeof context>) => unknown)[]>();
	const pi = {
		on(name: string, handler: (event: unknown, ctx: ReturnType<typeof context>) => unknown) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
			return () => {};
		},
		events: {
			on(name: string, handler: (data: unknown) => void) { bus.on(name, handler); return () => bus.off(name, handler); },
			emit(name: string, data: unknown) { bus.emit(name, data); },
		},
	};
	registerNotifications(pi as unknown as ExtensionAPI);
	const ctx = { ...context(options.child ? "child" : "parent", options.child ? "parent" : undefined, !options.child), cwd: home };
	const emit = (name: string, event: unknown = {}, eventCtx = ctx) => {
		for (const handler of handlers.get(name) ?? []) handler(event, eventCtx);
	};
	emit("session_start");
	return { bus, emit, ctx, notifications, warnings, host };
}

test("ordinary parent completion still notifies without subagents installed", t => {
	const f = fixture(t);
	f.emit("agent_settled", { aborted: false });
	assert.equal(f.notifications.length, 1);
	assert.match(f.notifications[0], /Ready for input/);
});

test("delegation stays silent until results and wake are consumed and the parent settles", {
	skip: !existsSync(SUBAGENTS_LIVENESS_PATH),
}, async t => {
	const f = fixture(t);
	// Exercise the installed package's real registration contract and work predicate.
	const { registerPiWebSessionLiveness, hasLiveSubagentWork } = await import(pathToFileURL(SUBAGENTS_LIVENESS_PATH).href);
	const jobs = new Map([["run", { status: "queued" }]]);
	const state = { asyncJobs: jobs, foregroundControls: new Map(), retainedForegroundNestedRoutes: new Map() };
	let owedResult = false;
	let pendingDelivery = false;
	let pendingWake = false;
	const handle = registerPiWebSessionLiveness({ sessionId: "parent", isActive: () =>
		owedResult || hasLiveSubagentWork(state) || pendingDelivery || pendingWake,
	});
	assert.equal(handle.registered, true);
	f.bus.emit("subagents:rpc:v1:ready", {});
	f.emit("agent_settled", { aborted: false });
	jobs.set("run", { status: "running" });
	f.emit("agent_settled", { aborted: false });
	jobs.set("run", { status: "completed" });
	owedResult = true;
	f.emit("agent_settled", { aborted: false });
	owedResult = false;
	pendingDelivery = true;
	f.emit("agent_settled", { aborted: false });
	pendingDelivery = false;
	pendingWake = true;
	f.emit("agent_settled", { aborted: false });
	assert.equal(f.notifications.length, 0);
	pendingWake = false;
	assert.equal(f.notifications.length, 0, "a child finishing does not itself notify");
	f.emit("agent_settled", { aborted: false });
	assert.equal(f.notifications.length, 1);
	handle.release();
});

test("questions notify while background work remains, but prompt and unblock events do not", t => {
	const f = fixture(t);
	registry(f.host).register({ name: "pi-subagents", sessionId: "parent", isActive: () => true });
	f.bus.emit("subagents:rpc:v1:ready", {});
	f.bus.emit("rpiv:ask-user:prompt", { questions: [{ header: "Choose scope", question: "Which files?" }] });
	assert.equal(f.notifications.length, 0);
	f.bus.emit("rpiv:ask-user:blocked", { active: true, toolCallId: "ask-1" });
	assert.equal(f.notifications.length, 1);
	assert.match(f.notifications[0], /Waiting for your answer: Choose scope/);
	f.bus.emit("rpiv:ask-user:blocked", { active: false, toolCallId: "ask-1" });
	f.emit("agent_settled", { aborted: false });
	assert.equal(f.notifications.length, 1);
});

test("aborts, queued messages, and child sessions remain silent", t => {
	const f = fixture(t);
	f.emit("agent_settled", { aborted: true });
	f.emit("agent_settled", { aborted: false }, { ...f.ctx, hasPendingMessages: () => true });
	assert.equal(f.notifications.length, 0);
	f.emit("session_start", {}, { ...context("child", "parent", false), cwd: f.ctx.cwd });
	f.emit("agent_settled", { aborted: false }, f.ctx);
	f.bus.emit("rpiv:ask-user:blocked", { active: true });
	assert.equal(f.notifications.length, 0);
});

test("missing or broken liveness suppresses completion without disabling questions", t => {
	const f = fixture(t);
	f.bus.emit("subagents:rpc:v1:ready", {});
	f.emit("agent_settled", { aborted: false });
	assert.equal(f.notifications.length, 0);
	registry(f.host).register({ name: "pi-subagents", sessionId: "parent", isActive() { throw new Error("broken provider"); } });
	f.emit("agent_settled", { aborted: false });
	f.emit("agent_settled", { aborted: false });
	assert.equal(f.warnings.length, 1, "warn once per session, not on every settlement");
	f.bus.emit("rpiv:ask-user:blocked", { active: true });
	assert.equal(f.notifications.length, 1);
	assert.match(f.notifications[0], /Waiting for your answer/);
});

test("unsupported host liveness fails closed but preserves question alerts", t => {
	const f = fixture(t, { unsupportedRegistry: true });
	f.emit("agent_settled", { aborted: false });
	assert.equal(f.notifications.length, 0);
	assert.equal(f.warnings.length, 1);
	f.bus.emit("rpiv:ask-user:blocked", { active: true });
	assert.equal(f.notifications.length, 1);
});

test("interactive forks retain both completion and question notifications", t => {
	const f = fixture(t);
	const fork = { ...context("fork", "parent", true), cwd: f.ctx.cwd };
	f.emit("session_start", {}, fork);
	f.emit("agent_settled", { aborted: false }, fork);
	assert.equal(f.notifications.length, 1);
	f.bus.emit("rpiv:ask-user:blocked", { active: true });
	assert.equal(f.notifications.length, 2);
});

test("explicit child environment markers take precedence over a user-facing context", t => {
	const f = fixture(t);
	process.env.PI_SUBAGENT_CHILD = "1";
	f.emit("session_start");
	f.emit("agent_settled", { aborted: false });
	f.bus.emit("rpiv:ask-user:blocked", { active: true });
	assert.equal(f.notifications.length, 0);
});

test("error and aborted outcomes stay silent; a successful retry can complete", t => {
	const f = fixture(t);
	f.emit("agent_start");
	f.emit("agent_before_settle", { outcome: "error" });
	f.emit("agent_settled", { aborted: false });
	assert.equal(f.notifications.length, 0, "provider errors are not completion");
	f.bus.emit("rpiv:ask-user:blocked", { active: true });
	assert.equal(f.notifications.length, 1, "questions remain independent of outcome");
	f.emit("agent_before_settle", { outcome: "completed" });
	f.emit("agent_settled", { aborted: false });
	assert.equal(f.notifications.length, 2, "a successful continuation replaces the earlier error outcome");
	f.emit("agent_start");
	f.emit("agent_before_settle", { outcome: "aborted" });
	f.emit("agent_settled", { aborted: false });
	assert.equal(f.notifications.length, 2);
	f.emit("agent_start");
	f.emit("agent_before_settle", { outcome: "completed" });
	f.emit("agent_settled", { aborted: false });
	assert.equal(f.notifications.length, 3, "a later successful run is not silenced by an old failure");
});

test("opt-in diagnostics correlate completion gates and real dispatch attempts without prompt text", t => {
	const f = fixture(t, { diagnostics: true });
	const path = join(f.ctx.cwd, ".local", "state", "pi-notify", "notification-events.jsonl");
	const rows = () => readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
	assert.equal(rows()[0].reason, "loaded");
	let active = true;
	registry(f.host).register({ name: "pi-subagents", sessionId: "parent", isActive: () => active });
	f.bus.emit("subagents:rpc:v1:ready", {});
	f.emit("agent_start");
	f.emit("agent_settled", { aborted: false });
	assert.equal(rows().at(-1).reason, "outstanding-work");
	assert.equal(rows().at(-1).outstandingWork, true);
	assert.equal(rows().filter(row => row.phase === "dispatch").length, 0);
	active = false;
	f.emit("agent_settled", { aborted: false });
	assert.equal(rows().at(-2).reason, "clear");
	assert.equal(rows().at(-1).phase, "dispatch");
	f.bus.emit("rpiv:ask-user:prompt", { questions: [{ header: "PRIVATE QUESTION" }] });
	f.bus.emit("rpiv:ask-user:blocked", { active: true });
	assert.equal(rows().filter(row => row.phase === "dispatch").length, 2);
	assert.ok(rows().every(row => row.pid === process.pid && row.sessionId === "parent"));
	assert.equal(readFileSync(path, "utf8").includes("PRIVATE QUESTION"), false);
	assert.equal(readFileSync(path, "utf8").includes(f.ctx.cwd), false);
});

test("diagnostic I/O failures do not suppress notifications or leak errors", t => {
	const f = fixture(t, { diagnostics: true });
	const path = join(f.ctx.cwd, ".local", "state", "pi-notify", "notification-events.jsonl");
	rmSync(path);
	mkdirSync(path);
	f.emit("agent_settled", { aborted: false });
	assert.equal(f.notifications.length, 1);
	assert.equal(f.warnings.length, 1);
	assert.match(String(f.warnings[0][0]), /diagnostics unavailable/);
	assert.equal(String(f.warnings[0][0]).includes(f.ctx.cwd), false);
});
