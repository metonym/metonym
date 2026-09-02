import { dirname } from "node:path";
import { symbolId } from "../ir/ids";
import type {
  Diagnostic,
  DocumentationSet,
  Example,
  Relation,
  SymbolInfo,
} from "../ir/types";

type TypeScript = typeof import("typescript");
type TsNode = import("typescript").Node;
type TsSymbol = import("typescript").Symbol;
type TsCompilerOptions = import("typescript").CompilerOptions;

export async function enrichWithTypeScript(
  docs: DocumentationSet,
  opts?: { tsPath?: string; sourceFiles?: string[] },
): Promise<{ docs: DocumentationSet; diagnostics: string[] }> {
  const diagnostics: string[] = [];

  try {
    return await enrichWithTypeScriptImpl(docs, opts, diagnostics);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    diagnostics.push(`deep analysis failed: ${message}`);
    return { docs, diagnostics };
  }
}

/** Strip `import("/abs/path").` prefixes the checker embeds in type text. */
function cleanTypeText(text: string): string {
  return text.replace(/import\("[^"]*"\)\./g, "");
}

/** Matches the header generate.ts always writes ahead of an example's body. */
const DIAG_PROLOGUE = 'import { describe, test, expect } from "bun:test";\n';

type TsProgram = import("typescript").Program;
type TsSourceFile = import("typescript").SourceFile;

function lineAndColumnAt(
  text: string,
  offset: number,
): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}

/**
 * Syntactic + semantic diagnostics for one example, computed against the
 * prologue-prefixed diag source file. Positions are remapped back to
 * `originalCode`-relative offsets; diagnostics inside the prologue itself
 * (e.g. an unresolvable "bun:test" when bun-types isn't installed) are
 * dropped rather than misattributed to the example.
 */
function collectDiagnostics(
  program: TsProgram,
  sourceFile: TsSourceFile,
  ts: TypeScript,
  originalCode: string,
): Diagnostic[] {
  const raw = [
    ...program.getSyntacticDiagnostics(sourceFile),
    ...program.getSemanticDiagnostics(sourceFile),
  ];

  const diagnostics: Diagnostic[] = [];
  for (const d of raw) {
    if (d.start === undefined || d.length === undefined) continue;
    if (
      d.category !== ts.DiagnosticCategory.Error &&
      d.category !== ts.DiagnosticCategory.Warning
    )
      continue;

    const start = d.start - DIAG_PROLOGUE.length;
    if (start < 0) continue;

    const { line, column } = lineAndColumnAt(originalCode, start);
    diagnostics.push({
      severity:
        d.category === ts.DiagnosticCategory.Error ? "error" : "warning",
      message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
      start,
      length: d.length,
      line,
      column,
      code: d.code,
    });
  }

  return diagnostics.sort((a, b) => a.start - b.start);
}

/**
 * Parsed source files keyed by path, reused while their text is unchanged.
 * Parsing is most of createProgram: on a 40-file repo the program pulls in
 * ~250 lib and node_modules typings (~5 MB) that never change between
 * watch iterations. Together with passing the previous program to
 * createProgram this lets TypeScript reuse structure instead of reparsing.
 * One-shot CLI runs pay nothing extra; the process exits either way.
 */
const parsedSourceFiles = new Map<
  string,
  { text: string; sourceFile: TsSourceFile }
>();
let lastProgram: TsProgram | undefined;

