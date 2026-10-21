import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createNotificationDiagnostics, MAX_DIAGNOSTIC_BYTES } from "../.pi/agent/pi-lab/notification-diagnostics.ts";

function fixture(t: TestContext) {
	const home = mkdtempSync(join(tmpdir(), "pi-diagnostics-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const directory = join(home, ".local", "state", "pi-notify");
	return { home, directory, path: join(directory, "notification-events.jsonl") };
}

test("disabled diagnostics do not create any files", t => {
	const f = fixture(t);
	createNotificationDiagnostics(false, f.home)({ event: "session_start", phase: "lifecycle", reason: "loaded" });
	assert.equal(existsSync(f.directory), false);
});

test("diagnostics persist only allowlisted metadata in a private file", t => {
	const f = fixture(t);
	const log = createNotificationDiagnostics(true, f.home);
	const entry = {
		event: "agent_settled" as const, phase: "gate" as const, reason: "outstanding-work" as const,
		sessionId: "session-1", notificationId: "pi-agent_settled-123", mainSession: true, outstandingWork: true,
		message: "PRIVATE QUESTION", cwd: "/private/project", credentials: "SECRET", error: "PRIVATE ERROR",
	};
	log(entry);
	const text = readFileSync(f.path, "utf8");
	const row = JSON.parse(text);
	assert.equal(row.sessionId, "session-1");
	assert.equal(row.pid, process.pid);
	assert.equal(row.outstandingWork, true);
	assert.equal(row.reason, "outstanding-work");
	assert.ok(Number.isFinite(Date.parse(row.time)));
	assert.equal(/PRIVATE|SECRET|\/private/.test(text), false);
	assert.equal(statSync(f.path).mode & 0o777, 0o600);
	assert.equal(statSync(f.directory).mode & 0o777, 0o700);
	log({ ...entry, sessionId: "/private/session-path", notificationId: "PRIVATE-NOTIFICATION" });
	const second = JSON.parse(readFileSync(f.path, "utf8").trim().split("\n")[1]);
	assert.equal(second.sessionId, undefined);
	assert.equal(second.notificationId, undefined);
});

test("full logs discard old diagnostics and repair permissive file modes", t => {
	const f = fixture(t);
	mkdirSync(f.directory, { recursive: true });
	writeFileSync(f.path, "x".repeat(MAX_DIAGNOSTIC_BYTES));
	chmodSync(f.path, 0o644);
	createNotificationDiagnostics(true, f.home)({ event: "session_start", phase: "lifecycle", reason: "loaded" });
	assert.ok(statSync(f.path).size < MAX_DIAGNOSTIC_BYTES);
	assert.equal(statSync(f.path).mode & 0o777, 0o600);
	assert.equal(JSON.parse(readFileSync(f.path, "utf8")).reason, "loaded");
});

test("a symlink log is refused and failures warn once without throwing", t => {
	const f = fixture(t);
	mkdirSync(f.directory, { recursive: true });
	const target = join(f.home, "unrelated-file");
	writeFileSync(target, "unchanged");
	symlinkSync(target, f.path);
	let warnings = 0;
	t.mock.method(console, "warn", () => { warnings++; });
	const log = createNotificationDiagnostics(true, f.home);
	for (let i = 0; i < 2; i++) assert.doesNotThrow(() => log({ event: "agent_start", phase: "lifecycle", reason: "started" }));
	assert.equal(warnings, 1);
	assert.equal(readFileSync(target, "utf8"), "unchanged");
});

test("different Pi processes can append complete records to the same log", async t => {
	const f = fixture(t);
	const module = new URL("../.pi/agent/pi-lab/notification-diagnostics.ts", import.meta.url).href;
	const code = `
		import { createNotificationDiagnostics } from ${JSON.stringify(module)};
		const log = createNotificationDiagnostics(true, ${JSON.stringify(f.home)});
		for (let i = 0; i < 20; i++) log({ event: 'agent_start', phase: 'lifecycle', reason: 'started', sessionId: 'session-' + process.pid });
	`;
	await Promise.all([0, 1].map(() => new Promise<void>((resolve, reject) => {
		execFile(process.execPath, ["--input-type=module", "-e", code], error => error ? reject(error) : resolve());
	})));
	const rows = readFileSync(f.path, "utf8").trim().split("\n").map(line => JSON.parse(line));
	assert.equal(rows.length, 40);
	assert.equal(new Set(rows.map(row => row.pid)).size, 2);
});
