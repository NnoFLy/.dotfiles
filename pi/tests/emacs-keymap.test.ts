import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
const extensionUrl = new URL("../.pi/agent/extensions/emacs-eat-editor.ts", import.meta.url);

test("keeps C-p/C-n as text movement", async () => {
	const source = await readFile(extensionUrl, "utf8");
	assert.ok(source.includes('case "\\x10":'));
	assert.ok(source.includes('case "\\x0e":'));
	assert.ok(source.includes('return "text-up"'));
	assert.ok(source.includes('return "text-down"'));
});

test("keeps M-p/M-n as history movement", async () => {
	const source = await readFile(extensionUrl, "utf8");
	assert.ok(source.includes('case "\\x1bp":'));
	assert.ok(source.includes('case "\\x1bn":'));
	assert.ok(source.includes('return "history-previous"'));
	assert.ok(source.includes('return "history-next"'));
});

test("leaves arrow keys to Pi's native editor", async () => {
	const source = await readFile(extensionUrl, "utf8");
	assert.ok(source.includes("Up/down deliberately fall through to Pi"));
	assert.ok(source.includes("super.handleInput(data)"));
});

test("resolves Pi actions behind the C-x prefix", async () => {
	const source = await readFile(extensionUrl, "utf8");
	assert.ok(source.includes('m: "app.model.select"'));
	assert.ok(source.includes('t: "show-thinking"'));
	assert.ok(source.includes('s: "app.session.tree"'));
	assert.ok(source.includes('h: "show-help"'));
	assert.ok(source.includes('ь: "app.model.select"'));
	assert.ok(source.includes('е: "show-thinking"'));
	assert.ok(source.includes('ы: "app.session.tree"'));
	assert.ok(source.includes('р: "show-help"'));
});

test("supports Russian Meta and Control aliases", async () => {
	const source = await readFile(extensionUrl, "utf8");
	assert.ok(source.includes('case "\\x1bз":'));
	assert.ok(source.includes('case "\\x1bт":'));
	assert.ok(source.includes('з: "\\x10"'));
	assert.ok(source.includes('т: "\\x0e"'));
	assert.ok(source.includes('а: "\\x06"'));
	assert.ok(source.includes('и: "\\x02"'));
	assert.ok(source.includes('ф: "\\x01"'));
	assert.ok(source.includes('у: "\\x05"'));
	assert.ok(source.includes('л: "\\x0b"'));
	assert.ok(source.includes('г: "\\x15"'));
	assert.ok(source.includes('ц: "\\x17"'));
	assert.ok(source.includes('н: "\\x19"'));
	assert.ok(source.includes('ч: "\\x18"'));
	assert.ok(source.includes('в: "\\x04"'));
	assert.ok(source.includes('ч: "x"'));
	assert.ok(source.includes('в: "d"'));
});

test("declares the Emacs aliases in Pi's keybinding registry", async () => {
	const keybindings = JSON.parse(
		await readFile(new URL("../.pi/agent/keybindings.json", import.meta.url), "utf8"),
	) as Record<string, string[]>;

	assert.deepEqual(keybindings["tui.editor.cursorUp"], ["up", "ctrl+p"]);
	assert.deepEqual(keybindings["tui.editor.cursorDown"], ["down", "ctrl+n"]);
	assert.deepEqual(keybindings["tui.editor.historyPrevious"], ["alt+p"]);
	assert.deepEqual(keybindings["tui.editor.historyNext"], ["alt+n"]);
	assert.deepEqual(keybindings["tui.editor.cursorLeft"], ["left", "ctrl+b"]);
	assert.deepEqual(keybindings["tui.editor.cursorRight"], ["right", "ctrl+f"]);
	assert.deepEqual(keybindings["tui.editor.cursorWordLeft"], ["alt+left", "ctrl+left", "alt+b"]);
	assert.deepEqual(keybindings["tui.editor.cursorWordRight"], ["alt+right", "ctrl+right", "alt+f"]);
	assert.deepEqual(keybindings["tui.editor.cursorLineStart"], ["home", "ctrl+a"]);
	assert.deepEqual(keybindings["tui.editor.cursorLineEnd"], ["end", "ctrl+e"]);
	assert.deepEqual(keybindings["tui.editor.deleteWordBackward"], ["ctrl+w", "alt+backspace"]);
	assert.deepEqual(keybindings["tui.editor.deleteWordForward"], ["alt+d", "alt+delete"]);
	assert.deepEqual(keybindings["tui.editor.deleteToLineStart"], ["ctrl+u"]);
	assert.deepEqual(keybindings["tui.editor.deleteToLineEnd"], ["ctrl+k"]);
	assert.deepEqual(keybindings["tui.editor.yank"], ["ctrl+y"]);
	assert.deepEqual(keybindings["tui.editor.yankPop"], ["alt+y"]);
	assert.deepEqual(keybindings["tui.select.up"], ["up", "ctrl+p"]);
	assert.deepEqual(keybindings["tui.select.down"], ["down", "ctrl+n"]);
});