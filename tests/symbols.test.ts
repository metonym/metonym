import { expect, test } from "bun:test";
import { scanSymbols } from "../src/parse/symbols";

test("scanSymbols: exported interface gets a SymbolInfo entry", () => {
  const source = `export interface Point {
  x: number;
  y: number;
}`;
  const symbols = scanSymbols("a.ts", source);
  const point = symbols.find((s) => s.name === "Point");
  expect(point).toBeDefined();
  expect(point?.declKind).toBe("interface");
  expect(point?.loc?.start.line).toBe(1);
});

test("scanSymbols: exported type alias gets a SymbolInfo entry", () => {
  const source = `export type Id = string | number;`;
  const symbols = scanSymbols("a.ts", source);
  const id = symbols.find((s) => s.name === "Id");
  expect(id).toBeDefined();
  expect(id?.declKind).toBe("type");
});

test("scanSymbols: non-exported interface is not included", () => {
  const source = `interface Internal { a: string; }
export const x = 1;`;
  const symbols = scanSymbols("a.ts", source);
  expect(symbols.find((s) => s.name === "Internal")).toBeUndefined();
  expect(symbols.find((s) => s.name === "x")).toBeDefined();
});

test("scanSymbols: value and type exports coexist without duplication", () => {
  const source = `export function add(a: number, b: number) { return a + b; }
export interface AddOptions { round?: boolean; }`;
  const symbols = scanSymbols("a.ts", source);
  expect(symbols.map((s) => s.name).sort()).toEqual(["AddOptions", "add"]);
});

test("scanSymbols: an interface field comment with an apostrophe doesn't hide a later export", () => {
  const source = `export interface A {
  /** the caller's id */
  id: string;
}

export interface B {
  name: string;
}`;
  const symbols = scanSymbols("a.ts", source);
  expect(symbols.find((s) => s.name === "A")).toBeDefined();
  expect(symbols.find((s) => s.name === "B")).toBeDefined();
});
