import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ASK_USER_PROMPT_EVENT = "rpiv:ask-user:prompt";
const ASK_USER_BLOCKED_EVENT = "rpiv:ask-user:blocked";
const MAX_DETAIL_LENGTH = 160;

export type NotificationBackend = "auto" | "notify-send" | "osc777" | "osc99" | "powershell" | "none";
type Urgency = "low" | "normal" | "critical";
type AskUserDetail = "none" | "header" | "question";

type EventConfig = {
	enabled: boolean;
	title: string;
	message: string;
	urgency: Urgency;
	icon: string;
};

export type NotificationConfig = {
	enable: boolean;
	backend: NotificationBackend;
	tmuxBell: boolean;
	includeProject: boolean;
	askUserDetail: AskUserDetail;
	timeoutMs: number;
	dedupeMs: number;
	script?: string;
	done: EventConfig;
	askUser: EventConfig;
};

type SessionContext = {
	cwd: string;
	sessionManager: {
		getHeader(): { parentSession?: string } | null;
	};
	isIdle(): boolean;
	hasPendingMessages(): boolean;
};

type AskPrompt = {
	questions?: ReadonlyArray<{
		header?: unknown;
		question?: unknown;
	}>;
};

type NotifyEvent = "agent_settled" | "ask_user_blocked";

type NotificationPayload = {
	event: NotifyEvent;
	notificationId: string;
	title: string;
	message: string;
	timestamp: number;
	cwd: string;
	pid: number;
	terminal: Record<string, string | undefined>;
};

type NotifierOptions = {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	now?: () => number;
	runCommand?: (command: string, args: string[], timeoutMs: number) => Promise<void>;
	runScript?: (script: string, payload: NotificationPayload, timeoutMs: number) => Promise<void>;
	write?: (text: string) => void;
};

