import { CustomEditor, type AppKeybinding, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, type KeyId } from "@earendil-works/pi-tui";

type EmacsKeyAction = "text-up" | "text-down" | "history-previous" | "history-next" | "prefix";
type PiPrefixAction = "app.model.select" | "show-thinking" | "app.session.tree" | "show-help";

const PREFIX_ACTIONS: Readonly<Record<string, PiPrefixAction>> = {
	m: "app.model.select",
	t: "show-thinking",
	s: "app.session.tree",
	h: "show-help",
};

// These are the Russian characters on the physical US M/T/S/H keys.
// They are only consumed after C-x, so normal Russian text is unaffected.
const RUSSIAN_PREFIX_ACTIONS: Readonly<Record<string, PiPrefixAction>> = {
	ь: "app.model.select",
	е: "show-thinking",
	ы: "app.session.tree",
	р: "show-help",
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
	const match = data.match(/^\x1b\[27;(\d+);(\d+)~$/);
	return match !== null && Number(match[1]) === modifier && Number(match[2]) === codepoint;
}

function matchesRussianKey(data: string, modifier: "ctrl" | "alt", key: string): boolean {
	const latinKey = RUSSIAN_TO_LATIN[key] ?? key;
	if (matchesKey(data, `${modifier}+${latinKey}` as KeyId)) return true;

	// xterm's modifyOtherKeys has no base-layout field, so match the actual
	// Cyrillic codepoint as a fallback when Kitty CSI-u is unavailable.
	const codepoint = key.codePointAt(0);
	if (codepoint === undefined) return false;
	if (modifier === "alt" && data === `\x1b${key}`) return true;
	return matchesModifyOtherKeys(data, codepoint, modifier === "ctrl" ? 5 : 3);
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
};

const REQUIRED_EDITOR_METHODS: (keyof PiEditorInternals)[] = [
	"isOnFirstVisualLine",
	"isOnLastVisualLine",
	"moveCursor",
	"moveToLineStart",
	"moveToLineEnd",
	"navigateHistory",
];

const PREFIX_STATUS = "Emacs C-x-";

type EmacsEditorOptions = {
	onPrefixStatus: (active: boolean) => void;
	onUnknownPrefix: (key: string) => void;
	onThinkingPicker: () => void;
	onShowHelp: () => void;
};

export class EmacsEatEditor extends CustomEditor {
	private readonly options: EmacsEditorOptions;
	private prefixActive = false;
	private prefixTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		tui: ConstructorParameters<typeof CustomEditor>[0],
		theme: ConstructorParameters<typeof CustomEditor>[1],
		keybindings: ConstructorParameters<typeof CustomEditor>[2],
		options: EmacsEditorOptions,
	) {
		super(tui, theme, keybindings);
		this.options = options;
	}

	private internals(): PiEditorInternals {
		return this as unknown as PiEditorInternals;
	}

	isPiCompatible(): boolean {
		const editor = this as unknown as Record<string, unknown>;
		return REQUIRED_EDITOR_METHODS.every((name) => typeof editor[name] === "function");
	}

	dispose(): void {
		this.clearPrefix();
	}

	handleInput(data: string): void {
		const translated = RUSSIAN_META_ALIASES[data];
		const localizedControl = resolveRussianControl(data);
		const classified = classifyEmacsKey(data);
		const ctrlP = classified === "text-up" || localizedControl === "\x10" || matchesKey(data, "ctrl+p");
		const ctrlN = classified === "text-down" || localizedControl === "\x0e" || matchesKey(data, "ctrl+n");
		const historyBack = classified === "history-previous" || matchesKey(data, "alt+p");
		const historyForward = classified === "history-next" || matchesKey(data, "alt+n");

		if (this.prefixActive) {
			this.clearPrefix();
			if (matchesKey(data, "escape")) return;

			const action = resolvePiPrefixAction(data);
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

	private runAppAction(action: Exclude<PiPrefixAction, "show-thinking" | "show-help">): void {
		const handler = this.actionHandlers.get(action as AppKeybinding);
		if (handler) handler();
		else this.options.onUnknownPrefix(action);
	}

	private startPrefix(): void {
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

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		let warned = false;
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			let editor: EmacsEatEditor | undefined;
			const activeEditor = new EmacsEatEditor(tui, theme, keybindings, {
				onPrefixStatus: (active) => ctx.ui.setStatus("emacs-keymap", active ? PREFIX_STATUS : "Emacs"),
				onUnknownPrefix: (key) => ctx.ui.notify(`Unknown Emacs prefix: C-x ${key}`, "warning"),
				onThinkingPicker: () => {
					void (async () => {
						const selected = await ctx.ui.select(
							`Thinking level (current: ${pi.getThinkingLevel()})`,
							[...THINKING_LEVELS],
						);
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
			editor = activeEditor;

			if (activeEditor.isPiCompatible()) {
				ctx.ui.setStatus("emacs-keymap", "Emacs");
				return activeEditor;
			}

			ctx.ui.setStatus("emacs-keymap", undefined);
			if (!warned) {
				warned = true;
				ctx.ui.notify(
					"emacs-eat-editor disabled: Pi's private Editor API changed",
					"warning",
				);
			}
			return new CustomEditor(tui, theme, keybindings);
		});
	});
}
