import { closeSync, constants, fchmodSync, fstatSync, ftruncateSync, mkdirSync, openSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const MAX_DIAGNOSTIC_BYTES = 256 * 1024;

const EVENTS = ["session_start", "agent_start", "subagents_ready", "agent_settled", "ask_user_blocked"] as const;
const PHASES = ["lifecycle", "gate", "dispatch", "suppressed"] as const;
const REASONS = ["loaded", "started", "ready", "not-main", "aborted", "busy", "pending-messages", "outcome", "missing-liveness", "outstanding-work", "liveness-error", "clear", "disabled", "deduped"] as const;
const BACKENDS = ["auto", "none", "notify-send", "osc99", "osc777", "powershell"] as const;
const OUTCOMES = ["completed", "aborted", "error"] as const;
const FLAGS = ["mainSession", "idle", "pendingMessages", "aborted", "subagentsAvailable", "outstandingWork", "desktopEnabled", "scriptEnabled"] as const;

export type NotificationDiagnostic = {
	event: typeof EVENTS[number];
	phase: typeof PHASES[number];
	reason?: typeof REASONS[number];
	sessionId?: string;
	notificationId?: string;
	backend?: typeof BACKENDS[number];
	outcome?: typeof OUTCOMES[number];
} & Partial<Record<typeof FLAGS[number], boolean>>;

/** Opt-in metadata only. Logging failures must never change notification behavior. */
export function createNotificationDiagnostics(enabled: boolean, home = homedir()) {
	const directory = join(home, ".local", "state", "pi-notify");
	const path = join(directory, "notification-events.jsonl");
	let warned = false;

	return (entry: NotificationDiagnostic): void => {
		if (!enabled || !EVENTS.includes(entry.event) || !PHASES.includes(entry.phase)) return;
		// Explicit allowlist: never persist payloads, paths, questionnaire text, or errors.
		const row: Record<string, string | number | boolean> = {
			time: new Date().toISOString(), pid: process.pid, event: entry.event, phase: entry.phase,
		};
		if (entry.reason && REASONS.includes(entry.reason)) row.reason = entry.reason;
		if (entry.backend && BACKENDS.includes(entry.backend)) row.backend = entry.backend;
		if (entry.outcome && OUTCOMES.includes(entry.outcome)) row.outcome = entry.outcome;
		if (typeof entry.sessionId === "string" && /^[a-zA-Z0-9-]{1,128}$/.test(entry.sessionId)) row.sessionId = entry.sessionId;
		if (typeof entry.notificationId === "string" && /^pi-(agent_settled|ask_user_blocked)-\d+$/.test(entry.notificationId)) row.notificationId = entry.notificationId;
		for (const key of FLAGS) if (typeof entry[key] === "boolean") row[key] = entry[key];

		try {
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
			try {
				fchmodSync(fd, 0o600);
				const line = `${JSON.stringify(row)}\n`;
				// Best-effort shared-process cap. Old diagnostics, not notifications,
				// are discarded when full; each append is one small atomic write.
				if (fstatSync(fd).size + Buffer.byteLength(line) > MAX_DIAGNOSTIC_BYTES) ftruncateSync(fd, 0);
				writeSync(fd, line);
			} finally {
				closeSync(fd);
			}
		} catch {
			if (!warned) {
				console.warn("Pi notification diagnostics unavailable; notification behavior is unchanged.");
				warned = true;
			}
		}
	};
}