const DEFAULT_CONFIG: NotificationConfig = {
	enable: true,
	backend: "auto",
	tmuxBell: true,
	includeProject: true,
	askUserDetail: "header",
	timeoutMs: 5_000,
	dedupeMs: 1_500,
	done: {
		enabled: true,
		title: "Pi",
		message: "Ready for input",
		urgency: "normal",
		icon: "dialog-information",
	},
	askUser: {
		enabled: true,
		title: "Pi",
		message: "Waiting for your answer",
		urgency: "critical",
		icon: "dialog-question",
	},
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNotifyConfig(filePath: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
		if (!isRecord(parsed) || !isRecord(parsed.notify)) return {};
		return parsed.notify;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			console.warn(`Pi notification config failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		return {};
	}
}

function asString(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim() ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function asNumber(value: unknown, fallback: number, min: number, max: number): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function asBackend(value: unknown, fallback: NotificationBackend): NotificationBackend {
	return value === "auto" || value === "notify-send" || value === "osc777" || value === "osc99" || value === "powershell" || value === "none"
		? value
		: fallback;
}

function asUrgency(value: unknown, fallback: Urgency): Urgency {
	return value === "low" || value === "normal" || value === "critical" ? value : fallback;
}

function asAskUserDetail(value: unknown, fallback: AskUserDetail): AskUserDetail {
	return value === "none" || value === "header" || value === "question" ? value : fallback;
}

function readEventConfig(value: unknown, fallback: EventConfig): EventConfig {
	const raw = isRecord(value) ? value : {};
	return {
		enabled: asBoolean(raw.enabled, fallback.enabled),
		title: asString(raw.title, fallback.title),
		message: asString(raw.message, fallback.message),
		urgency: asUrgency(raw.urgency, fallback.urgency),
		icon: asString(raw.icon, fallback.icon),
	};
}

function resolveScriptPath(value: unknown, cwd: string, home: string): string | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	if (value === "~") return home;
	if (value.startsWith("~/")) return join(home, value.slice(2));
	return isAbsolute(value) ? value : resolve(cwd, value);
}

export function loadNotificationConfig(cwd: string, home = homedir()): NotificationConfig {
	const globalConfig = readNotifyConfig(join(home, ".pi", "agent", "pi-lab", "notify.json"));
	const localConfig = readNotifyConfig(join(cwd, ".pi", "pi-lab", "notify.json"));
	const mergedDone = { ...(isRecord(globalConfig.done) ? globalConfig.done : {}), ...(isRecord(localConfig.done) ? localConfig.done : {}) };
	const mergedAskUser = { ...(isRecord(globalConfig.askUser) ? globalConfig.askUser : {}), ...(isRecord(localConfig.askUser) ? localConfig.askUser : {}) };
	const raw = { ...globalConfig, ...localConfig };

	return {
		enable: asBoolean(raw.enable, DEFAULT_CONFIG.enable),
		backend: asBackend(raw.backend, DEFAULT_CONFIG.backend),
		tmuxBell: asBoolean(raw.tmuxBell, DEFAULT_CONFIG.tmuxBell),
		includeProject: asBoolean(raw.includeProject, DEFAULT_CONFIG.includeProject),
		askUserDetail: asAskUserDetail(raw.askUserDetail, DEFAULT_CONFIG.askUserDetail),
		timeoutMs: asNumber(raw.timeoutMs, DEFAULT_CONFIG.timeoutMs, 100, 30_000),
		dedupeMs: asNumber(raw.dedupeMs, DEFAULT_CONFIG.dedupeMs, 0, 60_000),
		script: resolveScriptPath(raw.script, cwd, home),
		done: readEventConfig(mergedDone, DEFAULT_CONFIG.done),
		askUser: readEventConfig(mergedAskUser, DEFAULT_CONFIG.askUser),
	};
}

export function isMainSession(ctx: SessionContext, env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.PI_SUBAGENT_CHILD === "1" || env.PI_SUBAGENT_PARENT_SESSION) return false;
	return !ctx.sessionManager.getHeader()?.parentSession;
}

export function shouldNotifyCompletion(ctx: SessionContext, mainSession: boolean): boolean {
	return mainSession && ctx.isIdle() && !ctx.hasPendingMessages();
}

export function formatProjectPath(cwd: string, home = homedir()): string {
	if (cwd === home) return "~";
	if (cwd.startsWith(`${home}/`)) return `~/${cwd.slice(home.length + 1)}`;
	return cwd;
}

export function resolveBackend(
	backend: NotificationBackend,
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): Exclude<NotificationBackend, "auto"> {
	if (backend !== "auto") return backend;
	if (env.WT_SESSION || platform === "win32") return "powershell";
	if (env.KITTY_WINDOW_ID) return "osc99";
	if (platform === "linux") return "notify-send";
	return "osc777";
}

function normalizeDetail(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const detail = value.replace(/\s+/g, " ").trim();
	return detail ? detail.slice(0, MAX_DETAIL_LENGTH) : undefined;
}

export function formatAskUserMessage(base: string, prompt: AskPrompt | undefined, detail: AskUserDetail): string {
	if (!prompt || detail === "none" || !Array.isArray(prompt.questions) || prompt.questions.length === 0) return base;
	const first = prompt.questions[0];
	const selected = detail === "header" ? normalizeDetail(first.header) ?? normalizeDetail(first.question) : normalizeDetail(first.question);
	if (!selected) return base;
	const suffix = prompt.questions.length > 1 ? ` (+${prompt.questions.length - 1} more)` : "";
	return `${base}: ${selected}${suffix}`;
}

function terminalContext(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
	return {
		term: env.TERM,
		termProgram: env.TERM_PROGRAM,
		kittyWindowId: env.KITTY_WINDOW_ID,
		weztermPane: env.WEZTERM_PANE,
		wtSession: env.WT_SESSION,
		tmux: env.TMUX,
	};
}

function runCommand(command: string, args: string[], timeoutMs: number): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		execFile(command, args, { timeout: timeoutMs, windowsHide: true, stdio: "ignore" }, (error) => {
			if (error) reject(error);
			else resolvePromise();
		});
	});
}

function runScript(script: string, payload: NotificationPayload, timeoutMs: number): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		const child = execFile(script, [], { timeout: timeoutMs, windowsHide: true, stdio: ["pipe", "ignore", "ignore"] }, (error) => {
			if (error) reject(error);
			else resolvePromise();
		});
		child.stdin?.end(JSON.stringify(payload));
	});
}

function escapePowerShell(value: string): string {
	return value.replaceAll("'", "''");
}

function powershellToast(title: string, body: string): string {
	const type = "Windows.UI.Notifications";
	const manager = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
	return [
		`${manager} > $null`,
		`$xml = [${type}.ToastNotificationManager]::GetTemplateContent([${type}.ToastTemplateType]::ToastText01)`,
		`$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${escapePowerShell(body)}')) > $null`,
		`[${type}.ToastNotificationManager]::CreateToastNotifier('${escapePowerShell(title)}').Show([${type}.ToastNotification]::new($xml))`,
	].join("; ");
}

async function sendBackend(
	backend: Exclude<NotificationBackend, "auto">,
	eventConfig: EventConfig,
	body: string,
	timeoutMs: number,
	run: (command: string, args: string[], timeoutMs: number) => Promise<void>,
	write: (text: string) => void,
): Promise<void> {
	switch (backend) {
		case "none":
			return;
		case "notify-send":
			await run(
				"notify-send",
				["--app-name=Pi", `--urgency=${eventConfig.urgency}`, `--icon=${eventConfig.icon}`, "--", eventConfig.title, body],
				timeoutMs,
			);
			return;
		case "powershell":
			await run("powershell.exe", ["-NoProfile", "-Command", powershellToast(eventConfig.title, body)], timeoutMs);
			return;
		case "osc99":
			write(`\x1b]99;i=1:d=0;${eventConfig.title}\x1b\\`);
			write(`\x1b]99;i=1:p=body;${body}\x1b\\`);
			return;
		case "osc777":
			write(`\x1b]777;notify;${eventConfig.title};${body}\x07`);
			return;
	}
}

function sendTmuxBell(env: NodeJS.ProcessEnv, write: (text: string) => void): void {
	if (env.TMUX) write("\x07");
}

function notifyId(event: NotifyEvent, timestamp: number): string {
	return `pi-${event}-${timestamp}`;
}

function createPayload(
	event: NotifyEvent,
	eventConfig: EventConfig,
	message: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
	timestamp: number,
): NotificationPayload {
	return {
		event,
		notificationId: notifyId(event, timestamp),
		title: eventConfig.title,
		message,
		timestamp,
		cwd,
		pid: process.pid,
		terminal: terminalContext(env),
	};
}

function eventBackendError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function createNotifier(config: NotificationConfig, options: NotifierOptions = {}) {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const nowFn = options.now ?? Date.now;
	const run = options.runCommand ?? runCommand;
	const runScriptFn = options.runScript ?? runScript;
	const write = options.write ?? ((text: string) => process.stdout.write(text));
	const recent = new Map<string, number>();

	return (event: NotifyEvent, eventConfig: EventConfig, message: string, cwd: string): void => {
		if (!eventConfig.enabled || (!config.enable && !config.script)) return;
		const now = nowFn();
		const key = `${event}:${cwd}:${message}`;
		const previous = recent.get(key);
		if (previous !== undefined && now - previous < config.dedupeMs) return;
		recent.set(key, now);

		const payload = createPayload(event, eventConfig, message, cwd, env, now);
		const body = config.includeProject ? `${message}\n${formatProjectPath(cwd)}` : message;
		const requestedBackend = resolveBackend(config.backend, env, platform);

		void (async () => {
			if (config.enable) {
				try {
					await sendBackend(requestedBackend, eventConfig, body, config.timeoutMs, run, write);
					if (config.tmuxBell) sendTmuxBell(env, write);
				} catch (error) {
					if (config.backend === "auto" && requestedBackend !== "osc777") {
						try {
							await sendBackend("osc777", eventConfig, body, config.timeoutMs, run, write);
							if (config.tmuxBell) sendTmuxBell(env, write);
						} catch (fallbackError) {
							console.warn(`Pi notification failed: ${eventBackendError(fallbackError)}`);
						}
					} else {
						console.warn(`Pi notification failed: ${eventBackendError(error)}`);
					}
				}
			}

			if (config.script) {
				try {
					await runScriptFn(config.script, payload, config.timeoutMs);
				} catch (error) {
					console.warn(`Pi notification script failed: ${eventBackendError(error)}`);
				}
			}
		})();
	};
}

export default function (pi: ExtensionAPI) {
	let mainSession = false;
	let currentCwd = process.cwd();
	let config = loadNotificationConfig(currentCwd);
	let notify = createNotifier(config);
	let pendingPrompt: AskPrompt | undefined;

	pi.on("session_start", (_event, ctx) => {
		currentCwd = ctx.cwd;
		mainSession = isMainSession(ctx);
		config = loadNotificationConfig(ctx.cwd);
		notify = createNotifier(config);
		pendingPrompt = undefined;
	});

	// Keep the session classification from session_start. During subagent work,
	// the settlement context can belong to the parent runner, while the child
	// session itself must remain silent.
	pi.on("agent_settled", (_event, ctx) => {
		if (shouldNotifyCompletion(ctx, mainSession)) notify("agent_settled", config.done, config.done.message, ctx.cwd);
	});

	pi.events.on(ASK_USER_PROMPT_EVENT, (data) => {
		if (mainSession && isRecord(data)) pendingPrompt = data as AskPrompt;
	});

	pi.events.on(ASK_USER_BLOCKED_EVENT, (data) => {
		if (!mainSession || !isRecord(data)) return;
		if (data.active === true) {
			const message = formatAskUserMessage(config.askUser.message, pendingPrompt, config.askUserDetail);
			notify("ask_user_blocked", config.askUser, message, currentCwd);
		} else if (data.active === false) {
			pendingPrompt = undefined;
		}
	});
}
