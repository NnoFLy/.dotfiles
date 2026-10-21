import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { isUndoTreeData, type UndoTreeData } from "./undo-tree.ts";

export type SessionPrompt = { id: string; text: string };
type PromptEntry = {
	id: string;
	text: string;
	inHistory: boolean;
	// Older indexes contain only archived trees. Recovered prompts have no tree.
	hasTree?: boolean;
	// Legacy text alignment is not proof that a particular occurrence owns a tree.
	treeUsable?: boolean;
	sessionEntryId?: string;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_READ_BYTES = 64 * 1024 * 1024;

function isPromptEntry(value: unknown): value is PromptEntry {
	if (typeof value !== "object" || value === null) return false;
	const item = value as Record<string, unknown>;
	return (
		typeof item.id === "string" &&
		UUID.test(item.id) &&
		typeof item.text === "string" &&
		typeof item.inHistory === "boolean" &&
		(item.hasTree === undefined || typeof item.hasTree === "boolean") &&
		(item.treeUsable === undefined || typeof item.treeUsable === "boolean") &&
		(item.sessionEntryId === undefined ||
			(typeof item.sessionEntryId === "string" && item.sessionEntryId.length > 0))
	);
}

/** Private per-session files, serialized atomic writes, and one live writer per session. */
export class UndoStorage {
	readonly directory: string;
	private entries: PromptEntry[] = [];
	private coveredSessionIds = new Set<string>();
	private legacyIndex = false;
	private unsavedTrees = new Map<string, UndoTreeData>();
	private pendingDraft: UndoTreeData | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private queue: Promise<void> = Promise.resolve();
	private lock: string | undefined;
	private writable = false;
	private warned = false;
	private readonly notify: (message: string) => void;

	constructor(root: string, sessionId: string, notify: (message: string) => void) {
		this.notify = notify;
		this.directory = join(root, createHash("sha256").update(sessionId).digest("hex"));
	}

	private warn(): void {
		if (this.warned) return;
		this.warned = true;
		this.notify(
			"Emacs undo storage unavailable or invalid; editing continues in memory. Check the archive directory and permissions.",
		);
	}

	private async privateDirectory(path: string): Promise<void> {
		await mkdir(path, { mode: 0o700, recursive: true });
		const stat = await lstat(path);
		if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.())
			throw new Error("Unsafe archive directory");
		await chmod(path, 0o700);
	}

	/** Read without following a symlink; never include file contents in error notifications. */
	private async readJson(name: string): Promise<unknown | undefined> {
		let handle;
		try {
			handle = await open(
				join(this.directory, name),
				constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
			);
			const stat = await handle.stat();
			if (
				!stat.isFile() ||
				stat.uid !== process.getuid?.() ||
				stat.size > MAX_READ_BYTES ||
				(stat.mode & 0o077) !== 0
			)
				throw new Error("Unsafe archive file");
			return JSON.parse(await handle.readFile("utf8")) as unknown;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		} finally {
			await handle?.close();
		}
	}

	private async atomicWrite(name: string, value: unknown): Promise<void> {
		const serialized = JSON.stringify(value);
		if (Buffer.byteLength(serialized) > MAX_READ_BYTES) throw new Error("Archive exceeds safe file size");
		const temporary = join(this.directory, `.${randomUUID()}.tmp`);
		try {
			const handle = await open(temporary, "wx", 0o600);
			try {
				await handle.writeFile(serialized);
				await handle.sync();
			} finally {
				await handle.close();
			}
			// rename replaces the directory entry itself, never a symlink target.
			await rename(temporary, join(this.directory, name));
		} finally {
			await unlink(temporary).catch(() => {});
		}
	}

	async start(): Promise<UndoTreeData | undefined> {
		try {
			await this.privateDirectory(join(this.directory, ".."));
			await this.privateDirectory(this.directory);
			// Unique claim files avoid racing to reclaim a stale shared lock. Dead
			// writers are ignored, not removed; concurrent live writers fail closed.
			this.lock = `writer-${process.pid}-${randomUUID()}.lock`;
			const handle = await open(join(this.directory, this.lock), "wx", 0o600);
			await handle.close();
			for (const name of await readdir(this.directory)) {
				const match = /^writer-(\d+)-[0-9a-f-]+\.lock$/.exec(name);
				if (!match || name === this.lock) continue;
				try {
					process.kill(Number(match[1]), 0);
					throw new Error("Another undo writer is active");
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
				}
			}
			const index = await this.readJson("index.json");
			if (index !== undefined) {
				if (Array.isArray(index) && index.every(isPromptEntry)) {
					this.entries = index;
					this.legacyIndex = true;
				} else if (typeof index === "object" && index !== null) {
					const document = index as Record<string, unknown>;
					if (
						document.version !== 2 ||
						!Array.isArray(document.entries) ||
						!document.entries.every(isPromptEntry) ||
						!Array.isArray(document.coveredSessionIds) ||
						!document.coveredSessionIds.every((id: unknown) => typeof id === "string" && id.length > 0)
					)
						throw new Error("Invalid archive index");
					this.entries = document.entries;
					this.coveredSessionIds = new Set(document.coveredSessionIds as string[]);
					this.legacyIndex = false;
				} else throw new Error("Invalid archive index");
			}
			const draft = await this.readJson("draft.json");
			if (draft !== undefined && !isUndoTreeData(draft)) throw new Error("Invalid draft tree");
			this.writable = true;
			return draft as UndoTreeData | undefined;
		} catch {
			await this.releaseLock();
			this.warn();
			return undefined;
		}
	}

	private enqueue(operation: () => Promise<void>): void {
		this.queue = this.queue.then(async () => {
			if (!this.writable) return;
			try {
				await operation();
			} catch {
				this.writable = false; // Preserve a corrupt/unwritable archive rather than overwrite it.
				this.warn();
			}
		});
	}

	private indexSnapshot() {
		return {
			version: 2,
			entries: this.entries.map((entry) => ({ ...entry })),
			coveredSessionIds: [...this.coveredSessionIds],
		};
	}

	private saveIndex(): void {
		const index = this.indexSnapshot();
		this.enqueue(() => this.atomicWrite("index.json", index));
	}

	/** Raw non-editor inputs have no undo tree but still belong in session recall. */
	recordInput(text: string): void {
		const trimmed = text.trim();
		if (!trimmed) return;
		this.entries.push({ id: randomUUID(), text: trimmed, inHistory: true, hasTree: false });
		this.saveIndex();
	}

	/** Model messages are a projection of inputs: templates/transforms may change
	 * their text or delivery order. Track actual persisted IDs, never match them
	 * back to an archive by text. Checkpoint together with the raw input ledger.
	 */
	coverDelivered(ids: readonly string[]): void {
		let changed = false;
		for (const id of ids) {
			if (!this.coveredSessionIds.has(id)) {
				this.coveredSessionIds.add(id);
				changed = true;
			}
		}
		if (changed) this.saveIndex();
	}

	saveDraft(tree: UndoTreeData): void {
		this.pendingDraft = tree;
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => this.flushDraft(), 300);
		this.timer.unref();
	}

	private flushDraft(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		const tree = this.pendingDraft;
		this.pendingDraft = undefined;
		if (tree) this.enqueue(() => this.atomicWrite("draft.json", tree));
	}

	archive(text: string, tree: UndoTreeData): string {
		const id = randomUUID();
		this.entries.push({ id, text, inHistory: false });
		this.unsavedTrees.set(id, structuredClone(tree));
		const index = this.indexSnapshot();
		this.enqueue(async () => {
			await this.atomicWrite(`${id}.json`, tree);
			await this.atomicWrite("index.json", index);
			this.unsavedTrees.delete(id);
		});
		return id;
	}

	/** Only actual native history additions participate in recall ordering.
	 * Built-in commands are archived too, but must not separate duplicate prompts.
	 */
	markHistory(id: string): void {
		const entry = this.entries.find((item) => item.id === id);
		if (!entry || entry.inHistory) return;
		entry.inHistory = true;
		this.saveIndex();
	}

	/** Full recall history, oldest first, with native consecutive-duplicate handling. */
	history(): string[] {
		const result: string[] = [];
		for (const entry of this.entries) {
			if (!entry.inHistory) continue;
			if (result[result.length - 1] !== entry.text) result.push(entry.text);
		}
		return result;
	}

	/** Recover only session entries not checkpointed while input capture was active.
	 * Modern indexes never infer submission identity from model-visible text.
	 * Legacy indexes are aligned once, with repeated-text tree lookup disabled.
	 */
	recoverHistory(source: readonly SessionPrompt[]): void {
		const prompts = source
			.map((prompt) => ({ ...prompt, text: prompt.text.trim() }))
			.filter((prompt) => prompt.text);
		if (!this.legacyIndex) {
			for (const prompt of prompts) {
				if (this.coveredSessionIds.has(prompt.id)) continue;
				this.entries.push({
					id: randomUUID(),
					text: prompt.text,
					inHistory: true,
					hasTree: false,
					sessionEntryId: prompt.id,
				});
				this.coveredSessionIds.add(prompt.id);
			}
			this.saveIndex();
			return;
		}
		const byId = new Map(prompts.map((prompt, index) => [prompt.id, index]));
		const byText = new Map<string, number[]>();
		for (let index = 0; index < prompts.length; index++) {
			const indexes = byText.get(prompts[index].text) ?? [];
			indexes.push(index);
			byText.set(prompts[index].text, indexes);
		}
		const archiveCounts = new Map<string, number>();
		for (const entry of this.entries)
			if (entry.inHistory && entry.hasTree !== false)
				archiveCounts.set(entry.text, (archiveCounts.get(entry.text) ?? 0) + 1);
		for (const entry of this.entries) {
			if (entry.hasTree === false) continue;
			// Old sessionEntryId values may themselves have been inferred by text.
			// Even a unique equal string is not delivery identity (the older input
			// could have failed before entering the transcript). Align text only.
			delete entry.sessionEntryId;
			if ((archiveCounts.get(entry.text) ?? 0) > 1 || byText.has(entry.text)) entry.treeUsable = false;
		}
		const known = new Set(this.entries.flatMap((entry) => (entry.sessionEntryId ? [entry.sessionEntryId] : [])));
		const anchors = new Map<PromptEntry, number>();
		let before = prompts.length;
		let changed = false;
		for (let index = this.entries.length - 1; index >= 0; index--) {
			const entry = this.entries[index];
			if (!entry.inHistory) continue;
			let match = entry.sessionEntryId ? byId.get(entry.sessionEntryId) : undefined;
			if (!entry.sessionEntryId) {
				const candidates = byText.get(entry.text) ?? [];
				let candidate = candidates.findLastIndex(
					(position) => position < before && !known.has(prompts[position].id),
				);
				// Steering can overtake an earlier queued follow-up. Bind its source
				// ID without reordering the authoritative keyboard-submission log.
				if (candidate === -1)
					candidate = candidates.findLastIndex((position) => !known.has(prompts[position].id));
				match = candidate === -1 ? undefined : candidates.splice(candidate, 1)[0];
				if (match !== undefined) {
					entry.sessionEntryId = prompts[match].id;
					known.add(entry.sessionEntryId);
					changed = true;
				}
			}
			if (match !== undefined && match < before) {
				anchors.set(entry, match);
				before = match;
			}
		}
		const merged: PromptEntry[] = [];
		let cursor = 0;
		const recoverUntil = (end: number) => {
			while (cursor < end) {
				const prompt = prompts[cursor++];
				if (known.has(prompt.id)) continue;
				merged.push({
					id: randomUUID(),
					text: prompt.text,
					inHistory: true,
					hasTree: false,
					sessionEntryId: prompt.id,
				});
				known.add(prompt.id);
				changed = true;
			}
		};
		let pending: PromptEntry[] = [];
		for (const entry of this.entries) {
			const anchor = anchors.get(entry);
			if (anchor !== undefined) {
				recoverUntil(anchor);
				for (const item of pending) merged.push(item);
				merged.push(entry);
				pending = [];
				cursor = anchor + 1;
			} else pending.push(entry);
		}
		recoverUntil(prompts.length);
		for (const entry of pending) merged.push(entry);
		this.entries = changed ? merged : this.entries;
		this.legacyIndex = false;
		for (const prompt of prompts) this.coveredSessionIds.add(prompt.id);
		this.saveIndex();
	}

	/** Native prompt history collapses consecutive duplicates. Match its occurrence order. */
	find(text: string, occurrence: number): string | undefined {
		let previous: string | undefined;
		for (let index = this.entries.length - 1; index >= 0; index--) {
			const entry = this.entries[index];
			if (!entry.inHistory || entry.text === previous) continue;
			previous = entry.text;
			if (entry.text === text && occurrence-- === 0)
				return entry.hasTree === false || entry.treeUsable === false ? undefined : entry.id;
		}
		return undefined;
	}

	async load(id: string): Promise<UndoTreeData | undefined> {
		const entry = this.entries.find((item) => item.id === id);
		if (!UUID.test(id) || entry?.hasTree === false || entry?.treeUsable === false) return undefined;
		await this.flush(); // A just-submitted prompt may still be waiting for its write.
		const unsaved = this.unsavedTrees.get(id);
		if (unsaved) return structuredClone(unsaved);
		try {
			const tree = await this.readJson(`${id}.json`);
			if (!isUndoTreeData(tree)) throw new Error("Invalid prompt tree");
			return tree;
		} catch {
			this.warn();
			return undefined;
		}
	}

	async flush(): Promise<void> {
		this.flushDraft();
		await this.queue;
	}

	async clear(current: UndoTreeData): Promise<boolean> {
		await this.flush();
		if (!this.writable) return false;
		// Clearing undo branches must not erase the session's submitted-prompt list.
		this.entries = this.entries.filter((entry) => entry.inHistory).map((entry) => ({ ...entry, hasTree: false }));
		const index = this.indexSnapshot();
		this.unsavedTrees.clear();
		this.enqueue(async () => {
			for (const name of await readdir(this.directory)) {
				if (
					name === "index.json" ||
					name === "draft.json" ||
					(name.endsWith(".json") && UUID.test(name.slice(0, -5))) ||
					(name.startsWith(".") && name.endsWith(".tmp") && UUID.test(name.slice(1, -4)))
				) {
					await unlink(join(this.directory, name));
				}
			}
			await this.atomicWrite("index.json", index);
			await this.atomicWrite("draft.json", current);
		});
		await this.queue;
		return this.writable;
	}

	private async releaseLock(): Promise<void> {
		if (!this.lock) return;
		await unlink(join(this.directory, this.lock)).catch(() => {});
		this.lock = undefined;
	}

	async close(): Promise<void> {
		await this.flush();
		this.writable = false;
		await this.releaseLock();
	}
}
