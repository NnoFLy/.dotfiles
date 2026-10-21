import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	UndoTree,
	isUndoTreeData,
	wordOffset,
	type EditorSnapshot,
} from "../.pi/agent/extensions/emacs-eat/undo-tree.ts";
import { UndoStorage } from "../.pi/agent/extensions/emacs-eat/storage.ts";

const snapshot = (text: string): EditorSnapshot => ({
	state: { lines: text.split("\n"), cursorLine: 0, cursorCol: 0 },
	pastes: [],
	pasteCounter: 0,
});
const content = (tree: UndoTree) => tree.snapshot.state.lines.join("\n");

function branchingTree() {
	const tree = new UndoTree(snapshot(""));
	tree.record(snapshot("first"), true);
	tree.record(snapshot("first second"), true);
	tree.move("undo");
	tree.record(snapshot("first alternative"), true);
	return tree;
}

test("undo/redo preserve abandoned branches and chronological traversal selects a branch", () => {
	const tree = branchingTree();
	assert.equal(content(tree), "first alternative");
	tree.move("undo");
	assert.equal(content(tree), "first");
	tree.move("redo");
	assert.equal(content(tree), "first alternative");
	tree.move("older");
	assert.equal(content(tree), "first second");
	tree.move("undo");
	tree.move("redo");
	assert.equal(content(tree), "first second");
	assert.equal(tree.export().nodes.length, 4);
});

test("typing coalesces at a leaf; exported trees and returned snapshots are detached", () => {
	const tree = new UndoTree(snapshot(""));
	tree.record(snapshot("a"), true);
	tree.record(snapshot("ab"), false);
	assert.equal(tree.export().nodes.length, 2);
	const data = tree.export();
	data.nodes[1].snapshot.state.lines[0] = "changed outside";
	assert.equal(content(tree), "ab");
	tree.move("undo");
	assert.equal(content(tree), "");
	tree.move("redo");
	assert.equal(content(tree), "ab");
});

test("disk validator rejects broken trees and paste metadata", () => {
	const data = branchingTree().export();
	assert.equal(isUndoTreeData(JSON.parse(JSON.stringify(data))), true);
	for (const mutate of [
		(d: typeof data) => {
			d.nodes[0].parent = 1;
		},
		(d: typeof data) => {
			d.nodes[1].parent = 2;
		},
		(d: typeof data) => {
			d.current = 99;
		},
		(d: typeof data) => {
			d.nodes[0].selectedChild = 3;
		},
		(d: typeof data) => {
			d.nodes[0].snapshot.state.cursorCol = 100;
		},
		(d: typeof data) => {
			d.nodes[0].snapshot.state.lines = ["embedded\nnewline"];
		},
		(d: typeof data) => {
			d.nodes[0].snapshot.pastes = [[1, "invalid id"]];
		},
	]) {
		const broken = structuredClone(data);
		mutate(broken);
		assert.equal(isUndoTreeData(broken), false);
	}
});

test("WORD boundaries cross punctuation, Unicode and newlines without splitting paste labels", () => {
	const text = "foo/bar-baz  \nпривет🙂 next";
	assert.equal(wordOffset(text, 0, 1, new Map()), 11);
	assert.equal(wordOffset(text, 11, 1, new Map()), 22);
	assert.equal(wordOffset(text, 22, -1, new Map()), 14);
	assert.equal(wordOffset(text, 14, -1, new Map()), 0);
	const marker = "[paste #1 +3 lines]";
	const pastes = new Map([[1, "actual\npasted\ntext"]]);
	assert.equal(wordOffset(marker, 0, 1, pastes), marker.length);
	assert.equal(wordOffset(marker, marker.length, -1, pastes), 0);
});

