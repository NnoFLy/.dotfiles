export type EditorSnapshot = {
	state: { lines: string[]; cursorLine: number; cursorCol: number };
	pastes: [number, string][];
	pasteCounter: number;
};

type UndoNode = { snapshot: EditorSnapshot; parent: number | null; selectedChild: number | null };
export type UndoTreeData = { nodes: UndoNode[]; current: number };

/** A prompt-local tree. Node order is also Vim-style chronological change order. */
export class UndoTree {
	private data: UndoTreeData;

	constructor(initial: EditorSnapshot, saved?: UndoTreeData) {
		this.data = saved
			? structuredClone(saved)
			: {
					nodes: [{ snapshot: structuredClone(initial), parent: null, selectedChild: null }],
					current: 0,
				};
	}

	get snapshot(): EditorSnapshot {
		return structuredClone(this.data.nodes[this.data.current].snapshot);
	}

	export(): UndoTreeData {
		return structuredClone(this.data);
	}

	/** Pi signals undo boundaries; successive typed characters update the same leaf. */
	record(snapshot: EditorSnapshot, boundary: boolean): boolean {
		const node = this.data.nodes[this.data.current];
		const old = node.snapshot;
		const contentChanged =
			JSON.stringify([old.state.lines, old.pastes, old.pasteCounter]) !==
			JSON.stringify([snapshot.state.lines, snapshot.pastes, snapshot.pasteCounter]);
		if (!contentChanged) {
			const moved =
				old.state.cursorLine !== snapshot.state.cursorLine || old.state.cursorCol !== snapshot.state.cursorCol;
			node.snapshot.state.cursorLine = snapshot.state.cursorLine;
			node.snapshot.state.cursorCol = snapshot.state.cursorCol;
			return moved;
		}
		if (boundary || this.data.current === 0 || node.selectedChild !== null) {
			const next = this.data.nodes.length;
			node.selectedChild = next;
			this.data.nodes.push({
				snapshot: structuredClone(snapshot),
				parent: this.data.current,
				selectedChild: null,
			});
			this.data.current = next;
		} else {
			node.snapshot = structuredClone(snapshot);
		}
		return true;
	}

	move(action: "undo" | "redo" | "older" | "newer"): EditorSnapshot | undefined {
		const node = this.data.nodes[this.data.current];
		const target =
			action === "undo"
				? node.parent
				: action === "redo"
					? node.selectedChild
					: this.data.current + (action === "older" ? -1 : 1);
		if (target === null || target < 0 || target >= this.data.nodes.length) return undefined;
		// Selecting a chronological revision selects its path for subsequent redo.
		let child = target;
		while (this.data.nodes[child].parent !== null) {
			const parent = this.data.nodes[child].parent!;
			this.data.nodes[parent].selectedChild = child;
			child = parent;
		}
		this.data.current = target;
		return this.snapshot;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIndex(value: unknown, length: number): value is number {
	return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) < length;
}

/** Disk data is untrusted: reject broken cursors, paste registries and cyclic/invalid trees. */
export function isUndoTreeData(value: unknown): value is UndoTreeData {
	if (
		!isRecord(value) ||
		!Array.isArray(value.nodes) ||
		!value.nodes.length ||
		!isIndex(value.current, value.nodes.length)
	)
		return false;
	const nodes = value.nodes;
	return nodes.every((node: unknown, index: number) => {
		if (!isRecord(node) || !isRecord(node.snapshot)) return false;
		const snapshot = node.snapshot;
		if (!isRecord(snapshot.state)) return false;
		const state = snapshot.state;
		if (
			!Array.isArray(state.lines) ||
			!state.lines.length ||
			!state.lines.every(
				(line: unknown) => typeof line === "string" && !line.includes("\n") && !line.includes("\r"),
			)
		)
			return false;
		if (
			!isIndex(state.cursorLine, state.lines.length) ||
			!Number.isSafeInteger(state.cursorCol) ||
			Number(state.cursorCol) < 0 ||
			Number(state.cursorCol) > state.lines[state.cursorLine].length
		)
			return false;
		if (
			!Number.isSafeInteger(snapshot.pasteCounter) ||
			Number(snapshot.pasteCounter) < 0 ||
			!Array.isArray(snapshot.pastes)
		)
			return false;
		const ids = new Set<number>();
		for (const pair of snapshot.pastes) {
			if (
				!Array.isArray(pair) ||
				pair.length !== 2 ||
				!Number.isSafeInteger(pair[0]) ||
				pair[0] < 1 ||
				pair[0] > Number(snapshot.pasteCounter) ||
				typeof pair[1] !== "string" ||
				ids.has(pair[0])
			)
				return false;
			ids.add(pair[0]);
		}
		if (index === 0 ? node.parent !== null : !isIndex(node.parent, index)) return false;
		return (
			node.selectedChild === null ||
			(isIndex(node.selectedChild, nodes.length) && nodes[node.selectedChild]?.parent === index)
		);
	});
}

/** Emacs-style beginning/end movement, with non-whitespace runs instead of small words. */
export function wordOffset(
	text: string,
	offset: number,
	direction: -1 | 1,
	pastes: ReadonlyMap<number, string>,
): number {
	// A collapsed paste is one indivisible WORD, even though its label contains spaces.
	const atoms = [...text.matchAll(/\[paste #(\d+)(?: (?:\+\d+ lines|\d+ chars))?\]/g)]
		.filter((match) => pastes.has(Number(match[1])))
		.map((match) => ({ start: match.index, end: match.index + match[0].length }));
	const whitespace = (at: number) => /\s/u.test(text[at]);
	let at = offset;
	if (direction === 1) {
		while (at < text.length && whitespace(at)) at++;
		while (at < text.length) {
			const atom = atoms.find((item) => item.start <= at && at < item.end);
			if (atom) at = atom.end;
			else if (whitespace(at)) break;
			else at++;
		}
	} else {
		while (at > 0 && whitespace(at - 1)) at--;
		while (at > 0) {
			const atom = atoms.find((item) => item.start < at && at <= item.end);
			if (atom) at = atom.start;
			else if (whitespace(at - 1)) break;
			else at--;
		}
	}
	return at;
}
