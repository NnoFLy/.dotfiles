import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

// Exercise the real installed Pi editor (not source-string assertions or mocks).
// Override this path when testing against a different Pi release/install method.
const install = join(homedir(), ".pi/agent/install");
const modules =
	process.env.PI_TEST_NODE_MODULES ??
	join(install, "releases", readFileSync(join(install, "current-version"), "utf8").trim(), "node_modules");
const { createJiti } = await import(pathToFileURL(join(modules, "jiti/lib/jiti.mjs")).href);
const jiti = createJiti(import.meta.url, {
	alias: {
		"@earendil-works/pi-coding-agent": join(modules, "@earendil-works/pi-coding-agent/dist/index.js"),
		"@earendil-works/pi-tui": join(modules, "@earendil-works/pi-tui/dist/index.js"),
	},
});
const extensionPath =
	process.env.PI_TEST_EXTENSION ?? new URL("../.pi/agent/extensions/emacs-eat-editor.ts", import.meta.url).pathname;
const { EmacsEatEditor, default: extension } = await jiti.import(extensionPath);
const { KeybindingsManager } = await jiti.import(
	join(modules, "@earendil-works/pi-coding-agent/dist/core/keybindings.js"),
);
const { setKeybindings } = await jiti.import(join(modules, "@earendil-works/pi-tui/dist/keybindings.js"));
const config = JSON.parse(readFileSync(new URL("../.pi/agent/keybindings.json", import.meta.url), "utf8"));
const keybindings = new KeybindingsManager(config);
setKeybindings(keybindings);
const noop = () => {};

function editor(options = {}) {
	const instance = new EmacsEatEditor(
		{ terminal: { rows: 30, columns: 80 }, requestRender: noop },
		{ borderColor: (text) => text, selectList: {} },
		keybindings,
		{
			onPrefixStatus: noop,
			onUnknownPrefix: (key) => assert.fail(`Unknown prefix ${key}`),
			onThinkingPicker: noop,
			onShowHelp: noop,
			...options,
		},
	);
	assert.equal(instance.isPiCompatible(), true);
	instance.render(80);
	return instance;
}
const type = (instance, text) => {
	for (const char of text) instance.handleInput(char);
};
const prefix = (instance, key) => {
	instance.handleInput("\x18");
	instance.handleInput(key);
};
const paste = (instance, text) => instance.handleInput(`\x1b[200~${text}\x1b[201~`);

test("Pi's extension loader resolves the entry point and its sibling helper modules", async () => {
	const { loadExtensions } = await jiti.import(
		join(modules, "@earendil-works/pi-coding-agent/dist/core/extensions/loader.js"),
	);
	const loaded = await loadExtensions([extensionPath], process.cwd());
	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions.length, 1);
});

test("real editor retains typing units, branch redo and chronological branch traversal", () => {
	const e = editor();
	type(e, "first second");
	prefix(e, "u");
	assert.equal(e.getText(), "first");
	type(e, " alternative");
	prefix(e, "[");
	assert.equal(e.getText(), "first second");
	prefix(e, "]");
	assert.equal(e.getText(), "first alternative");
	prefix(e, "u");
	prefix(e, "r");
	assert.equal(e.getText(), "first alternative");
	e.dispose();
});

test("undo aliases, Kitty redo, Backspace and prefix cancellation do not collide", () => {
	const e = editor();
	type(e, "abc");
	e.handleInput("\x1f"); // Legacy C-_; also C-/ in some terminals.
	assert.equal(e.getText(), "");
	e.handleInput("\x1b[63;5u"); // Kitty C-?
	assert.equal(e.getText(), "abc");
	e.handleInput("\x7f");
	assert.equal(e.getText(), "ab");
	e.handleInput("\x1b[47;5u"); // Kitty C-/
	assert.equal(e.getText(), "abc");
	e.handleInput("\x18");
	e.handleInput("\x07");
	type(e, "d");
	assert.equal(e.getText(), "abcd");
	e.dispose();
});