test("persistent trees survive restart, isolate sessions, and use private permissions", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-emacs-undo-"));
	const warnings: string[] = [];
	const tree = branchingTree().export();
	let store = new UndoStorage(root, "session/../one", (message) => warnings.push(message));
	try {
		assert.equal(await store.start(), undefined);
		store.saveDraft(tree);
		store.markHistory(store.archive("prompt", tree));
		await store.flush();
		const id = store.find("prompt", 0)!;
		assert.deepEqual(await store.load(id), tree);
		assert.equal((await stat(store.directory)).mode & 0o777, 0o700);
		for (const name of await readdir(store.directory))
			assert.equal((await stat(join(store.directory, name))).mode & 0o777, 0o600);
		await store.close();
		store = new UndoStorage(root, "session/../one", (message) => warnings.push(message));
		assert.deepEqual(await store.start(), tree);
		assert.deepEqual(await store.load(store.find("prompt", 0)!), tree);
		const other = new UndoStorage(root, "two", (message) => warnings.push(message));
		assert.equal(await other.start(), undefined);
		assert.equal(other.find("prompt", 0), undefined);
		await other.close();
		assert.deepEqual(warnings, []);
	} finally {
		await store.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("a second live writer cannot overwrite another editor's session archive", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-emacs-lock-"));
	const first = new UndoStorage(root, "same", () => {});
	const warnings: string[] = [];
	const second = new UndoStorage(root, "same", (message) => warnings.push(message));
	try {
		await first.start();
		await second.start();
		assert.equal(warnings.length, 1);
		second.saveDraft(branchingTree().export());
		await second.flush();
		await assert.rejects(readFile(join(first.directory, "draft.json")));
	} finally {
		await first.close();
		await second.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("corrupt, public or symlinked archive files are rejected without overwriting them", async () => {
	for (const kind of ["corrupt", "public", "symlink"] as const) {
		const root = await mkdtemp(join(tmpdir(), "pi-emacs-untrusted-"));
		const warnings: string[] = [];
		let store = new UndoStorage(root, "session", (message) => warnings.push(message));
		try {
			await store.start();
			await store.close();
			const path = join(store.directory, "draft.json");
			const payload = kind === "corrupt" ? '{"nodes": "not a tree"}' : JSON.stringify(branchingTree().export());
			if (kind === "symlink") {
				await writeFile(join(root, "target"), payload, { mode: 0o600 });
				await symlink(join(root, "target"), path);
			} else {
				await writeFile(path, payload, { mode: 0o600 });
				if (kind === "public") await chmod(path, 0o644);
			}
			store = new UndoStorage(root, "session", (message) => warnings.push(message));
			assert.equal(await store.start(), undefined);
			assert.equal(warnings.length, 1);
			store.saveDraft(new UndoTree(snapshot("new")).export());
			await store.flush();
			assert.equal(await readFile(path, "utf8"), payload);
		} finally {
			await store.close();
			await rm(root, { recursive: true, force: true });
		}
	}
});

test("session-log recovery fills older prompts and gaps without stealing a repeated prompt's tree", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-emacs-recover-"));
	const warnings: string[] = [];
	let store = new UndoStorage(root, "session", (message) => warnings.push(message));
	const tree = branchingTree().export();
	const source = [
		{ id: "old-repeat", text: "repeat" },
		{ id: "gap", text: "gap" },
		{ id: "recent-repeat", text: "repeat" },
		{ id: "newest", text: "newest" },
	];
	try {
		await store.start();
		store.recoverHistory(source.slice(0, 2));
		const archived = store.archive("repeat", tree);
		store.markHistory(archived);
		store.markHistory(store.archive("newest", tree));
		store.coverDelivered(source.slice(2).map((prompt) => prompt.id));
		store.recoverHistory(source);
		assert.deepEqual(store.history(), ["repeat", "gap", "repeat", "newest"]);
		assert.equal(store.find("repeat", 0), archived);
		assert.equal(store.find("repeat", 1), undefined);
		assert.equal(store.find("gap", 0), undefined);
		assert.deepEqual(await store.load(archived), tree);
		store.recoverHistory(source);
		assert.deepEqual(store.history(), ["repeat", "gap", "repeat", "newest"]);
		await store.close();
		store = new UndoStorage(root, "session", (message) => warnings.push(message));
		await store.start();
		store.recoverHistory(source);
		assert.deepEqual(store.history(), ["repeat", "gap", "repeat", "newest"]);
		assert.equal(store.find("repeat", 0), archived);
		assert.deepEqual(warnings, []);
	} finally {
		await store.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("recovery preserves submission order when queues reorder delivery or later prompts are unarchived", async () => {
	for (const reordered of [true, false]) {
		const root = await mkdtemp(join(tmpdir(), "pi-emacs-order-"));
		const store = new UndoStorage(root, "session", () => {});
		try {
			await store.start();
			store.recoverHistory([]);
			const archivedA = store.archive("A", branchingTree().export());
			store.markHistory(archivedA);
			store.markHistory(store.archive("B", branchingTree().export()));
			const source = reordered
				? [
						{ id: "b", text: "B" },
						{ id: "a", text: "A" },
					]
				: [
						{ id: "a", text: "A" },
						{ id: "b", text: "B" },
						{ id: "later-a", text: "A" },
					];
			store.coverDelivered((reordered ? source : source.slice(0, 2)).map((prompt) => prompt.id));
			store.recoverHistory(source);
			store.recoverHistory(source);
			assert.deepEqual(store.history(), reordered ? ["A", "B"] : ["A", "B", "A"]);
			assert.equal(store.find("A", reordered ? 0 : 1), archivedA);
			if (!reordered) assert.equal(store.find("A", 0), undefined);
		} finally {
			await store.close();
			await rm(root, { recursive: true, force: true });
		}
	}
});

test("delivered session IDs keep template, skill and transformed inputs from being imported again", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-emacs-projection-"));
	const warnings: string[] = [];
	let store = new UndoStorage(root, "session", (message) => warnings.push(message));
	const raw = ["/example", "/skill:demo", "original input"];
	const delivered = raw.map((_, index) => ({ id: `message-${index}`, text: `expanded or transformed ${index}` }));
	const ids: string[] = [];
	try {
		await store.start();
		store.recoverHistory([]);
		for (const text of raw) {
			const id = store.archive(text, branchingTree().export());
			ids.push(id);
			store.markHistory(id);
		}
		store.coverDelivered(delivered.map((prompt) => prompt.id));
		await store.close();
		store = new UndoStorage(root, "session", (message) => warnings.push(message));
		await store.start();
		store.recoverHistory(delivered);
		assert.deepEqual(store.history(), raw);
		for (const [index, text] of raw.entries()) assert.equal(store.find(text, 0), ids[index]);
		assert.deepEqual(warnings, []);
	} finally {
		await store.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("legacy anchorless repeats retain text and archive files but cannot borrow an unverified tree", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-emacs-legacy-repeat-"));
	const warnings: string[] = [];
	let store = new UndoStorage(root, "session", (message) => warnings.push(message));
	try {
		await store.start();
		const old = store.archive("A", branchingTree().export());
		store.markHistory(old);
		await store.close();
		// Reproduce an index written before delivery IDs existed.
		const path = join(store.directory, "index.json");
		const index = JSON.parse(await readFile(path, "utf8")) as { entries: unknown[] };
		await writeFile(path, JSON.stringify(index.entries));
		store = new UndoStorage(root, "session", (message) => warnings.push(message));
		await store.start();
		store.recoverHistory([
			{ id: "old-a", text: "A" },
			{ id: "b", text: "B" },
			{ id: "new-a", text: "A" },
		]);
		assert.deepEqual(store.history(), ["A", "B", "A"]);
		assert.equal(store.find("A", 0), undefined);
		assert.equal(store.find("A", 1), undefined);
		assert.equal(await store.load(old), undefined);
		assert.equal((await stat(join(store.directory, `${old}.json`))).isFile(), true);
		await store.close();
		store = new UndoStorage(root, "session", (message) => warnings.push(message));
		await store.start();
		assert.equal(store.find("A", 0), undefined);
		assert.equal(store.find("A", 1), undefined);
		assert.deepEqual(warnings, []);
	} finally {
		await store.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("recovered recall remains durable with consecutive duplicates and no fabricated undo trees", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-emacs-text-history-"));
	const warnings: string[] = [];
	let store = new UndoStorage(root, "session", (message) => warnings.push(message));
	try {
		await store.start();
		store.recoverHistory([
			{ id: "1", text: "one" },
			{ id: "2", text: "one" },
			{ id: "3", text: "two" },
		]);
		assert.deepEqual(store.history(), ["one", "two"]);
		assert.equal(store.find("one", 0), undefined);
		await store.close();
		store = new UndoStorage(root, "session", (message) => warnings.push(message));
		await store.start();
		assert.deepEqual(store.history(), ["one", "two"]);
		assert.equal(await store.clear(new UndoTree(snapshot("visible")).export()), true);
		assert.deepEqual(store.history(), ["one", "two"]);
		assert.deepEqual(warnings, []);
	} finally {
		await store.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("archives distinguish repeated prompts and explicit clearing removes all saved branches", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-emacs-clear-"));
	const store = new UndoStorage(root, "session", () => {});
	const tree = branchingTree().export();
	try {
		await store.start();
		store.markHistory(store.archive("same", tree));
		const first = store.find("same", 0);
		store.markHistory(store.archive("different", tree));
		store.markHistory(store.archive("same", tree));
		const second = store.find("same", 0);
		assert.notEqual(second, first);
		assert.equal(store.find("same", 1), first);
		store.archive("/settings", tree); // Built-ins do not enter native prompt history.
		store.markHistory(store.archive("same", tree));
		assert.equal(store.find("same", 1), first); // Consecutive duplicate collapsed by Pi.
		assert.equal(await store.clear(new UndoTree(snapshot("kept visible text")).export()), true);
		assert.equal(store.find("same", 0), undefined);
		assert.deepEqual(store.history(), ["same", "different", "same"]);
		assert.deepEqual((await readdir(store.directory)).filter((name) => name.endsWith(".json")).sort(), [
			"draft.json",
			"index.json",
		]);
	} finally {
		await store.close();
		await rm(root, { recursive: true, force: true });
	}
});
