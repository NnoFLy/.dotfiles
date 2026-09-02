import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

/**
 * Private Editor methods used by the Pi 0.83 compatibility adapter below.
 * Audit these before upgrading Pi: they are intentionally not public API.
 */
type Pi083EditorInternals = {
	isOnFirstVisualLine(): boolean;
	isOnLastVisualLine(): boolean;
	moveCursor(verticalDelta: number, horizontalDelta: number): void;
	moveToLineStart(): void;
	moveToLineEnd(): void;
	navigateHistory(direction: number): void;
};

const REQUIRED_PI_083_METHODS: (keyof Pi083EditorInternals)[] = [
	"isOnFirstVisualLine",
	"isOnLastVisualLine",
	"moveCursor",
	"moveToLineStart",
	"moveToLineEnd",
	"navigateHistory",
];

class EmacsEatEditor extends CustomEditor {
	private pi083(): Pi083EditorInternals {
		return this as unknown as Pi083EditorInternals;
	}

	isPi083Compatible(): boolean {
		const editor = this as unknown as Record<string, unknown>;
		return REQUIRED_PI_083_METHODS.every((name) => typeof editor[name] === "function");
	}

	handleInput(data: string): void {
		const ctrlP = matchesKey(data, "ctrl+p");
		const ctrlN = matchesKey(data, "ctrl+n");
		const historyBack = matchesKey(data, "up") || matchesKey(data, "alt+p");
		const historyForward = matchesKey(data, "down") || matchesKey(data, "alt+n");

		// Pi's built-in editor owns vertical keys while a completion list is open.
		// Translate the Emacs history/movement aliases to canonical arrows so the
		// built-in selector, rather than this compatibility layer, handles them.
		if (this.isShowingAutocomplete() && (ctrlP || ctrlN || historyBack || historyForward)) {
			super.handleInput(ctrlP || historyBack ? "\x1b[A" : "\x1b[B");
			return;
		}

		const editor = this.pi083();
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
		if (historyBack) {
			editor.navigateHistory(-1);
			return;
		}
		if (historyForward) {
			editor.navigateHistory(1);
			return;
		}

		super.handleInput(data);
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		let warned = false;
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const editor = new EmacsEatEditor(tui, theme, keybindings);
			if (editor.isPi083Compatible()) return editor;

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