test("WORD movement and killing cross lines, preserve Unicode, and accumulate kill text", () => {
	const e = editor();
	e.setText("foo/bar-baz  \nпривет🙂 next");
	e.handleInput("\x01");
	e.handleInput("\x1b\x02"); // Previous WORD across the newline.
	assert.deepEqual(e.getCursor(), { line: 0, col: 0 });
	e.handleInput("\x1b\x06");
	assert.deepEqual(e.getCursor(), { line: 0, col: 11 });
	e.handleInput("\x1b\x04"); // Kill whitespace + following WORD.
	assert.equal(e.getText(), "foo/bar-baz next");
	e.handleInput("\x1b\x04");
	assert.equal(e.getText(), "foo/bar-baz");
	e.handleInput("\x19");
	assert.equal(e.getText(), "foo/bar-baz  \nпривет🙂 next");
	prefix(e, "u");
	assert.equal(e.getText(), "foo/bar-baz");
	prefix(e, "r");
	assert.equal(e.getText(), "foo/bar-baz  \nпривет🙂 next");
	e.dispose();
});

test("backward WORD kills and Russian modified keys use the same kill ring", () => {
	const e = editor();
	e.setText("one/path два-три");
	e.handleInput("\x1b[127;7u"); // Kitty C-M-Backspace
	assert.equal(e.getText(), "one/path ");
	e.handleInput("\x1b[27;7;1074~"); // modifyOtherKeys Russian C-M-d
	assert.equal(e.getText(), "one/path ");
	e.handleInput("\x19");
	assert.equal(e.getText(), "one/path два-три");
	e.handleInput("\x1b[27;7;1080~"); // Russian C-M-b
	assert.deepEqual(e.getCursor(), { line: 0, col: 9 });
	e.dispose();
});

test("C-y/M-y replace multiline entries atomically and M-y is invalid after undo or movement", () => {
	const e = editor();
	e.setText("first");
	e.handleInput("\x15"); // Kill to line start.
	e.handleInput("\x06"); // Break kill accumulation even at a boundary.
	e.setText("second\nline");
	e.handleInput("\x15");
	e.handleInput("\x15"); // Join line break into the kill.
	e.handleInput("\x15");
	assert.equal(e.getText(), "");
	e.handleInput("\x19");
	assert.equal(e.getText(), "second\nline");
	e.handleInput("\x1by");
	assert.equal(e.getText(), "first");
	prefix(e, "u");
	assert.equal(e.getText(), "second\nline");
	e.handleInput("\x1by");
	assert.equal(e.getText(), "second\nline");
	prefix(e, "r");
	assert.equal(e.getText(), "first");
	e.handleInput("\x02");
	e.handleInput("\x1by");
	assert.equal(e.getText(), "first");
	e.dispose();
});

