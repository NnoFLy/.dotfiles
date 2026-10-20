// pi-subagents publishes its authoritative work/result-delivery predicate through
// this documented host contract. Install before session_start, when it registers.
const REGISTRY_KEY = Symbol.for("@agegr/pi-web/session-liveness/v1");
const MONITOR_KEY = Symbol.for("nnofly.pi-notify.session-liveness/v1");

type Provider = {
	name: string;
	sessionId: string;
	isActive(): boolean;
};

type Registry = {
	version: number;
	register(provider: Provider): () => void;
};

type GlobalRegistry = { [key: symbol]: unknown };

export type SessionLivenessMonitor = {
	hasActiveWork(sessionId: string, requireSubagents: boolean): boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Share one registration observer across extension reloads and in-process children. */
export function installSessionLivenessMonitor(host: GlobalRegistry = globalThis): SessionLivenessMonitor {
	const existing = host[REGISTRY_KEY];
	if (existing !== undefined && (!isRecord(existing) || existing.version !== 1 || typeof existing.register !== "function")) {
		throw new Error("Unsupported session-liveness registry; completion alerts are disabled.");
	}

	const cached = host[MONITOR_KEY];
	if (isRecord(cached) && cached.registry === existing && isRecord(existing) && cached.register === existing.register
		&& typeof cached.hasActiveWork === "function") {
		return cached as SessionLivenessMonitor;
	}

	const registry = existing as Registry | undefined;
	const register = registry?.register;
	const registrations = new Set<{ provider: Provider }>();
	const observedRegister = function (provider: Provider): () => void {
		const release = register?.call(registry, provider);
		if (register && typeof release !== "function") throw new Error("Session-liveness registration returned no disposer.");
		const entry = { provider };
		registrations.add(entry);
		return () => {
			if (registrations.delete(entry)) release?.();
		};
	};

	// Preserve an existing host registry's identity, other methods, and receiver.
	// With no host, provide just the documented registration contract.
	const observedRegistry = registry ?? { version: 1, register: observedRegister };
	observedRegistry.register = observedRegister;
	const monitor = {
		registry: observedRegistry,
		register: observedRegister,
		hasActiveWork(sessionId: string, requireSubagents: boolean): boolean {
			if (host[REGISTRY_KEY] !== observedRegistry || observedRegistry.register !== observedRegister) {
				throw new Error("Session-liveness registry changed; reload Pi before sending completion alerts.");
			}
			let hasSubagents = false;
			for (const { provider } of registrations) {
				if (provider.sessionId !== sessionId) continue;
				if (provider.name === "pi-subagents") hasSubagents = true;
				// Fail closed if a provider throws or returns a non-boolean value.
				if (provider.isActive() !== false) return true;
			}
			return requireSubagents && !hasSubagents;
		},
	};
	host[REGISTRY_KEY] = observedRegistry;
	host[MONITOR_KEY] = monitor;
	return monitor;
}