async function enrichWithTypeScriptImpl(
  docs: DocumentationSet,
  opts: { tsPath?: string; sourceFiles?: string[] } | undefined,
  diagnostics: string[],
): Promise<{ docs: DocumentationSet; diagnostics: string[] }> {
  const tsPath = opts?.tsPath ?? Bun.resolveSync("typescript", docs.root);
  const ts = await loadTypeScriptCompiler(tsPath, docs.root);

  const sourceFiles = opts?.sourceFiles ?? [
    ...new Set(docs.symbols.map((s) => s.file)),
  ];

  const tsConfigPath = `${docs.root}/tsconfig.json`;
  let options: TsCompilerOptions;

  if (Bun.file(tsConfigPath).size > 0) {
    try {
      const configFile = ts.readConfigFile(tsConfigPath, ts.sys.readFile);
      if (configFile.error) {
        diagnostics.push(
          `Failed to read tsconfig.json: ${configFile.error.messageText}`,
        );
        options = getDefaultCompilerOptions(ts);
      } else {
        const parsed = ts.parseJsonConfigFileContent(
          configFile.config,
          ts.sys,
          docs.root,
        );
        options = parsed.options;
      }
    } catch (err) {
      diagnostics.push(
        `Failed to parse tsconfig.json: ${err instanceof Error ? err.message : String(err)}`,
      );
      options = getDefaultCompilerOptions(ts);
    }
  } else {
    options = getDefaultCompilerOptions(ts);
  }

  options.noEmit = true;
  options.skipLibCheck = true;

  const virtualMap = new Map<string, string>();
  const virtualPaths: string[] = [];

  for (const example of docs.examples) {
    if (example.kind === "ignored" || example.kind === "pending") {
      continue;
    }

    const sanitizedId = example.id.replace(/[^a-zA-Z0-9]/g, "_");
    const vpath = `${docs.root}/.metonym-virtual/${sanitizedId}.${example.language}`;
    virtualMap.set(vpath, example.code);
    virtualPaths.push(vpath);

    // Diagnostics run against a second virtual file with the same header
    // generate.ts always injects, so "Cannot find name 'expect'" doesn't
    // drown out real errors. Hover positions stay relative to example.code
    // by leaving the first virtual file untouched.
    const diagVpath = `${docs.root}/.metonym-virtual/${sanitizedId}.diag.${example.language}`;
    virtualMap.set(diagVpath, DIAG_PROLOGUE + example.code);
    virtualPaths.push(diagVpath);
  }

  const rootFiles = sourceFiles.map((f) => `${docs.root}/${f}`);

  const baseHost = ts.createCompilerHost(options);
  const host: typeof baseHost = {
    ...baseHost,
    fileExists: (fileName: string) => {
      if (virtualMap.has(fileName)) return true;
      return baseHost.fileExists(fileName);
    },
    readFile: (fileName: string) => {
      if (virtualMap.has(fileName)) {
        return virtualMap.get(fileName) || "";
      }
      return baseHost.readFile(fileName);
    },
    getSourceFile: (fileName, languageVersion, onError, shouldCreateNew) => {
      if (virtualMap.has(fileName)) {
        const content = virtualMap.get(fileName) || "";
        return ts.createSourceFile(fileName, content, languageVersion, true);
      }
      const text = baseHost.readFile(fileName);
      if (text === undefined) {
        return baseHost.getSourceFile(
          fileName,
          languageVersion,
          onError,
          shouldCreateNew,
        );
      }
      const cached = parsedSourceFiles.get(fileName);
      if (cached && cached.text === text) return cached.sourceFile;
      const sourceFile = ts.createSourceFile(fileName, text, languageVersion);
      parsedSourceFiles.set(fileName, { text, sourceFile });
      return sourceFile;
    },
  };

  const program = ts.createProgram(
    [...rootFiles, ...virtualPaths],
    options,
    host,
    lastProgram,
  );
  lastProgram = program;
  const checker = program.getTypeChecker();

  const normalizePath = (p: string) => p.replace(/^\/private/, "");
  const normalizedRoot = normalizePath(docs.root);

  function relOf(fileName: string): string | null {
    const norm = normalizePath(fileName);
    if (!norm.startsWith(normalizedRoot)) return null;
    const rel = norm.slice(normalizedRoot.length + 1);
    if (rel.includes("/node_modules/")) return null;
    if (rel.includes("/.metonym-virtual/")) return null;
    return rel;
  }

  const symbolByFileAndName = new Map<string, SymbolInfo>();
  for (const sym of docs.symbols) {
    const key = `${sym.file}:${sym.name}`;
    symbolByFileAndName.set(key, sym);
  }

  // Names exported (non-alias) by any module outside the project: lib
  // typings and node_modules. Computed once; the per-symbol version of
  // this walked every program file per aliased identifier, which on a
  // 40-file repo meant ~280 getExportsOfModule calls per reference.
  let externalExportNames: Set<string> | null = null;
  function isExternalExportName(name: string): boolean {
    if (!externalExportNames) {
      externalExportNames = new Set();
      for (const sf of program.getSourceFiles()) {
        if (relOf(sf.fileName) !== null) continue;
        try {
          const moduleSymbol = checker.getSymbolAtLocation(sf);
          if (!moduleSymbol) continue;
          for (const exp of checker.getExportsOfModule(moduleSymbol) || []) {
            if (!(exp.flags & ts.SymbolFlags.Alias)) {
              externalExportNames.add(exp.name);
            }
          }
        } catch {}
      }
    }
    return externalExportNames.has(name);
  }

  function symbolIdOf(sym: TsSymbol): string | null {
    try {
      const symbolName = sym.name === "default" ? "default" : sym.name;

      // Shadowed import: `import { add }; const add = 1` must not resolve to add.
      if (
        sym.flags & ts.SymbolFlags.Alias &&
        isExternalExportName(symbolName)
      ) {
        return null;
      }

      let current = sym;
      let attempts = 0;
      while (current.flags & ts.SymbolFlags.Alias && attempts < 100) {
        const aliased = checker.getAliasedSymbol(current);
        if (aliased === current) break;
        current = aliased;
        attempts++;
      }

      const decl = current.declarations?.[0];
      if (!decl) return null;

      const relFile = relOf(decl.getSourceFile().fileName);
      if (!relFile) return null;

      const name = current.name === "default" ? "default" : current.name;
      const key = `${relFile}:${name}`;
      const found = symbolByFileAndName.get(key);
      return found?.id ?? null;
    } catch {
      return null;
    }
  }

  const newRelations: Relation[] = [];
  const seenRelations = new Set<string>();

  for (const rel of docs.relations) {
    const key = `${rel.kind}|${rel.from}|${rel.to}`;
    seenRelations.add(key);
  }

  for (const example of docs.examples) {
    if (example.kind === "ignored" || example.kind === "pending") {
      continue;
    }

    const sanitizedId = example.id.replace(/[^a-zA-Z0-9]/g, "_");
    const vpath = `${docs.root}/.metonym-virtual/${sanitizedId}.${example.language}`;
    const sourceFile = program.getSourceFile(vpath);
    if (!sourceFile) continue;

    visitNodeForReferences(sourceFile, (node) => {
      if (!ts.isIdentifier(node)) return;

      if (isInStringLiteral(node, ts)) return;

      if (isImportName(node, ts)) return;

      if (isDeclarationName(node, ts)) return;

      try {
        const sym = checker.getSymbolAtLocation(node);
        if (!sym) return;

        const symId = symbolIdOf(sym);
        if (!symId) return;

        const key = `references|${example.id}|${symId}`;
        if (!seenRelations.has(key)) {
          seenRelations.add(key);
          newRelations.push({
            kind: "references",
            from: example.id,
            to: symId,
          });
        }
      } catch {}
    });
  }

  for (const sourceFile of program.getSourceFiles()) {
    const relFile = relOf(sourceFile.fileName);
    if (!relFile) continue;

    visitNodeForCalls(sourceFile, (node) => {
      if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) {
        return;
      }

      try {
        let current = node.parent;
        let enclosingFunctionDecl: TsNode | null = null;

        while (current) {
          if (
            ts.isFunctionDeclaration(current) ||
            ts.isArrowFunction(current) ||
            ts.isFunctionExpression(current) ||
            ts.isMethodDeclaration(current)
          ) {
            const parent = current.parent;
            if (ts.isSourceFile(parent) || ts.isClassDeclaration(parent)) {
              enclosingFunctionDecl = current;
              break;
            }
          }

          if (ts.isBlock(current)) {
            current = current.parent;
            continue;
          }

          current = current.parent;
        }

        if (!enclosingFunctionDecl) return;

        let funcNameNode: TsNode | undefined | null = null;
        if (
          ts.isFunctionDeclaration(enclosingFunctionDecl) ||
          ts.isMethodDeclaration(enclosingFunctionDecl)
        ) {
          funcNameNode = enclosingFunctionDecl.name;
        } else if (
          ts.isArrowFunction(enclosingFunctionDecl) ||
          ts.isFunctionExpression(enclosingFunctionDecl)
        ) {
          const varDecl = enclosingFunctionDecl.parent;
          if (ts.isVariableDeclaration(varDecl)) {
            funcNameNode = varDecl.name;
          }
        }

        if (!funcNameNode || !ts.isIdentifier(funcNameNode)) return;

        const funcSym = checker.getSymbolAtLocation(funcNameNode);
        if (!funcSym) return;

        const callerId = symbolIdOf(funcSym);
        if (!callerId) return;

        const calleeExpr = node.expression;
        let calleeSym: TsSymbol | undefined;

        if (ts.isIdentifier(calleeExpr)) {
          calleeSym = checker.getSymbolAtLocation(calleeExpr);
        } else if (ts.isPropertyAccessExpression(calleeExpr)) {
          const nameNode = calleeExpr.name;
          calleeSym = checker.getSymbolAtLocation(nameNode);
        }

        if (!calleeSym) return;

        const calleeId = symbolIdOf(calleeSym);
        if (!calleeId) return;

        if (callerId === calleeId) return;

        const key = `calls|${callerId}|${calleeId}`;
        if (!seenRelations.has(key)) {
          seenRelations.add(key);
          newRelations.push({
            kind: "calls",
            from: callerId,
            to: calleeId,
          });
        }
      } catch {}
    });
  }

  const newSymbols: SymbolInfo[] = [...docs.symbols];
  const symbolIds = new Set(docs.symbols.map((s) => s.id));

  for (const sym of docs.symbols) {
    if (sym.name !== "*" || !sym.reexportFrom) continue;

    try {
      const sourceFile = program.getSourceFile(`${docs.root}/${sym.file}`);
      if (!sourceFile) continue;

      const moduleSym = checker.getSymbolAtLocation(sourceFile);
      if (!moduleSym) continue;

      const fileDir =
        sym.file.substring(0, sym.file.lastIndexOf("/") + 1) || "./";
      const reexportAbsPath = `${normalizedRoot}/${fileDir}`;

      let targetPath: string;
      try {
        const resolved = Bun.resolveSync(sym.reexportFrom, reexportAbsPath);
        targetPath = normalizePath(resolved);
      } catch {
        continue;
      }

      if (!targetPath.startsWith(normalizedRoot)) continue;

      const targetRel = targetPath.slice(normalizedRoot.length + 1);
      if (targetRel.includes("/node_modules/")) continue;

      const targetSourceFile = program.getSourceFile(targetPath);
      if (!targetSourceFile) continue;

      const targetModuleSym = checker.getSymbolAtLocation(targetSourceFile);
      if (!targetModuleSym) continue;

      const exportedSymbols = checker.getExportsOfModule(targetModuleSym);
      for (const exported of exportedSymbols || []) {
        if (exported.name === "default" || exported.name === "__esModule")
          continue;

        const newSymId = symbolId(sym.file, exported.name);
        if (symbolIds.has(newSymId)) continue;

        const existingInFile = docs.symbols.find(
          (s) => s.file === sym.file && s.name === exported.name,
        );
        if (existingInFile) continue;

        newSymbols.push({
          id: newSymId,
          file: sym.file,
          name: exported.name,
          imports: [],
          declKind: "reexport",
          reexportFrom: sym.reexportFrom,
        });
        symbolIds.add(newSymId);
      }
    } catch {}
  }

  for (const sym of newSymbols) {
    if (sym.loc) continue;

    try {
      const sourceFile = program.getSourceFile(`${docs.root}/${sym.file}`);
      if (!sourceFile) continue;

      const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
      if (!moduleSymbol) continue;
      const exports = checker.getExportsOfModule(moduleSymbol) || [];

      const targetSym = exports.find((s: TsSymbol) => s.name === sym.name);
      if (!targetSym) continue;

      const decl = targetSym.declarations?.[0];
      if (!decl) continue;

      const lineChar = ts.getLineAndCharacterOfPosition(
        sourceFile,
        decl.getStart(),
      );

      sym.loc = {
        file: sym.file,
        start: {
          line: lineChar.line + 1,
          column: lineChar.character + 1,
          offset: decl.getStart(),
        },
        end: {
          line: lineChar.line + 1,
          column: lineChar.character + 1,
          offset: decl.getEnd(),
        },
      };
    } catch {}
  }

  for (const sym of newSymbols) {
    if (sym.name === "*" || sym.declKind === "reexport") continue;

    try {
      const sourceFile = program.getSourceFile(`${docs.root}/${sym.file}`);
      if (!sourceFile) continue;

      const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
      if (!moduleSymbol) continue;
      const exports = checker.getExportsOfModule(moduleSymbol) || [];

      const targetSym = exports.find((s: TsSymbol) => s.name === sym.name);
      if (!targetSym) continue;

      const decl = targetSym.declarations?.[0];
      if (!decl) continue;

      if (
        ts.isFunctionDeclaration(decl) ||
        ts.isArrowFunction(decl) ||
        ts.isFunctionExpression(decl) ||
        ts.isMethodDeclaration(decl)
      ) {
        try {
          const sig = checker.getSignatureFromDeclaration(decl);
          if (sig) {
            sym.signature = cleanTypeText(
              checker.signatureToString(
                sig,
                decl,
                ts.TypeFormatFlags.NoTruncation,
              ),
            );
            continue;
          }
        } catch {}
      }

      // `getTypeOfSymbolAtLocation` gives the type *of a value* — for a
      // type-only declaration (no runtime value to have a type) it always
      // resolves to `any`. `getDeclaredTypeOfSymbol` is what the checker
      // actually has for interfaces/type aliases.
      const isTypeOnly =
        ts.isInterfaceDeclaration(decl) || ts.isTypeAliasDeclaration(decl);
      try {
        const type = isTypeOnly
          ? checker.getDeclaredTypeOfSymbol(targetSym)
          : checker.getTypeOfSymbolAtLocation(targetSym, decl);
        sym.signature = cleanTypeText(
          checker.typeToString(
            type,
            decl,
            ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.InTypeAlias,
          ),
        );
      } catch {}
    } catch {}
  }

  const newExamples: Example[] = [];
  for (const example of docs.examples) {
    if (example.kind === "ignored" || example.kind === "pending") {
      newExamples.push(example);
      continue;
    }

    const hovers: typeof example.hovers = [];

    try {
      const sanitizedId = example.id.replace(/[^a-zA-Z0-9]/g, "_");
      const vpath = `${docs.root}/.metonym-virtual/${sanitizedId}.${example.language}`;
      const sourceFile = program.getSourceFile(vpath);
      if (!sourceFile) {
        newExamples.push(example);
        continue;
      }

      const seenHovers = new Map<string, (typeof hovers)[0]>();

      visitNodeForReferences(sourceFile, (node) => {
        if (!ts.isIdentifier(node)) return;

        if (isInStringLiteral(node, ts)) return;
        if (isObjectLiteralPropertyName(node, ts)) return;

        try {
          const sym = checker.getSymbolAtLocation(node);
          if (!sym) return;

          const start = node.getStart(sourceFile);
          const length = node.getWidth(sourceFile);
          const pos = sourceFile.getLineAndCharacterOfPosition(start);
          const line = pos.line + 1;
          const column = pos.character + 1;

          const hoverId = `${start},${length}`;
          if (seenHovers.has(hoverId)) return;

          let info = "";
          let infoDocsStr: string | undefined;
          let hoverId_symbol: string | undefined;

          try {
            let current = sym;
            let attempts = 0;
            while (current.flags & ts.SymbolFlags.Alias && attempts < 100) {
              const aliased = checker.getAliasedSymbol(current);
              if (aliased === current) break;
              current = aliased;
              attempts++;
            }

            const aliasedSym = current;

            const type = checker.getTypeOfSymbolAtLocation(aliasedSym, node);

            let prefix = "";

            if (aliasedSym.flags & ts.SymbolFlags.Function) {
              prefix = "function";
            } else if (
              type.getCallSignatures &&
              type.getCallSignatures().length > 0
            ) {
              prefix = "function";
            } else if (aliasedSym.flags & ts.SymbolFlags.Class) {
              prefix = "class";
            } else if (
              aliasedSym.flags &
              (ts.SymbolFlags.BlockScopedVariable |
                ts.SymbolFlags.FunctionScopedVariable)
            ) {
              prefix = "const";
            } else {
              prefix = "";
            }

            if (
              prefix === "function" &&
              type.getCallSignatures &&
              type.getCallSignatures().length > 0
            ) {
              const callSigs = type.getCallSignatures();
              info = cleanTypeText(
                `function ${aliasedSym.name}${checker.signatureToString(callSigs[0], node, ts.TypeFormatFlags.NoTruncation)}`,
              );
            } else if (prefix === "class") {
              info = `class ${aliasedSym.name}`;
            } else {
              const typeStr = cleanTypeText(
                checker.typeToString(
                  type,
                  node,
                  ts.TypeFormatFlags.NoTruncation,
                ),
              );
              if (prefix === "const") {
                info = `const ${aliasedSym.name}: ${typeStr}`;
              } else {
                info = `${aliasedSym.name}: ${typeStr}`;
              }
            }

            const docComments = aliasedSym.getDocumentationComment(checker);
            if (docComments && docComments.length > 0) {
              infoDocsStr = ts.displayPartsToString(docComments);
            }

            hoverId_symbol = symbolIdOf(aliasedSym) ?? undefined;
          } catch {
            info = sym.name;
          }

          const hover = {
            start,
            length,
            line,
            column,
            info,
            ...(infoDocsStr && { docs: infoDocsStr }),
            ...(hoverId_symbol && { symbol: hoverId_symbol }),
          };

          seenHovers.set(hoverId, hover);
        } catch {}
      });

      const sortedHovers = Array.from(seenHovers.values()).sort(
        (a, b) => a.start - b.start,
      );

      const diagVpath = `${docs.root}/.metonym-virtual/${sanitizedId}.diag.${example.language}`;
      const diagSourceFile = program.getSourceFile(diagVpath);
      const exampleDiagnostics = diagSourceFile
        ? collectDiagnostics(program, diagSourceFile, ts, example.code)
        : [];

      if (sortedHovers.length > 0 || exampleDiagnostics.length > 0) {
        newExamples.push({
          ...example,
          ...(sortedHovers.length > 0 && { hovers: sortedHovers }),
          ...(exampleDiagnostics.length > 0 && {
            diagnostics: exampleDiagnostics,
          }),
        });
      } else {
        newExamples.push(example);
      }
    } catch {
      newExamples.push(example);
    }
  }

  newSymbols.sort(
    (a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name),
  );
  newRelations.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    if (a.from !== b.from) return a.from.localeCompare(b.from);
    return a.to.localeCompare(b.to);
  });

  const enrichedDocs: DocumentationSet = {
    ...docs,
    symbols: newSymbols,
    relations: [...docs.relations, ...newRelations],
    examples: newExamples,
  };

  return { docs: enrichedDocs, diagnostics };
}

