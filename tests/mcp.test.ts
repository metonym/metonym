/**
 * `metonym mcp`: spawn the server over stdio, drive it through the
 * handshake and a couple of tool calls, and check the JSON-RPC framing.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");
const CLI = join(REPO, "src/cli/main.ts");

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

function spawnMcp(cwd: string, extraArgs: string[] = []) {
  const proc = Bun.spawn([process.execPath, CLI, "mcp", ...extraArgs], {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  async function readMessage(): Promise<JsonRpcResponse> {
    while (true) {
      const nl = buffer.indexOf("\n");
      if (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim()) return JSON.parse(line);
        continue;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("mcp server closed stdout before responding");
      buffer += decoder.decode(value, { stream: true });
    }
  }

  async function send(msg: unknown): Promise<void> {
    proc.stdin.write(`${JSON.stringify(msg)}\n`);
    await proc.stdin.flush();
  }

  function close(): void {
    proc.stdin.end();
    proc.kill();
  }

  return { proc, send, readMessage, close };
}

describe("metonym mcp", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "metonym-mcp-"));
    await Bun.write(
      join(root, "package.json"),
      JSON.stringify({ name: "demo-pkg", exports: { ".": "./src/index.ts" } }),
    );
    await Bun.write(
      join(root, "src/index.ts"),
      [
        "/**",
        " * Adds two numbers.",
        " *",
        " * @example",
        " * ```ts",
        ' * import { add } from "demo-pkg"',
        " * expect(add(2, 3)).toBe(5)",
        " * ```",
        " */",
        "export function add(a: number, b: number): number {",
        "  return a + b;",
        "}",
        "",
      ].join("\n"),
    );
    await Bun.write(
      join(root, "README.md"),
      [
        "# demo-pkg",
        "",
        "## Quick start",
        "",
        "```ts",
        'import { add } from "demo-pkg"',
        "expect(add(2, 3)).toBe(5)",
        "```",
        "",
      ].join("\n"),
    );
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("initialize → tools/list → tools/call metonym_list, metonym_check rejected without --allow-run", async () => {
    const mcp = spawnMcp(root);
    try {
      await mcp.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      });
      const init = await mcp.readMessage();
      expect(init.id).toBe(1);
      const initResult = init.result as {
        protocolVersion: string;
        serverInfo: { name: string; version: string };
        capabilities: { tools: object };
      };
      expect(initResult.protocolVersion).toBe("2025-06-18");
      expect(initResult.serverInfo.name).toBe("metonym");
      expect(initResult.capabilities.tools).toBeDefined();

      // Notifications get no response; the next reply must answer id 3.
      await mcp.send({ jsonrpc: "2.0", method: "notifications/initialized" });

      await mcp.send({ jsonrpc: "2.0", id: 3, method: "tools/list" });
      const list = await mcp.readMessage();
      expect(list.id).toBe(3);
      const tools = (list.result as { tools: { name: string }[] }).tools;
      const names = tools.map((t) => t.name);
      expect(names).toEqual([
        "metonym_list",
        "metonym_extract",
        "metonym_impact",
        "metonym_coverage",
      ]);

      await mcp.send({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "metonym_list", arguments: {} },
      });
      const listCall = await mcp.readMessage();
      expect(listCall.id).toBe(4);
      const listContent = (
        listCall.result as { content: { type: string; text: string }[] }
      ).content;
      const listPayload = JSON.parse(listContent[0].text);
      expect(listPayload.schema).toBe("list@1");
      expect(listPayload.examples.length).toBe(2);

      await mcp.send({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "metonym_check", arguments: {} },
      });
      const checkCall = await mcp.readMessage();
      expect(checkCall.id).toBe(5);
      const checkResult = checkCall.result as {
        isError?: boolean;
        content: { text: string }[];
      };
      expect(checkResult.isError).toBe(true);
      expect(checkResult.content[0].text).toContain("--allow-run");
    } finally {
      mcp.close();
    }
  });

  test("--allow-run registers and runs metonym_check", async () => {
    const mcp = spawnMcp(root, ["--allow-run"]);
    try {
      await mcp.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      });
      await mcp.readMessage();

      await mcp.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      const list = await mcp.readMessage();
      const names = (list.result as { tools: { name: string }[] }).tools.map(
        (t) => t.name,
      );
      expect(names).toContain("metonym_check");

      await mcp.send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "metonym_check", arguments: {} },
      });
      const checkCall = await mcp.readMessage();
      expect(checkCall.id).toBe(3);
      const result = checkCall.result as {
        isError?: boolean;
        content: { text: string }[];
      };
      expect(result.isError).toBeUndefined();
      const payload = JSON.parse(result.content[0].text);
      expect(payload.schema).toBe("run@1");
      expect(payload.totals.total).toBe(2);
      expect(payload.totals.passed).toBe(2);
    } finally {
      mcp.close();
    }
  });
});
