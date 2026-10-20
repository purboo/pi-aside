import { expect, test } from "bun:test";
import piAside from "../src/index.ts";

test("the extension entry point is a function", () => {
	expect(typeof piAside).toBe("function");
});
