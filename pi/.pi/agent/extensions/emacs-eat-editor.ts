import { join } from "node:path";
import {
	CustomEditor,
	getAgentDir,
	type AppKeybinding,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, type KeyId } from "@earendil-works/pi-tui";
import { UndoStorage, type SessionPrompt } from "./emacs-eat/storage.ts";
import { UndoTree, wordOffset, type EditorSnapshot, type UndoTreeData } from "./emacs-eat/undo-tree.ts";

type EmacsKeyAction = "text-up" | "text-down" | "history-previous" | "history-next" | "prefix";
type HistoryAction = "undo" | "redo" | "older" | "newer";
type PiPrefixAction = "app.model.select" | "show-thinking" | "app.session.tree" | "show-help" | HistoryAction;

const PREFIX_ACTIONS: Readonly<Record<string, PiPrefixAction>> = {
	m: "app.model.select",
	t: "show-thinking",
	s: "app.session.tree",
	h: "show-help",
	u: "undo",
	r: "redo",
	"[": "older",
	"]": "newer",
};

// These are the Russian characters on the physical US M/T/S/H keys.
// They are only consumed after C-x, so normal Russian text is unaffected.
const RUSSIAN_PREFIX_ACTIONS: Readonly<Record<string, PiPrefixAction>> = {
	ь: "app.model.select",
	е: "show-thinking",
	ы: "app.session.tree",
	р: "show-help",
	г: "undo",
	к: "redo",
	х: "older",
	ъ: "newer",
};

// Meta keys arrive from a legacy terminal as Escape followed by the
// localized character. Translate them back to Pi's canonical Emacs input.
const RUSSIAN_META_ALIASES: Readonly<Record<string, string>> = {
	"\x1bа": "\x1bf", // M-f
	"\x1bи": "\x1bb", // M-b
	"\x1bв": "\x1bd", // M-d
	"\x1bн": "\x1by", // M-y
};

// Kitty reports the physical base-layout key for non-Latin input. Map the
// Cyrillic key back to that base key before asking pi-tui to match it. This
// is important in Neovim's terminal: Kitty CSI-u input reaches pi unchanged.
const RUSSIAN_TO_LATIN: Readonly<Record<string, string>> = {
	з: "p",
	т: "n",
	а: "f",
	и: "b",
	ф: "a",
	у: "e",
	л: "k",
	г: "u",
	ц: "w",
	н: "y",
	в: "d",
	ч: "x",
	с: "c",
	ь: "m",
	е: "t",
	ы: "s",
	р: "h",
	я: "z",
	к: "r",
	х: "[",
	ъ: "]",
};

// Control characters normally remain layout-independent. These aliases also
// cover terminals that report the localized key through Kitty/CSI-u input.
const RUSSIAN_CONTROL_ALIASES: Readonly<Record<string, string>> = {
	з: "\x10", // C-p
	т: "\x0e", // C-n
	а: "\x06", // C-f
	и: "\x02", // C-b
	ф: "\x01", // C-a
	у: "\x05", // C-e
	л: "\x0b", // C-k
	г: "\x15", // C-u
	ц: "\x17", // C-w
	н: "\x19", // C-y
	в: "\x04", // C-d
	ч: "\x18", // C-x
	с: "\x03", // C-c
	я: "\x1a", // C-z
};

