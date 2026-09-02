import { expect, test } from "bun:test";
import { type Decl, scanDecls } from "../src/parse/decls";

function findDecl(decls: Decl[], name: string): Decl | undefined {
  return decls.find((d) => d.name === name);
}

test("decls: export function", () => {
  const source = "export function foo() {}";
  const decls = scanDecls(source);

  expect(decls.length).toBe(1);
  const decl = decls[0];
  expect(decl.name).toBe("foo");
  expect(decl.declKind).toBe("function");
  expect(decl.line).toBe(1);
  expect(decl.column).toBe(17); // position of 'foo'
  expect(decl.offset).toBeGreaterThanOrEqual(0);
  expect(decl.reexportFrom).toBeUndefined();
});

test("decls: export async function", () => {
  const source = "export async function bar() {}";
  const decls = scanDecls(source);

  expect(decls.length).toBe(1);
  expect(decls[0].name).toBe("bar");
  expect(decls[0].declKind).toBe("function");
});

test("decls: export function*", () => {
  const source = "export function* gen() {}";
  const decls = scanDecls(source);

  expect(decls.length).toBe(1);
  expect(decls[0].name).toBe("gen");
  expect(decls[0].declKind).toBe("function");
});

test("decls: export class", () => {
  const source = "export class MyClass {}";
  const decls = scanDecls(source);

  expect(decls.length).toBe(1);
  const decl = decls[0];
  expect(decl.name).toBe("MyClass");
  expect(decl.declKind).toBe("class");
  expect(decl.line).toBe(1);
  expect(decl.column).toBe(14); // position of 'MyClass'
});

test("decls: export abstract class", () => {
  const source = "export abstract class Base {}";
  const decls = scanDecls(source);

  expect(decls.length).toBe(1);
  expect(decls[0].name).toBe("Base");
  expect(decls[0].declKind).toBe("class");
});

test("decls: export const", () => {
  const source = "export const x = 5;";
  const decls = scanDecls(source);

  expect(decls.length).toBe(1);
  expect(decls[0].name).toBe("x");
  expect(decls[0].declKind).toBe("const");
});

test("decls: export let", () => {
  const source = "export let y = 10;";
  const decls = scanDecls(source);

  expect(decls.length).toBe(1);
  expect(decls[0].name).toBe("y");
  expect(decls[0].declKind).toBe("let");
});

test("decls: export var", () => {
  const source = "export var z = 20;";
  const decls = scanDecls(source);

  expect(decls.length).toBe(1);
  expect(decls[0].name).toBe("z");
  expect(decls[0].declKind).toBe("var");
});

test("decls: export enum", () => {
  const source = "export enum Color { Red, Green, Blue }";
  const decls = scanDecls(source);

  expect(decls.length).toBe(1);
  expect(decls[0].name).toBe("Color");
  expect(decls[0].declKind).toBe("enum");
});

test("decls: export const enum", () => {
  const source = "export const enum Status { Active, Inactive }";
  const decls = scanDecls(source);

  expect(decls.length).toBe(1);
  expect(decls[0].name).toBe("Status");
  expect(decls[0].declKind).toBe("enum");
});

test("decls: export type", () => {
  const source = "export type Point = { x: number; y: number };";
  const decls = scanDecls(source);

  expect(decls.length).toBe(1);
  expect(decls[0].name).toBe("Point");
  expect(decls[0].declKind).toBe("type");
});

test("decls: export interface", () => {
  const source = "export interface Animal { name: string; }";
  const decls = scanDecls(source);

  expect(decls.length).toBe(1);
  expect(decls[0].name).toBe("Animal");
  expect(decls[0].declKind).toBe("interface");
});

test("decls: export default", () => {
  const source = "export default MyDefault;";
  const decls = scanDecls(source);

  expect(decls.length).toBe(1);
  expect(decls[0].name).toBe("default");
  expect(decls[0].declKind).toBe("default");
});

test("decls: export { a, b }", () => {
  const source = "export { foo, bar };";
  const decls = scanDecls(source);

  expect(decls.length).toBe(2);
  expect(findDecl(decls, "foo")).toBeDefined();
  expect(findDecl(decls, "bar")).toBeDefined();
  expect(decls[0].declKind).toBe("unknown");
  expect(decls[1].declKind).toBe("unknown");
});

test("decls: export { a as b, c }", () => {
  const source = "export { helper as util, other };";
  const decls = scanDecls(source);

  expect(decls.length).toBe(2);
  expect(findDecl(decls, "util")).toBeDefined();
  expect(findDecl(decls, "other")).toBeDefined();
  expect(findDecl(decls, "helper")).toBeUndefined(); // only exported name
});