const COMPILER_API_PACKAGES = [
  "typescript/lib/typescript.js",
  "@typescript/typescript6",
] as const;

function isCompilerApi(value: unknown): value is TypeScript {
  if (typeof value !== "object" || value === null) return false;
  const ts = value as Record<string, unknown>;
  return typeof ts.createProgram === "function" && ts.ScriptTarget != null;
}

async function importTs(path: string): Promise<unknown> {
  const mod: unknown = await import(path);
  if (typeof mod === "object" && mod !== null && "default" in mod) {
    return mod.default ?? mod;
  }
  return mod;
}

function tryResolve(spec: string, from: string): string | undefined {
  try {
    return Bun.resolveSync(spec, from);
  } catch {
    return undefined;
  }
}

function compilerApiSearchRoots(tsPath: string, docsRoot: string): string[] {
  const roots = [docsRoot, dirname(tsPath)];
  let dir = dirname(tsPath);
  for (let i = 0; i < 6; i++) {
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
    roots.push(dir);
  }
  return [...new Set(roots)];
}

async function loadTypeScriptCompiler(
  tsPath: string,
  docsRoot: string,
): Promise<TypeScript> {
  const loaded = await importTs(tsPath);
  if (isCompilerApi(loaded)) return loaded;

  for (const root of compilerApiSearchRoots(tsPath, docsRoot)) {
    for (const spec of COMPILER_API_PACKAGES) {
      const resolved = tryResolve(spec, root);
      if (!resolved || resolved === tsPath) continue;
      try {
        const candidate = await importTs(resolved);
        if (isCompilerApi(candidate)) return candidate;
      } catch {}
    }
  }

  throw new Error(
    "TypeScript 7 does not include a compiler API (createProgram). Install @typescript/typescript6 for --analysis=deep until TypeScript 7.1.",
  );
}