function matchesModifyOtherKeys(data: string, codepoint: number, modifier: number): boolean {
	const match = data.startsWith("\x1b") ? data.slice(1).match(/^\[27;(\d+);(\d+)~$/) : null;
	return match !== null && Number(match[1]) === modifier && Number(match[2]) === codepoint;
}

function matchesRussianKey(data: string, modifier: "ctrl" | "alt" | "ctrl+alt", key: string): boolean {
	const latinKey = RUSSIAN_TO_LATIN[key] ?? key;
	if (matchesKey(data, `${modifier}+${latinKey}` as KeyId)) return true;

	// xterm's modifyOtherKeys has no base-layout field, so match the actual
	// Cyrillic codepoint as a fallback when Kitty CSI-u is unavailable.
	const codepoint = key.codePointAt(0);
	if (codepoint === undefined) return false;
	if (modifier === "alt" && data === `\x1b${key}`) return true;
	return matchesModifyOtherKeys(data, codepoint, modifier === "ctrl" ? 5 : modifier === "alt" ? 3 : 7);
}

function matchesRussianPrintableKey(data: string, key: string): boolean {
	const latinKey = RUSSIAN_TO_LATIN[key] ?? key;
	if (matchesKey(data, latinKey as KeyId) || data === key) return true;

	const codepoint = key.codePointAt(0);
	return codepoint !== undefined && matchesModifyOtherKeys(data, codepoint, 1);
}

function resolveRussianControl(data: string): string | undefined {
	for (const [key, canonicalInput] of Object.entries(RUSSIAN_CONTROL_ALIASES)) {
		if (matchesRussianKey(data, "ctrl", key)) return canonicalInput;
	}
	return undefined;
}

function classifyEmacsKey(data: string): EmacsKeyAction | undefined {
	switch (data) {
		case "\x10":
			return "text-up";
		case "\x0e":
			return "text-down";
		case "\x1bp":
		case "\x1bз":
			return "history-previous";
		case "\x1bn":
		case "\x1bт":
			return "history-next";
		case "\x18":
			return "prefix";
		default:
			return undefined;
	}
}

function resolvePiPrefixAction(data: string): PiPrefixAction | undefined {
	const directAction = PREFIX_ACTIONS[data] ?? RUSSIAN_PREFIX_ACTIONS[data];
	if (directAction) return directAction;

	// Kitty keyboard protocol can report the localized key together with its
	// base US layout key. Let Pi resolve that physical-key relationship too.
	if (matchesRussianPrintableKey(data, "ь") || matchesKey(data, "m")) return "app.model.select";
	if (matchesRussianPrintableKey(data, "е") || matchesKey(data, "t")) return "show-thinking";
	if (matchesRussianPrintableKey(data, "ы") || matchesKey(data, "s")) return "app.session.tree";
	if (matchesRussianPrintableKey(data, "р") || matchesKey(data, "h")) return "show-help";
	for (const [key, action] of [
		["г", "undo"],
		["к", "redo"],
		["х", "older"],
		["ъ", "newer"],
	] as const) {
		if (matchesRussianPrintableKey(data, key)) return action;
	}
	return undefined;
}

/**
 * Private Editor methods used by the compatibility adapter.
 * Keep this surface small and audit it after Pi upgrades.
 */
type PiEditorInternals = {
	isOnFirstVisualLine(): boolean;
	isOnLastVisualLine(): boolean;
	moveCursor(verticalDelta: number, horizontalDelta: number): void;
	moveToLineStart(): void;
	moveToLineEnd(): void;
	navigateHistory(direction: number): void;
	pushUndoSnapshot(): void;
	undo(): void;
	submitValue(): void;
	exitHistoryBrowsing(): void;
	cancelAutocomplete(): void;
	expandPasteMarkers(text: string): string;
	setCursorCol(column: number): void;
	state: EditorSnapshot["state"];
	pastes: Map<number, string>;
	pasteCounter: number;
	lastAction: string | null;
	preferredVisualCol: number | null;
	snappedFromCursorCol: number | null;
	scrollOffset: number;
	jumpMode: string | null;
	isInPaste: boolean;
	history: string[];
	historyIndex: number;
	killRing: {
		push(text: string, options: { prepend: boolean; accumulate: boolean }): void;
	};
};

const REQUIRED_EDITOR_METHODS: (keyof PiEditorInternals)[] = [
	"isOnFirstVisualLine",
	"isOnLastVisualLine",
	"moveCursor",
	"moveToLineStart",
	"moveToLineEnd",
	"navigateHistory",
	"pushUndoSnapshot",
	"undo",
	"submitValue",
	"exitHistoryBrowsing",
	"cancelAutocomplete",
	"expandPasteMarkers",
	"setCursorCol",
];

const PREFIX_STATUS = "Emacs C-x-";

type EmacsEditorOptions = {
	onPrefixStatus: (active: boolean) => void;
	onUnknownPrefix: (key: string) => void;
	onThinkingPicker: () => void;
	onShowHelp: () => void;
	initialTree?: UndoTreeData;
	/** Oldest-first durable recall; Pi's context-rendering replay must not re-add it. */
	initialHistory?: readonly string[];
	onTreeChange?: (tree: UndoTreeData) => void;
	onArchive?: (text: string, tree: UndoTreeData) => string | void;
	onHistoryEntry?: (archiveId: string) => void;
	onSubmitted?: () => void;
	loadArchive?: (text: string, occurrence: number) => Promise<UndoTreeData | undefined>;
};

export class EmacsEatEditor extends CustomEditor {
	private readonly options: EmacsEditorOptions;
	private readonly editorKeybindings: ConstructorParameters<typeof CustomEditor>[2];
	private prefixActive = false;
	private prefixTimer: ReturnType<typeof setTimeout> | undefined;
	private tree: UndoTree | undefined;
	private undoBoundary = false;
	private submitting = false;
	private navigating = false;
	private disposed = false;
	private browsingDraft: UndoTreeData | undefined;
	private browsedTrees = new Map<number, UndoTreeData>();
	private recallLoading = false;
	private recallGeneration = 0;
	private queuedInput: string[] = [];
	private followUpSubmission:
		| { text: string; tree: UndoTreeData; historyAdded: boolean; archived: boolean }
		| undefined;
	private archivedSubmission: { text: string; id: string | void } | undefined;

	constructor(
		tui: ConstructorParameters<typeof CustomEditor>[0],
		theme: ConstructorParameters<typeof CustomEditor>[1],
		keybindings: ConstructorParameters<typeof CustomEditor>[2],
		options: EmacsEditorOptions,
	) {
		super(tui, theme, keybindings);
		this.options = options;
		this.editorKeybindings = keybindings;
		if (!this.isPiCompatible()) return;
		this.tree = new UndoTree(this.snapshot(), options.initialTree);
		if (options.initialHistory) {
			const history: string[] = [];
			for (const text of options.initialHistory) {
				const trimmed = text.trim();
				if (trimmed && history[history.length - 1] !== trimmed) history.push(trimmed);
			}
			this.internals().history = history.reverse();
		}
		this.installHistoryAdapter();
		if (options.initialTree) this.applySnapshot(this.tree.snapshot);
	}

	private internals(): PiEditorInternals {
		return this as unknown as PiEditorInternals;
	}

	isPiCompatible(): boolean {
		const editor = this as unknown as Record<string, unknown>;
		const internals = this.internals();
		return (
			REQUIRED_EDITOR_METHODS.every((name) => typeof editor[name] === "function") &&
			Array.isArray(internals.state?.lines) &&
			internals.pastes instanceof Map &&
			Array.isArray(internals.history) &&
			typeof internals.killRing?.push === "function"
		);
	}

	dispose(): void {
		// Shutdown must not replay queued Enter or application actions into the
		// outgoing session. Cancel the load, preserve visible text, discard keys.
		this.cancelRecall();
		this.capture();
		this.disposed = true;
		this.clearPrefix();
	}

	setText(text: string): void {
		this.finishRecallWithoutArchive();
		this.capture();
		const followUp = this.followUpSubmission;
		const submittingFollowUp = text === "" && followUp && !followUp.archived;
		if (submittingFollowUp) {
			this.archivePrompt(followUp.text, followUp.tree);
			followUp.archived = true;
			if (followUp.historyAdded) this.markHistoryEntry(followUp.text);
		}
		super.setText(text);
		if (submittingFollowUp && this.tree) {
			this.resetPromptTree();
		}
		this.capture();
	}

	addToHistory(text: string): void {
		const trimmed = text.trim();
		if (!trimmed) return;
		if (!this.tree) {
			super.addToHistory(text);
			return;
		}
		const liveSubmission = this.archivedSubmission?.text === trimmed || this.followUpSubmission?.text === trimmed;
		// Pi replays only the active/compacted context while rendering sessions.
		// The complete durable list is already installed; replay would reorder it.
		if (this.options.initialHistory !== undefined && !liveSubmission) return;
		this.recordInputHistory(trimmed);
		// Deliberately no native 100-prompt cap.

		if (this.followUpSubmission?.text === trimmed && !this.followUpSubmission.archived) {
			// Streaming/compaction add history before clearing; idle Alt-Enter
			// clears before onSubmit adds history. Both bind the same archive ID.
			this.followUpSubmission.historyAdded = true;
		} else {
			this.markHistoryEntry(trimmed);
		}
	}

	/** Add a raw RPC/extension input without mutating the visible draft or tree. */
	recordInputHistory(text: string): void {
		const trimmed = text.trim();
		const editor = this.internals();
		if (!trimmed || editor.history[0] === trimmed) return;
		editor.history.unshift(trimmed);
		if (editor.historyIndex >= 0) {
			editor.historyIndex++;
			this.browsedTrees = new Map([...this.browsedTrees].map(([index, tree]) => [index + 1, tree]));
		}
	}

	insertTextAtCursor(text: string): void {
		this.finishRecallWithoutArchive();
		this.capture();
		super.insertTextAtCursor(text);
		this.capture();
	}

	render(width: number): string[] {
		// Also captures asynchronous completions and programmatic editor changes.
		this.capture();
		return super.render(width);
	}

	handleInput(data: string): void {
		if (this.disposed) return;
		if (this.recallLoading) {
			this.queuedInput.push(data);
			return;
		}
		this.capture();
		const followUp =
			!this.prefixActive &&
			!this.internals().isInPaste &&
			this.tree &&
			this.actionHandlers.has("app.message.followUp") &&
			this.editorKeybindings.matches(data, "app.message.followUp");
		if (followUp) {
			this.followUpSubmission = {
				text: this.getExpandedText().trim(),
				tree: this.tree!.export(),
				historyAdded: false,
				archived: false,
			};
		}
		try {
			this.handleEmacsInput(data);
		} finally {
			this.capture();
			if (followUp) {
				if (this.followUpSubmission?.archived) this.options.onSubmitted?.();
				this.followUpSubmission = undefined;
			}
		}
	}

	private handleEmacsInput(data: string): void {
		if (!this.tree || this.internals().isInPaste || data.includes("\x1b[200~")) {
			super.handleInput(data);
			return;
		}
		const translated = RUSSIAN_META_ALIASES[data];
		const localizedControl = resolveRussianControl(data);
		const classified = classifyEmacsKey(data);
		const ctrlP = classified === "text-up" || localizedControl === "\x10" || matchesKey(data, "ctrl+p");
		const ctrlN = classified === "text-down" || localizedControl === "\x0e" || matchesKey(data, "ctrl+n");
		const historyBack = classified === "history-previous" || matchesKey(data, "alt+p");
		const historyForward = classified === "history-next" || matchesKey(data, "alt+n");

		if (this.prefixActive) {
			this.clearPrefix();
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+g") || matchesRussianKey(data, "ctrl", "г"))
				return;

			const action = resolvePiPrefixAction(data);
			if (action === "undo" || action === "redo" || action === "older" || action === "newer") {
				this.travel(action);
				return;
			}
			if (action === "show-thinking") {
				this.options.onThinkingPicker();
				return;
			}
			if (action === "show-help") {
				this.options.onShowHelp();
				return;
			}
			if (action) {
				this.runAppAction(action);
				return;
			}

			this.options.onUnknownPrefix(data);
			return;
		}

		if (matchesKey(data, "ctrl+x") || matchesRussianKey(data, "ctrl", "ч")) {
			this.startPrefix();
			return;
		}

		if (
			data === "\x1f" ||
			matchesKey(data, "ctrl+/") ||
			matchesKey(data, "ctrl+_") ||
			matchesKey(data, "ctrl+shift+-")
		) {
			this.travel("undo");
			return;
		}
		// Never treat legacy DEL as C-?: it is indistinguishable from Backspace.
		if (matchesKey(data, "ctrl+?") || matchesKey(data, "ctrl+shift+/")) {
			this.travel("redo");
			return;
		}
		const wordBack =
			data === "\x1b\x02" || matchesKey(data, "ctrl+alt+b") || matchesRussianKey(data, "ctrl+alt", "и");
		const wordForward =
			data === "\x1b\x06" || matchesKey(data, "ctrl+alt+f") || matchesRussianKey(data, "ctrl+alt", "а");
		const killForward =
			data === "\x1b\x04" || matchesKey(data, "ctrl+alt+d") || matchesRussianKey(data, "ctrl+alt", "в");
		// ESC BS is already legacy M-Backspace. Require an unambiguous protocol
		// event for C-M-Backspace rather than steal the existing small-word kill.
		const killBackward = matchesKey(data, "ctrl+alt+backspace");
		if (wordBack || wordForward || killForward || killBackward) {
			this.wordCommand(wordBack || killBackward ? -1 : 1, killForward || killBackward);
			return;
		}

		// C-p/C-n are text movement only. Completion menus still use them as
		// their vertical selection aliases, matching normal Emacs minibuffers.
		if (this.isShowingAutocomplete() && (ctrlP || ctrlN)) {
			super.handleInput(ctrlP ? "\x1b[A" : "\x1b[B");
			return;
		}

		const editor = this.internals();
		if (ctrlP) {
			if (editor.isOnFirstVisualLine()) editor.moveToLineStart();
			else editor.moveCursor(-1, 0);
			return;
		}
		if (ctrlN) {
			if (editor.isOnLastVisualLine()) editor.moveToLineEnd();
			else editor.moveCursor(1, 0);
			return;
		}

		// M-p/M-n always browse prompt history. Cancel completion first so the
		// history entry is not hidden behind the completion list.
		if (historyBack || historyForward) {
			if (this.isShowingAutocomplete()) super.handleInput("\x1b");
			editor.navigateHistory(historyBack ? -1 : 1);
			return;
		}

		if (localizedControl) {
			super.handleInput(localizedControl);
			return;
		}
		if (translated) {
			super.handleInput(translated);
			return;
		}

		// Up/down deliberately fall through to Pi. Its native behavior moves
		// through text and only browses history at the appropriate boundary.
		super.handleInput(data);
	}

	private snapshot(): EditorSnapshot {
		const editor = this.internals();
		return structuredClone({
			state: editor.state,
			pastes: [...editor.pastes],
			pasteCounter: editor.pasteCounter,
		});
	}

	private capture(): void {
		if (!this.tree || this.submitting || this.navigating || this.recallLoading || this.disposed) return;
		if (this.tree.record(this.snapshot(), this.undoBoundary)) this.options.onTreeChange?.(this.tree.export());
		this.undoBoundary = false;
	}

	private archivePrompt(text: string, tree: UndoTreeData): void {
		if (!text) return;
		this.archivedSubmission = { text, id: this.options.onArchive?.(text, tree) };
	}

	private markHistoryEntry(text: string): void {
		if (this.archivedSubmission?.text !== text) return;
		if (typeof this.archivedSubmission.id === "string") this.options.onHistoryEntry?.(this.archivedSubmission.id);
		this.archivedSubmission = undefined;
	}

	private resetPromptTree(): void {
		this.tree = new UndoTree(this.snapshot());
		this.undoBoundary = false;
		this.browsingDraft = undefined;
		this.browsedTrees.clear();
		this.options.onTreeChange?.(this.tree.export());
	}

	private installHistoryAdapter(): void {
		const editor = this.internals();
		editor.pushUndoSnapshot = () => {
			this.capture();
			this.undoBoundary = true;
		};
		editor.undo = () => this.travel("undo");
		const submit = editor.submitValue.bind(this);
		editor.submitValue = () => {
			this.capture();
			const text = this.getExpandedText().trim();
			if (text && this.tree) this.archivePrompt(text, this.tree.export());
			this.submitting = true;
			try {
				submit();
			} finally {
				this.submitting = false;
				this.resetPromptTree();
				this.options.onSubmitted?.();
			}
		};
		const navigate = editor.navigateHistory.bind(this);
		editor.navigateHistory = (direction) => this.browseHistory(direction, navigate);
		// Kill-ring entries must contain real text, not ephemeral paste labels.
		// Otherwise C-y after submission can insert a dangling [paste #N] marker.
		const pushKill = editor.killRing.push.bind(editor.killRing);
		editor.killRing.push = (text, options) => pushKill(editor.expandPasteMarkers(text), options);
	}

	private applySnapshot(snapshot: EditorSnapshot, keepHistory = false): void {
		const editor = this.internals();
		editor.cancelAutocomplete();
		if (!keepHistory) editor.exitHistoryBrowsing();
		editor.state = structuredClone(snapshot.state);
		editor.pastes = new Map(snapshot.pastes);
		editor.pasteCounter = snapshot.pasteCounter;
		editor.lastAction = null; // M-y is invalid after movement, undo, redo or recall.
		editor.preferredVisualCol = null;
		editor.snappedFromCursorCol = null;
		editor.scrollOffset = 0;
		editor.jumpMode = null;
		this.onChange?.(this.getText());
		this.tui.requestRender();
	}

	private travel(action: HistoryAction): void {
		this.capture();
		this.internals().lastAction = null;
		this.internals().cancelAutocomplete();
		const snapshot = this.tree?.move(action);
		if (!snapshot) return;
		this.applySnapshot(snapshot);
		this.undoBoundary = false;
		this.options.onTreeChange?.(this.tree!.export());
	}

	private browseHistory(direction: number, navigate: (direction: number) => void): void {
		this.capture();
		const editor = this.internals();
		const before = editor.historyIndex;
		if (before === -1) {
			this.browsingDraft = this.tree?.export();
			this.browsedTrees.clear();
		} else if (this.tree) this.browsedTrees.set(before, this.tree.export());
		this.navigating = true;
		try {
			navigate(direction);
		} finally {
			this.navigating = false;
			this.undoBoundary = false;
		}
		const after = editor.historyIndex;
		if (after === before) return;
		const saved = after === -1 ? this.browsingDraft : this.browsedTrees.get(after);
		if (after >= 0 && !saved) {
			editor.pastes.clear();
			editor.pasteCounter = 0;
		}
		this.tree = new UndoTree(this.snapshot(), saved);
		if (saved) {
			this.applySnapshot(this.tree.snapshot, true);
			this.options.onTreeChange?.(this.tree.export());
			return;
		}
		const text = editor.history[after];
		const occurrence = editor.history.slice(0, after).filter((entry) => entry === text).length;
		if (after === -1 || !this.options.loadArchive) {
			this.options.onTreeChange?.(this.tree.export());
			return;
		}
		const generation = ++this.recallGeneration;
		this.recallLoading = true;
		// Queue input while reading so an immediate undo cannot race the restored tree.
		void this.options
			.loadArchive(text, occurrence)
			.then((tree) => {
				if (this.disposed || generation !== this.recallGeneration) return;
				if (tree) {
					this.tree = new UndoTree(this.snapshot(), tree);
					this.applySnapshot(this.tree.snapshot, true);
				}
			})
			.catch(() => {})
			.finally(() => {
				if (this.disposed || generation !== this.recallGeneration) return;
				this.recallLoading = false;
				this.options.onTreeChange?.(this.tree!.export());
				const queued = this.queuedInput.splice(0);
				for (const input of queued) this.handleInput(input);
			});
	}

	private wordCommand(direction: -1 | 1, kill: boolean): void {
		const editor = this.internals();
		editor.cancelAutocomplete();
		const text = this.getText();
		const offset =
			editor.state.lines.slice(0, editor.state.cursorLine).reduce((sum, line) => sum + line.length + 1, 0) +
			editor.state.cursorCol;
		const target = wordOffset(text, offset, direction, editor.pastes);
		if (kill && target !== offset) {
			const start = Math.min(offset, target);
			const end = Math.max(offset, target);
			const accumulate = editor.lastAction === "kill";
			editor.pushUndoSnapshot();
			editor.killRing.push(text.slice(start, end), { prepend: direction < 0, accumulate });
			editor.state.lines = (text.slice(0, start) + text.slice(end)).split("\n");
			const before = text.slice(0, start).split("\n");
			editor.state.cursorLine = before.length - 1;
			editor.setCursorCol(before[before.length - 1].length);
			editor.lastAction = "kill";
			editor.exitHistoryBrowsing();
			this.onChange?.(this.getText());
		} else {
			const before = text.slice(0, target).split("\n");
			editor.state.cursorLine = before.length - 1;
			editor.setCursorCol(before[before.length - 1].length);
			editor.lastAction = null;
		}
		this.tui.requestRender();
	}

	private cancelRecall(): string[] {
		this.recallGeneration++;
		this.recallLoading = false;
		return this.queuedInput.splice(0);
	}

	private finishRecallWithoutArchive(): void {
		while (this.recallLoading) {
			for (const input of this.cancelRecall()) this.handleInput(input);
		}
	}

	restoreUndoTree(tree: UndoTreeData): void {
		this.finishRecallWithoutArchive();
		this.tree = new UndoTree(this.snapshot(), tree);
		this.applySnapshot(this.tree.snapshot);
		this.undoBoundary = false;
		this.options.onTreeChange?.(this.tree.export());
	}

	clearUndoHistory(): UndoTreeData {
		this.cancelRecall();
		this.tree = new UndoTree(this.snapshot());
		this.browsingDraft = undefined;
		this.browsedTrees.clear();
		this.internals().exitHistoryBrowsing();
		this.internals().lastAction = null;
		this.archivedSubmission = undefined;
		return this.tree.export();
	}

	private runAppAction(action: Exclude<PiPrefixAction, "show-thinking" | "show-help" | HistoryAction>): void {
		const handler = this.actionHandlers.get(action as AppKeybinding);
		if (handler) handler();
		else this.options.onUnknownPrefix(action);
	}

	private startPrefix(): void {
		this.internals().lastAction = null;
		this.prefixActive = true;
		this.options.onPrefixStatus(true);
		if (this.prefixTimer) clearTimeout(this.prefixTimer);
		this.prefixTimer = setTimeout(() => this.clearPrefix(), 1_500);
	}

	private clearPrefix(): void {
		if (this.prefixTimer) clearTimeout(this.prefixTimer);
		this.prefixTimer = undefined;
		if (!this.prefixActive) return;
		this.prefixActive = false;
		this.options.onPrefixStatus(false);
	}
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];

function sessionPrompts(ctx: ExtensionContext): SessionPrompt[] {
	return ctx.sessionManager.getEntries().flatMap((entry) => {
		if (entry.type !== "message" || entry.message?.role !== "user") return [];
		const content = entry.message.content;
		const text =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content
							.flatMap((part) =>
								part?.type === "text" && typeof part.text === "string" ? [part.text] : [],
							)
							.join("\n")
					: "";
		return [{ id: entry.id, text }];
	});
}

export default function (pi: ExtensionAPI) {
	let storage: UndoStorage | undefined;
	let activeEditor: EmacsEatEditor | undefined;
	let activeSessionId: string | undefined;

	const checkpointDelivery = async (ctx: ExtensionContext) => {
		if (!storage || !activeEditor || ctx.sessionManager.getSessionId() !== activeSessionId) return;
		// context/agent_end occur after user messages have been persisted. Raw
		// inputs already have their own stable ledger IDs and archive ownership;
		// the model projection's IDs only prevent importing those inputs again.
		storage.coverDelivered(
			ctx.sessionManager
				.getEntries()
				.flatMap((entry) => (entry.type === "message" && entry.message?.role === "user" ? [entry.id] : [])),
		);
		await storage.flush();
	};

	pi.on("input", (event, ctx) => {
		if (!storage || !activeEditor || ctx.sessionManager.getSessionId() !== activeSessionId) return;
		// Interactive inputs are captured by the editor, including commands that
		// bypass the input hook. Programmatic inputs need a text-only ledger row.
		if (event.source !== "interactive") {
			storage.recordInput(event.text);
			activeEditor.recordInputHistory(event.text);
		}
	});
	pi.on("context", async (_event, ctx) => {
		await checkpointDelivery(ctx);
	});
	pi.on("agent_end", async (_event, ctx) => {
		await checkpointDelivery(ctx);
	});
	pi.on("session_before_compact", async (_event, ctx) => {
		await checkpointDelivery(ctx);
	});

	pi.registerCommand("emacs-undo-clear", {
		description: "Delete this session's saved prompt undo trees (including deleted text)",
		handler: async (_args, ctx) => {
			if (!activeEditor || !storage) return;
			if (
				!(await ctx.ui.confirm(
					"Clear Emacs undo archive?",
					"Delete all saved undo branches for this Pi session? The visible editor text is kept.",
				))
			)
				return;
			const cleared = await storage.clear(activeEditor.clearUndoHistory());
			ctx.ui.notify(
				cleared ? "Emacs undo archive cleared" : "Could not clear Emacs undo archive",
				cleared ? "info" : "warning",
			);
		},
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		activeEditor?.dispose();
		await checkpointDelivery(ctx);
		await storage?.close();
		activeEditor = undefined;
		storage = undefined;
		activeSessionId = undefined;
	});

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const sessionStorage = new UndoStorage(
			join(getAgentDir(), "emacs-undo"),
			ctx.sessionManager.getSessionId(),
			(message) => ctx.ui.notify(message, "warning"),
		);
		storage = sessionStorage;
		activeSessionId = ctx.sessionManager.getSessionId();
		const saved = await sessionStorage.start();
		// getEntries includes original messages on every conversation branch,
		// including those no longer present in the compacted model context.
		sessionStorage.recoverHistory(sessionPrompts(ctx));
		const liveText = ctx.ui.getEditorText();
		const initialTree =
			saved && (!liveText || liveText === saved.nodes[saved.current].snapshot.state.lines.join("\n"))
				? saved
				: undefined;
		let warned = false;
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			let editor: EmacsEatEditor | undefined;
			const candidate = new EmacsEatEditor(tui, theme, keybindings, {
				initialTree,
				initialHistory: sessionStorage.history(),
				onTreeChange: (tree) => sessionStorage.saveDraft(tree),
				onArchive: (text, tree) => sessionStorage.archive(text, tree),
				onHistoryEntry: (id) => sessionStorage.markHistory(id),
				onSubmitted: () => {
					void sessionStorage.flush();
				},
				loadArchive: async (text, occurrence) => {
					const id = sessionStorage.find(text, occurrence);
					return id ? sessionStorage.load(id) : undefined;
				},
				onPrefixStatus: (active) => ctx.ui.setStatus("emacs-keymap", active ? PREFIX_STATUS : "Emacs"),
				onUnknownPrefix: (key) => ctx.ui.notify(`Unknown Emacs prefix: C-x ${key}`, "warning"),
				onThinkingPicker: () => {
					void (async () => {
						const selected = await ctx.ui.select(`Thinking level (current: ${pi.getThinkingLevel()})`, [
							...THINKING_LEVELS,
						]);
						if (selected && THINKING_LEVELS.includes(selected as ThinkingLevel)) {
							pi.setThinkingLevel(selected as ThinkingLevel);
						}
					})();
				},
				onShowHelp: () => {
					if (!editor) return;
					editor.setText("/hotkeys");
					editor.handleInput("\r");
				},
			});
			editor = candidate;

			if (candidate.isPiCompatible()) {
				activeEditor = candidate;
				ctx.ui.setStatus("emacs-keymap", "Emacs");
				return candidate;
			}

			ctx.ui.setStatus("emacs-keymap", undefined);
			if (!warned) {
				warned = true;
				ctx.ui.notify("emacs-eat-editor disabled: Pi's private Editor API changed", "warning");
			}
			return new CustomEditor(tui, theme, keybindings);
		});
		// Pi copies the previous editor's text into the replacement after creating
		// it. Restore the saved tree afterward, including collapsed paste metadata.
		if (initialTree) activeEditor?.restoreUndoTree(initialTree);
	});
}