test("killing a collapsed paste yanks actual text after submission and undo restores paste metadata", () => {
	const e = editor();
	const text = "line\n".repeat(15);
	paste(e, text);
	assert.match(e.getText(), /\[paste #1/);
	e.handleInput("\x15");
	assert.equal(e.getText(), "");
	prefix(e, "u");
	assert.equal(e.getExpandedText(), text);
	prefix(e, "r");
	e.handleInput("\r"); // Clears the ephemeral paste registry.
	e.handleInput("\x19");
	assert.equal(e.getExpandedText(), text);
	assert.equal(e.getText(), text);
	e.dispose();
});

test("bracketed paste content is never interpreted as plugin shortcuts", () => {
	const e = editor();
	paste(e, "prefix \x18u \x1b\x02 text");
	assert.match(e.getText(), /prefix/);
	assert.match(e.getText(), /text/);
	prefix(e, "u");
	assert.equal(e.getText(), "");
	e.dispose();
});

test("submission archives an independent tree and the next prompt starts fresh", () => {
	const archives = [];
	const e = editor({ onArchive: (text, tree) => archives.push({ text, tree }) });
	type(e, "one two");
	prefix(e, "u");
	type(e, " other");
	e.handleInput("\r");
	assert.equal(archives.length, 1);
	assert.equal(archives[0].text, "one other");
	assert.equal(archives[0].tree.nodes.length, 4);
	prefix(e, "u");
	assert.equal(e.getText(), "");
	type(e, "new");
	prefix(e, "u");
	assert.equal(e.getText(), "");
	e.dispose();
});

test("history recall restores archived branches, queues immediate undo, and preserves the draft tree", async () => {
	let archived;
	const original = editor({
		onArchive: (_text, tree) => {
			archived = tree;
		},
	});
	type(original, "one two");
	prefix(original, "u");
	type(original, " other");
	original.handleInput("\r");
	original.dispose();
	const e = editor({
		loadArchive: async () => {
			await new Promise((resolve) => setImmediate(resolve));
			return archived;
		},
	});
	e.addToHistory("one other");
	type(e, "draft");
	e.handleInput("\x1bp");
	prefix(e, "["); // Queued until the disk load completes.
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(e.getText(), "one two");
	assert.equal(archived.nodes[archived.current].snapshot.state.lines[0], "one other");
	e.dispose();
	const draft = editor({ loadArchive: async () => archived });
	draft.addToHistory("one other");
	type(draft, "unsent draft");
	draft.handleInput("\x1bp");
	await new Promise((resolve) => setImmediate(resolve));
	draft.handleInput("\x1bn");
	assert.equal(draft.getText(), "unsent draft");
	prefix(draft, "u");
	assert.equal(draft.getText(), "unsent");
	draft.dispose();
});

for (const mode of ["idle", "streaming"]) {
	test(`${mode} follow-up shortcuts archive the prompt and begin a separate draft`, () => {
		const archives = [];
		const historyIds = [];
		const e = editor({
			onArchive: (text, tree) => {
				archives.push({ text, tree });
				return "prompt-id";
			},
			onHistoryEntry: (id) => historyIds.push(id),
		});
		e.onSubmit = (text) => e.addToHistory(text);
		e.onAction("app.message.followUp", () => {
			const text = e.getExpandedText().trim();
			if (mode === "streaming") {
				e.addToHistory(text);
				e.setText("");
			} else {
				// Match installed Pi's idle handleFollowUp: clear before onSubmit.
				e.setText("");
				e.onSubmit(text);
			}
		});
		type(e, "queued prompt");
		e.handleInput("\x1b\r");
		assert.equal(archives.length, 1);
		assert.equal(archives[0].text, "queued prompt");
		assert.deepEqual(historyIds, ["prompt-id"]);
		prefix(e, "u");
		assert.equal(e.getText(), "");
		e.dispose();
	});
}

test("M-p/M-n recall more than 100 prompts and return to the unchanged draft and undo tree", () => {
	const e = editor();
	for (let index = 0; index < 130; index++) e.addToHistory(`prompt ${index}`);
	type(e, "unsent draft");
	for (let index = 129; index >= 0; index--) {
		e.handleInput("\x1bp");
		assert.equal(e.getText(), `prompt ${index}`);
	}
	e.handleInput("\x1bp");
	assert.equal(e.getText(), "prompt 0");
	for (let index = 1; index <= 130; index++) e.handleInput("\x1bn");
	assert.equal(e.getText(), "unsent draft");
	prefix(e, "u");
	assert.equal(e.getText(), "unsent");
	e.dispose();
});

test("hydrated history ignores Pi's partial context replay but accepts new real submissions", () => {
	const e = editor({ initialHistory: ["old", "middle", "new"] });
	e.addToHistory("middle"); // Context rendering is not another user submission.
	e.addToHistory("new");
	e.addToHistory("not submitted");
	e.onSubmit = (text) => e.addToHistory(text);
	type(e, "latest");
	e.handleInput("\r");
	for (const expected of ["latest", "new", "middle", "old"]) {
		e.handleInput("\x1bp");
		assert.equal(e.getText(), expected);
	}
	e.handleInput("\x1bp");
	assert.equal(e.getText(), "old");
	e.dispose();
});

test("C-Backspace deletes the previous word with kill-ring and undo support", () => {
	for (const input of ["\x1b[127;5u", "\x1b[27;5;127~"]) {
		const e = editor();
		e.setText("alpha beta");
		e.handleInput(input);
		assert.equal(e.getText(), "alpha ");
		e.handleInput("\x19");
		assert.equal(e.getText(), "alpha beta");
		prefix(e, "u");
		assert.equal(e.getText(), "alpha ");
		prefix(e, "u");
		assert.equal(e.getText(), "alpha beta");
		e.dispose();
	}
});

test("legacy Meta-Backspace remains a small-word kill, distinct from explicit C-M-Backspace", () => {
	for (const [input, expected] of [
		["\x1b\x08", "onetwo"],
		["\x1b[127;7u", "two"],
	]) {
		const e = editor();
		e.setText("one\ntwo");
		e.handleInput("\x01");
		e.handleInput(input);
		assert.equal(e.getText(), expected);
		e.dispose();
	}
});

test("built-ins do not separate duplicates when matching native prompt history to archives", async () => {
	const { UndoStorage } = await import("../.pi/agent/extensions/emacs-eat/storage.ts");
	const root = await mkdtemp(join(tmpdir(), "pi-emacs-native-history-"));
	const warnings = [];
	const store = new UndoStorage(root, "session", (message) => warnings.push(message));
	const ids = [];
	const e = editor({
		onArchive: (text, tree) => {
			const id = store.archive(text, tree);
			ids.push(id);
			return id;
		},
		onHistoryEntry: (id) => store.markHistory(id),
		loadArchive: async (text, occurrence) => {
			const id = store.find(text, occurrence);
			return id ? store.load(id) : undefined;
		},
	});
	e.onSubmit = (text) => {
		if (text !== "/settings") e.addToHistory(text);
	};
	try {
		await store.start();
		for (const [index, text] of ["A", "B", "A", "/settings", "A"].entries()) {
			e.setText(`before ${index}`);
			e.setText(text);
			e.handleInput("\r");
		}
		assert.equal(store.find("A", 0), ids[4]);
		assert.equal(store.find("A", 1), ids[0]);
		assert.equal(store.find("/settings", 0), undefined);
		for (let count = 0; count < 3; count++) {
			e.handleInput("\x1bp");
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		prefix(e, "u");
		assert.equal(e.getText(), "before 0");
		assert.deepEqual(warnings, []);
	} finally {
		e.dispose();
		await store.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("disposing during recall cancels queued submissions and app actions without executing them", async () => {
	let resolveLoad;
	const callbacks = [];
	const e = editor({
		loadArchive: () =>
			new Promise((resolve) => {
				resolveLoad = resolve;
			}),
	});
	e.onSubmit = () => callbacks.push("submit");
	e.onAction("app.message.followUp", () => callbacks.push("follow-up"));
	e.onAction("app.clear", () => callbacks.push("clear"));
	e.addToHistory("old prompt");
	e.handleInput("\x1bp");
	e.handleInput("\r");
	e.handleInput("\x1b\r");
	e.handleInput("\x03");
	e.dispose();
	assert.deepEqual(callbacks, []);
	resolveLoad(undefined);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(callbacks, []);
	e.handleInput("\r");
	assert.deepEqual(callbacks, []);
});

test("programmatic edits during recall preserve queued typing and cannot be overwritten by a late load", async () => {
	let resolveLoad;
	const e = editor({
		loadArchive: () =>
			new Promise((resolve) => {
				resolveLoad = resolve;
			}),
	});
	e.addToHistory("old");
	e.handleInput("\x1bp");
	type(e, "X");
	e.insertTextAtCursor("Y");
	// Native history recall starts at column zero when no archive is loaded.
	assert.equal(e.getText(), "XYold");
	resolveLoad(undefined);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(e.getText(), "XYold");
	e.dispose();
});

async function deliveryHarness() {
	const { SessionManager } = await jiti.import(
		join(modules, "@earendil-works/pi-coding-agent/dist/core/session-manager.js"),
	);
	const root = await mkdtemp(join(tmpdir(), "pi-emacs-delivery-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	const session = SessionManager.inMemory(root);
	const events = new Map();
	const notices = [];
	let current;
	const ctx = {
		mode: "tui",
		sessionManager: session,
		ui: {
			getEditorText: () => current?.getText() ?? "",
			setEditorComponent: (factory) => {
				const oldText = current?.getText() ?? "";
				current = factory(
					{ terminal: { rows: 30, columns: 80 }, requestRender: noop },
					{ borderColor: (text) => text, selectList: {} },
					keybindings,
				);
				current.onSubmit = (text) => current.addToHistory(text);
				current.setText(oldText);
			},
			setStatus: noop,
			notify: (message) => notices.push(message),
			confirm: async () => true,
		},
	};
	extension({ on: (event, handler) => events.set(event, handler), registerCommand: noop });
	const shutdown = () => events.get("session_shutdown")({ reason: "reload" }, ctx);
	await events.get("session_start")({ reason: "startup" }, ctx);
	return {
		session,
		ctx,
		events,
		notices,
		get editor() {
			return current;
		},
		shutdown,
		restart: async () => {
			await shutdown();
			current = undefined;
			await events.get("session_start")({ reason: "reload" }, ctx);
		},
		close: async () => {
			await shutdown();
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
			await rm(root, { recursive: true, force: true });
		},
	};
}

test("live delivery checkpoints preserve raw template, skill and transformed inputs through reload", async () => {
	const h = await deliveryHarness();
	const raw = ["/example", "/skill:demo", "original input"];
	try {
		for (const [index, text] of raw.entries()) {
			h.editor.setText(`original draft ${index}`);
			h.editor.setText(text);
			h.editor.handleInput("\r");
			const transformed = `expanded or transformed input ${index}`;
			// The input hook may already see another handler's transformation.
			await h.events.get("input")({ type: "input", source: "interactive", text: transformed }, h.ctx);
			h.session.appendMessage({ role: "user", content: [{ type: "text", text: transformed }], timestamp: index });
			const originalMessages = JSON.stringify(h.session.getEntries());
			assert.equal(await h.events.get("context")({ messages: [] }, h.ctx), undefined);
			assert.equal(JSON.stringify(h.session.getEntries()), originalMessages);
		}
		await h.restart();
		for (const text of [...raw].reverse()) {
			h.editor.handleInput("\x1bp");
			await new Promise((resolve) => setTimeout(resolve, 20));
			assert.equal(h.editor.getText(), text);
		}
		prefix(h.editor, "u");
		assert.equal(h.editor.getText(), "original draft 0");
		assert.deepEqual(h.notices, []);
	} finally {
		await h.close();
	}
});

test("stable delivery IDs distinguish an archived A from a later A submitted while disabled", async () => {
	const h = await deliveryHarness();
	try {
		h.editor.setText("old A's unique undo state");
		h.editor.setText("A");
		h.editor.handleInput("\r");
		h.session.appendMessage({ role: "user", content: "A", timestamp: 1 });
		await h.events.get("context")({ messages: [] }, h.ctx);
		await h.shutdown();
		h.session.appendMessage({ role: "user", content: "B", timestamp: 2 });
		h.session.appendMessage({ role: "user", content: "A", timestamp: 3 });
		await h.restart();
		h.editor.handleInput("\x1bp");
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(h.editor.getText(), "A");
		prefix(h.editor, "u");
		assert.equal(h.editor.getText(), "A"); // The newer text-only A cannot borrow the old tree.
		for (const expected of ["B", "A"]) {
			h.editor.handleInput("\x1bp");
			await new Promise((resolve) => setTimeout(resolve, 20));
			assert.equal(h.editor.getText(), expected);
		}
		prefix(h.editor, "u");
		assert.equal(h.editor.getText(), "old A's unique undo state");
		assert.deepEqual(h.notices, []);
	} finally {
		await h.close();
	}
});

test("programmatic raw input is recalled without duplicating its expanded message or changing the draft", async () => {
	const h = await deliveryHarness();
	try {
		type(h.editor, "unsent draft");
		await h.events.get("input")({ type: "input", source: "extension", text: "/skill:external" }, h.ctx);
		assert.equal(h.editor.getText(), "unsent draft");
		h.session.appendMessage({ role: "user", content: "expanded external input", timestamp: 1 });
		await h.events.get("context")({ messages: [] }, h.ctx);
		await h.restart();
		assert.equal(h.editor.getText(), "unsent draft");
		h.editor.handleInput("\x1bp");
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(h.editor.getText(), "/skill:external");
		prefix(h.editor, "u");
		assert.equal(h.editor.getText(), "/skill:external");
		h.editor.handleInput("\x1bn");
		assert.equal(h.editor.getText(), "unsent draft");
		prefix(h.editor, "u");
		assert.equal(h.editor.getText(), "unsent");
		assert.deepEqual(h.notices, []);
	} finally {
		await h.close();
	}
});

test("full session recall survives branches, repeated compaction/reload, resume and session switches", async () => {
	const { SessionManager } = await jiti.import(
		join(modules, "@earendil-works/pi-coding-agent/dist/core/session-manager.js"),
	);
	const root = await mkdtemp(join(tmpdir(), "pi-emacs-full-recall-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	let session = SessionManager.inMemory(root);
	const prompts = [];
	let first;
	for (let index = 0; index < 125; index++) {
		const text = `historical ${index}`;
		const id = session.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: index });
		first ??= id;
		prompts.push(text);
	}
	session.branch(first);
	session.appendMessage({ role: "user", content: "alternate branch", timestamp: 126 });
	prompts.push("alternate branch");
	const events = new Map();
	const notices = [];
	let current;
	const ctx = {
		mode: "tui",
		get sessionManager() {
			return session;
		},
		ui: {
			getEditorText: () => current?.getText() ?? "",
			setEditorComponent: (factory) => {
				const oldText = current?.getText() ?? "";
				current = factory(
					{ terminal: { rows: 30, columns: 80 }, requestRender: noop },
					{ borderColor: (text) => text, selectList: {} },
					keybindings,
				);
				current.onSubmit = (text) => current.addToHistory(text);
				current.setText(oldText);
			},
			setStatus: noop,
			notify: (message) => notices.push(message),
			confirm: async () => true,
		},
	};
	extension({ on: (event, handler) => events.set(event, handler), registerCommand: noop });
	try {
		await events.get("session_start")({ reason: "startup" }, ctx);
		type(current, "draft before");
		prefix(current, "u");
		type(current, " after");
		for (const kind of ["manual", "automatic"]) {
			session.appendCompaction(`${kind} summary`, null, 10000);
			assert.equal(
				session
					.buildContextEntries()
					.some((entry) => entry.type === "message" && entry.message.role === "user"),
				false,
			);
			await events.get("session_shutdown")({ reason: "reload" }, ctx);
			await events.get("session_start")({ reason: "reload" }, ctx);
			assert.equal(current.getText(), "draft after");
			current.addToHistory("historical 124"); // Native context replay must not reorder recall.
			for (const text of [...prompts].reverse()) {
				current.handleInput("\x1bp");
				await new Promise((resolve) => setImmediate(resolve));
				assert.equal(current.getText(), text);
			}
			for (let index = 0; index < prompts.length; index++) {
				current.handleInput("\x1bn");
				await new Promise((resolve) => setImmediate(resolve));
			}
			assert.equal(current.getText(), "draft after");
			prefix(current, "[");
			assert.equal(current.getText(), "draft before");
			prefix(current, "]");
		}
		await events.get("session_shutdown")({ reason: "quit" }, ctx);
		current = undefined;
		await events.get("session_start")({ reason: "resume" }, ctx);
		assert.equal(current.getText(), "draft after");
		current.handleInput("\x1bp");
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(current.getText(), "alternate branch");
		await events.get("session_shutdown")({ reason: "new" }, ctx);
		session = SessionManager.inMemory(root);
		current = undefined;
		await events.get("session_start")({ reason: "new" }, ctx);
		current.handleInput("\x1bp");
		assert.equal(current.getText(), "");
		assert.deepEqual(notices, []);
	} finally {
		await events.get("session_shutdown")({ reason: "quit" }, ctx);
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(root, { recursive: true, force: true });
	}
});

test("session shutdown/restart restores the draft tree after Pi's initial text copy", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-emacs-lifecycle-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	const events = new Map();
	const commands = new Map();
	const notices = [];
	let current;
	const ctx = {
		mode: "tui",
		sessionManager: { getSessionId: () => "session-one", getEntries: () => [] },
		ui: {
			getEditorText: () => current?.getText() ?? "",
			setEditorComponent: (factory) => {
				const oldText = current?.getText() ?? "";
				current = factory(
					{ terminal: { rows: 30, columns: 80 }, requestRender: noop },
					{ borderColor: (text) => text, selectList: {} },
					keybindings,
				);
				current.onSubmit = (text) => current.addToHistory(text);
				current.setText(oldText); // Match the actual Pi replacement lifecycle.
			},
			setStatus: noop,
			notify: (message) => notices.push(message),
			confirm: async () => true,
		},
	};
	extension({
		on: (event, handler) => events.set(event, handler),
		registerCommand: (name, command) => commands.set(name, command),
	});
	try {
		await events.get("session_start")({ reason: "startup" }, ctx);
		type(current, "submitted old");
		prefix(current, "u");
		type(current, " new");
		current.handleInput("\r");
		type(current, "draft before");
		prefix(current, "u");
		type(current, " after");
		await events.get("session_shutdown")({ reason: "quit" }, ctx);
		current = undefined;
		await events.get("session_start")({ reason: "startup" }, ctx);
		assert.equal(current.getText(), "draft after");
		prefix(current, "[");
		assert.equal(current.getText(), "draft before");
		current.addToHistory("submitted new");
		current.handleInput("\x1bp");
		prefix(current, "[");
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(current.getText(), "submitted old");
		await commands.get("emacs-undo-clear").handler("", ctx);
		prefix(current, "[");
		assert.equal(current.getText(), "submitted old");
		assert.deepEqual(notices, ["Emacs undo archive cleared"]);
	} finally {
		await events.get("session_shutdown")({ reason: "quit" }, ctx);
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(root, { recursive: true, force: true });
	}
});

test("clearing an archive invalidates in-flight recall so deleted branches cannot reappear", async () => {
	let resolveLoad;
	const saved = [];
	const e = editor({
		onTreeChange: (tree) => saved.push(tree),
		loadArchive: () =>
			new Promise((resolve) => {
				resolveLoad = resolve;
			}),
	});
	type(e, "secret removed");
	const secretTree = saved.at(-1);
	e.addToHistory("old prompt");
	e.handleInput("\x1bp");
	const cleared = e.clearUndoHistory();
	assert.equal(cleared.nodes.length, 1);
	resolveLoad(secretTree);
	await new Promise((resolve) => setImmediate(resolve));
	prefix(e, "[");
	assert.equal(e.getText(), "old prompt");
	e.dispose();
});