function getDefaultCompilerOptions(ts: TypeScript): TsCompilerOptions {
  return {
    allowJs: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve,
    strict: false,
    noEmit: true,
    skipLibCheck: true,
  };
}

/** True for the key in `{ root: "." }`, which is a definition, not a use. */
function isObjectLiteralPropertyName(node: TsNode, ts: TypeScript): boolean {
  if (!node.parent) return false;

  const parent = node.parent;

  return ts.isPropertyAssignment(parent) && parent.name === node;
}

function isImportName(node: TsNode, ts: TypeScript): boolean {
  if (!node.parent) return false;

  const parent = node.parent;

  return (
    ts.isImportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent)
  );
}

function isDeclarationName(node: TsNode, ts: TypeScript): boolean {
  if (!node.parent) return false;

  const parent = node.parent;

  return (
    (ts.isVariableDeclaration(parent) && parent.name === node) ||
    (ts.isFunctionDeclaration(parent) && parent.name === node) ||
    (ts.isClassDeclaration(parent) && parent.name === node) ||
    (ts.isMethodDeclaration(parent) && parent.name === node) ||
    (ts.isPropertyDeclaration(parent) && parent.name === node) ||
    (ts.isParameter(parent) && parent.name === node) ||
    ts.isImportSpecifier(parent) ||
    ts.isImportClause(parent)
  );
}

function isInStringLiteral(node: TsNode, ts: TypeScript): boolean {
  const parent = node.parent;
  if (!parent) return false;

  return (
    ts.isStringLiteral(parent) ||
    ts.isNoSubstitutionTemplateLiteral(parent) ||
    ts.isTemplateHead(parent) ||
    ts.isTemplateMiddle(parent) ||
    ts.isTemplateTail(parent)
  );
}

function visitNodeForReferences(
  node: TsNode,
  callback: (node: TsNode) => void,
): void {
  callback(node);
  node.forEachChild((child: TsNode) => visitNodeForReferences(child, callback));
}

function visitNodeForCalls(
  node: TsNode,
  callback: (node: TsNode) => void,
): void {
  callback(node);
  node.forEachChild((child: TsNode) => visitNodeForCalls(child, callback));
}