test("decls: export { ... } from module", () => {
  const source = 'export { foo, bar } from "./utils";';
  const decls = scanDecls(source);

  expect(decls.length).toBe(2);
  const fooDecl = findDecl(decls, "foo");
  const barDecl = findDecl(decls, "bar");
  expect(fooDecl).toBeDefined();
  expect(barDecl).toBeDefined();
  expect(fooDecl?.declKind).toBe("reexport");
  expect(barDecl?.declKind).toBe("reexport");
  expect(fooDecl?.reexportFrom).toBe("./utils");
  expect(barDecl?.reexportFrom).toBe("./utils");
});

test("decls: export * from module", () => {
  const source = 'export * from "./everything";';
  const decls = scanDecls(source);

  expect(decls.length).toBe(1);
  const starDecl = decls[0];
  expect(starDecl.name).toBe("*");
  expect(starDecl.declKind).toBe("reexport");
  expect(starDecl.reexportFrom).toBe("./everything");
});

test("decls: export type { ... } from module", () => {
  const source = 'export type { TypeA, TypeB } from "./types";';
  const decls = scanDecls(source);

  expect(decls.length).toBe(2);
  const typeA = findDecl(decls, "TypeA");
  const typeB = findDecl(decls, "TypeB");
  expect(typeA).toBeDefined();
  expect(typeB).toBeDefined();
  expect(typeA?.declKind).toBe("reexport");
  expect(typeB?.declKind).toBe("reexport");
});

test("decls: multi-line export list", () => {
  const source = `export {
  alpha,
  beta,
  gamma
};`;
  const decls = scanDecls(source);

  expect(decls.length).toBe(3);
  expect(findDecl(decls, "alpha")).toBeDefined();
  expect(findDecl(decls, "beta")).toBeDefined();
  expect(findDecl(decls, "gamma")).toBeDefined();
});

test("decls: export const { a, b }", () => {
  const source = "export const { x, y } = obj;";
  const decls = scanDecls(source);

  expect(decls.length).toBe(2);
  expect(findDecl(decls, "x")).toBeDefined();
  expect(findDecl(decls, "y")).toBeDefined();
  expect(findDecl(decls, "x")?.declKind).toBe("const");
  expect(findDecl(decls, "y")?.declKind).toBe("const");
});

test("decls: export const { a: b, c }", () => {
  const source = "export const { prop: name, other } = data;";
  const decls = scanDecls(source);

  expect(decls.length).toBe(2);
  expect(findDecl(decls, "name")).toBeDefined();
  expect(findDecl(decls, "other")).toBeDefined();
  expect(findDecl(decls, "prop")).toBeUndefined();
});

test("decls: export const [a, b]", () => {
  const source = "export const [first, second] = arr;";
  const decls = scanDecls(source);

  expect(decls.length).toBe(2);
  expect(findDecl(decls, "first")).toBeDefined();
  expect(findDecl(decls, "second")).toBeDefined();
  expect(findDecl(decls, "first")?.declKind).toBe("const");
});

test("decls: skip export in line comment", () => {
  const source = `// export function bogus() {}
export function real() {}`;
  const decls = scanDecls(source);

  expect(decls.length).toBe(1);
  expect(decls[0].name).toBe("real");
});

test("decls: skip export in block comment", () => {
  const source = `/* export const fake = 1; */
export const actual = 2;`;
  const decls = scanDecls(source);

  expect(decls.length).toBe(1);
  expect(decls[0].name).toBe("actual");
});

test("decls: skip export in string", () => {
  const source = `const str = "export const inside = 1";
export const outside = 2;`;
  const decls = scanDecls(source);

  expect(decls.length).toBe(1);
  expect(decls[0].name).toBe("outside");
});

test("decls: skip export in single-quoted string", () => {
  const source = `const s = 'export class Fake {}';
export class Real {}`;
  const decls = scanDecls(source);

  expect(decls.length).toBe(1);
  expect(decls[0].name).toBe("Real");
});

test("decls: skip export in template literal", () => {
  const source =
    "const tmpl = `export class Phantom {}`;\\nexport class Actual {}";
  const decls = scanDecls(source);

  expect(decls.length).toBe(1);
  expect(decls[0].name).toBe("Actual");
});

test("decls: multi-line template literal", () => {
  const source = `const code = \`
export class
Fake {
}\`;
export class Real {}`;
  const decls = scanDecls(source);

  expect(decls.length).toBe(1);
  expect(decls[0].name).toBe("Real");
});

test("decls: line and column positions", () => {
  const source = `// line 1
export function foo() {}`;
  const decls = scanDecls(source);

  expect(decls.length).toBe(1);
  expect(decls[0].line).toBe(2);
  expect(decls[0].column).toBeGreaterThan(0);
});

