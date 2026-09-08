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

test("parseInfoString: quoted group value with spaces", () => {
  const info = parseInfoString('ts group="my group"');
  expect(info.group).toBe("my group");
});

test("parseInfoString: unrelated quoted key=value goes to unknown, quotes stripped", () => {
  const info = parseInfoString('ts title="x y" throws');
  expect(info.kind).toBe("throws");
  expect(info.unknown).toEqual(["title=x y"]);
});

test("parseInfoString: group with empty value is treated as absent", () => {
  const info = parseInfoString("ts group=");
  expect(info.group).toBeUndefined();
});
