// docs/ux.md §3.1 (question-mark rule, U9), §3.3 (handoff line), §3.4 (route line).
import { expect, test } from "bun:test";
import { endsWithQuestionMark, routeEnter } from "../src/qmark.ts";
import { parseReply } from "../src/reply.ts";

function check(name: string, actual: unknown, expected: unknown): void {
	test(name, () => expect(actual).toEqual(expected));
}

// --- endsWithQuestionMark (U9) ---
const q: Array<[string, boolean]> = [
	["why did it pick B?", true],
	["为什么选 B？", true],
	["why?   \n\n", true],
	["为什么？\u3000", true],
	["?", true],
	["(is that right?)", true],
	['he asked "why?"', true],
	["he asked 'why?'", true],
	["she said “why?”", true],
	["「为什么？」", true],
	["『本当？』", true],
	["（对吗？）", true],
	["«pourquoi?»", true],
	["[why?] ", true],
	["¿por qué?", true],
	["لماذا؟", true],
	["τι κάνεις\u037e", true],
	["semicolon;", false],
	["这个是生成的吗", false],
	["这个是生成的呢", false],
	["right", false],
	["stop deleting the tests", false],
	["really?!", false],
	["fix it!", false],
	["", false],
	["   \n", false],
	["look at this:\n```\nwhat?\n", false],
	["look at this:\n```js\nconst a = b?\n", false],
	["```\ncode?\n```", false],
	["```\na\n```\nwhy?", true],
	["~~~\nb\n~~~\nok?", true],
	["~~~\nx?\n~~~", false],
	["````\n```\nx?\n", false],
	["````\n```\n````\nwhy?", true],
	["   ```\ninside?", false],
	["inline `code?` ends here?", true],
];
for (const [text, want] of q) check(`endsWithQuestionMark(${JSON.stringify(text)})`, endsWithQuestionMark(text), want);

// --- routeEnter (ux §3.1 table) ---
const r: Array<[Parameters<typeof routeEnter>[0], "side" | "pi"]> = [
	[{ text: "why B?", busy: true, key: "submit" }, "side"],
	[{ text: "  why B?  ", busy: true, key: "submit" }, "side"],
	[{ text: "为什么？", busy: true, key: "submit" }, "side"],
	[{ text: "why B?", busy: false, key: "submit" }, "pi"],
	[{ text: "why B?", busy: true, key: "followUp" }, "pi"],
	[{ text: "use approach A", busy: true, key: "submit" }, "pi"],
	[{ text: "/aside why?", busy: true, key: "submit" }, "pi"],
	[{ text: "  /model?", busy: true, key: "submit" }, "pi"],
	[{ text: "!ls?", busy: true, key: "submit" }, "pi"],
	[{ text: "", busy: true, key: "submit" }, "pi"],
	[{ text: "```\nwhat?", busy: true, key: "submit" }, "pi"],
];
for (const [input, want] of r) check(`routeEnter(${JSON.stringify(input)})`, routeEnter(input), want);

// --- parseReply (ux §3.3, §3.4) ---
type R = ReturnType<typeof parseReply>;
const p: Array<[string, boolean, R]> = [
	["route: side\nA touches three callers.", true, { route: "side", body: "A touches three callers.", handoff: undefined }],
	["route: agent\n", true, { route: "agent", body: "", handoff: undefined }],
	["route: side", true, { route: "side", body: "", handoff: undefined }],
	["route: side", false, { route: undefined, body: "", handoff: undefined }],
	["rou", false, { route: undefined, body: "", handoff: undefined }],
	["route:", false, { route: undefined, body: "", handoff: undefined }],
	["", false, { route: undefined, body: "", handoff: undefined }],
	["\n  Route: AGENT  \nbecause", true, { route: "agent", body: "because", handoff: undefined }],
	["`route: side`\nok", true, { route: "side", body: "ok", handoff: undefined }],
	["**route: side**\nok", true, { route: "side", body: "ok", handoff: undefined }],
	["route : side\nok", true, { route: "side", body: "ok", handoff: undefined }],
	["route: side\nstreaming so f", false, { route: "side", body: "streaming so f", handoff: undefined }],
	["The answer is 42.", true, { route: "side", body: "The answer is 42.", handoff: undefined }],
	["The answer is", false, { route: "side", body: "The answer is", handoff: undefined }],
	[
		"route: side\nUse A.\nhandoff: switch to approach A (see side note)",
		true,
		{ route: "side", body: "Use A.", handoff: "switch to approach A (see side note)" },
	],
	["route: side\nUse A.\nhandoff: do B\n\n", true, { route: "side", body: "Use A.", handoff: "do B" }],
	["route: side\nUse A.\nHandoff:  do B  ", true, { route: "side", body: "Use A.", handoff: "do B" }],
	["route: side\nUse A.\nhandoff: none", true, { route: "side", body: "Use A.", handoff: undefined }],
	["route: side\nUse A.\nhandoff:", true, { route: "side", body: "Use A.", handoff: undefined }],
	["route: side\nUse A.\nhandoff: swi", false, { route: "side", body: "Use A.", handoff: undefined }],
	["route: side\nUse A.\nhand", false, { route: "side", body: "Use A.", handoff: undefined }],
	["route: side\nhandoff: x\nmore text", true, { route: "side", body: "handoff: x\nmore text", handoff: undefined }],
	["route: side\r\nWindows\r\n", true, { route: "side", body: "Windows", handoff: undefined }],
	["route: side\n\nPara one.\n\nPara two.\n", true, { route: "side", body: "Para one.\n\nPara two.", handoff: undefined }],
];
const norm = (x: R) => ({ route: x.route ?? null, body: x.body, handoff: x.handoff ?? null });
for (const [raw, done, want] of p) check(`parseReply(${JSON.stringify(raw)}, ${done})`, norm(parseReply(raw, done)), norm(want));