test("decls: offset positions are correct", () => {
  const source = "export const x = 1;";
  const decls = scanDecls(source);

  expect(decls[0].offset).toBeGreaterThanOrEqual(0);
  // offset should point to the 'x', reconstructed from the offset
  const chars = source.slice(decls[0].offset, decls[0].offset + 1);
  expect(chars).toBe("x");
});

test("decls: export { a as b } from module", () => {
  const source = 'export { helper as util } from "./mod";';
  const decls = scanDecls(source);

  expect(decls.length).toBe(1);
  expect(decls[0].name).toBe("util");
  expect(decls[0].reexportFrom).toBe("./mod");
  expect(decls[0].declKind).toBe("reexport");
});

test("decls: multiple exports on different lines", () => {
  const source = `export function a() {}
export class B {}
export const c = 1;`;
  const decls = scanDecls(source);

  expect(decls.length).toBe(3);
  expect(findDecl(decls, "a")?.line).toBe(1);
  expect(findDecl(decls, "B")?.line).toBe(2);
  expect(findDecl(decls, "c")?.line).toBe(3);
});

test("decls: deterministic order (source order)", () => {
  const source = `export function z() {}
export const a = 1;
export class m {}`;
  const decls = scanDecls(source);

  expect(decls[0].name).toBe("z");
  expect(decls[1].name).toBe("a");
  expect(decls[2].name).toBe("m");
});

test("decls: export default class", () => {
  const source = "export default class DefaultClass {}";
  const decls = scanDecls(source);

  expect(decls.length).toBe(1);
  expect(decls[0].name).toBe("default");
  expect(decls[0].declKind).toBe("default");
});

test("decls: empty destructuring", () => {
  const source = "export const {} = obj;";
  const decls = scanDecls(source);

  expect(decls.length).toBe(0);
});

test("decls: destructuring with trailing comma", () => {
  const source = "export const { a, b, } = obj;";
  const decls = scanDecls(source);

  expect(decls.length).toBe(2);
  expect(findDecl(decls, "a")).toBeDefined();
  expect(findDecl(decls, "b")).toBeDefined();
});

test("decls: export { a } from 'a-module';", () => {
  const source = "export { foo } from 'module-with-dashes';";
  const decls = scanDecls(source);

  expect(decls.length).toBe(1);
  expect(decls[0].name).toBe("foo");
  expect(decls[0].reexportFrom).toBe("module-with-dashes");
});

test("decls: skip block comment with export inside", () => {
  const source = `/*
export function hidden() {}
*/
export function visible() {}`;
  const decls = scanDecls(source);

  expect(decls.length).toBe(1);
  expect(decls[0].name).toBe("visible");
});

test("decls: skip nested strings in export statement", () => {
  const source = 'export const msg = "export const fake = 1";';
  const decls = scanDecls(source);

  expect(decls.length).toBe(1);
  expect(decls[0].name).toBe("msg");
});

test("decls: apostrophe in a field-level line comment doesn't swallow later exports", () => {
  const source = `export interface A {
  id: string; // owner's id
}

export interface B {
  name: string;
}`;
  const decls = scanDecls(source);

  expect(findDecl(decls, "A")?.declKind).toBe("interface");
  expect(findDecl(decls, "B")?.declKind).toBe("interface");
});

test("decls: apostrophe in a field-level block comment doesn't swallow later exports", () => {
  const source = `export interface A {
  /** the example's owner */
  id: string;
}

export interface B {
  name: string;
}`;
  const decls = scanDecls(source);

  expect(findDecl(decls, "A")?.declKind).toBe("interface");
  expect(findDecl(decls, "B")?.declKind).toBe("interface");
});

test("decls: type export with from", () => {
  const source = 'export type { X, Y } from "./types";';
  const decls = scanDecls(source);

  expect(decls.length).toBe(2);
  expect(findDecl(decls, "X")?.declKind).toBe("reexport");
  expect(findDecl(decls, "Y")?.declKind).toBe("reexport");
});

test("integration: scanDecls with various patterns", () => {
  const source = `
export function foo() {}
export class Bar {}
export const x = 1;
export { helper } from "./util";
export * from "./all";
export type Point = { x: number };
export interface Animal { name: string; }
`;

  const decls = scanDecls(source);

  expect(findDecl(decls, "foo")).toBeDefined();
  expect(findDecl(decls, "Bar")).toBeDefined();
  expect(findDecl(decls, "x")).toBeDefined();
  expect(findDecl(decls, "helper")?.reexportFrom).toBe("./util");
  expect(findDecl(decls, "*")?.reexportFrom).toBe("./all");
  expect(findDecl(decls, "Point")).toBeDefined();
  expect(findDecl(decls, "Animal")).toBeDefined();
});
