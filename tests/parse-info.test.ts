import { expect, test } from "bun:test";
import { parseInfoString } from "metonym";

test("parseInfoString: typescript alias maps to ts", () => {
  const info = parseInfoString("typescript throws");
  expect(info.lang).toBe("ts");
  expect(info.kind).toBe("throws");
});

test("parseInfoString: language token is case-insensitive", () => {
  expect(parseInfoString("TS").lang).toBe("ts");
});

test("parseInfoString: javascript alias maps to js", () => {
  expect(parseInfoString("javascript").lang).toBe("js");
});
