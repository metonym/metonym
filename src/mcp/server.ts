/**
 * `metonym mcp`: a hand-written MCP server over stdio (newline-delimited
 * JSON-RPC 2.0 — the stdio transport has no Content-Length framing). Wraps
 * the same verbs as `src/cli/commands.ts` behind MCP tools, so an agent
 * gets the JSON contract documented in `docs/json.md` without shelling out.
 *
 * The initialize/notifications-initialized handshake below targets the
 * broadly-deployed handshake-based MCP revisions (e.g. 2025-06-18): the
 * spec's newest draft (2026-07-28) replaces it with per-request version
 * metadata and drops `initialize` entirely, but no MCP client in common use
 * speaks that yet.
 */

import { createInterface } from "node:readline";
import {
  type CommandOptions,
  checkCommand,
  coverageCommand,
  extractCommand,
  impactCommand,
  selectCommand,
} from "../cli/commands";
import { stampJson } from "../cli/json";
import { UsageError } from "../cli/usage-error";
import { TOOL_NAME, TOOL_VERSION } from "../ir/types";

const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: unknown;
  params?: unknown;
}

interface ToolContent {
  type: "text";
  text: string;
}

interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function writeMessage(msg: unknown): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function strArg(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = args[key];
  return typeof v === "string" ? v : undefined;
}

function arrArg(
  args: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const v = args[key];
  return Array.isArray(v) ? v.map(String) : undefined;
}

function numArg(
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const v = args[key];
  return typeof v === "number" ? v : undefined;
}

function boolArg(
  args: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const v = args[key];
  return typeof v === "boolean" ? v : undefined;
}

function changedArg(args: Record<string, unknown>): CommandOptions["changed"] {
  const v = args.changed;
  if (v === true) return true;
  return typeof v === "string" ? v : undefined;
}

function okText(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function okJson(payload: unknown): ToolResult {
  return okText(JSON.stringify(payload));
}

function errText(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

const TOOL_NAMES = [
  "metonym_list",
  "metonym_extract",
  "metonym_impact",
  "metonym_coverage",
  "metonym_check",
] as const;

const CHANGED_SCHEMA = {
  description:
    "Select only examples affected by git changes; a string is the diff base ref, `true` means the default base.",
  oneOf: [{ type: "boolean" }, { type: "string" }],
};
const ROOT_SCHEMA = {
  type: "string",
  description: "Project root (default cwd)",
};

function listTools(allowRun: boolean): McpTool[] {
  const tools: McpTool[] = [
    {
      name: "metonym_list",
      description: "List selected documentation examples without running them.",
      inputSchema: {
        type: "object",
        properties: {
          root: ROOT_SCHEMA,
          filter: {
            type: "string",
            description: "Only examples whose title contains this substring",
          },
          only: {
            type: "array",
            items: { type: "string" },
            description: "Example ids or `file:line` entries to select",
          },
          changed: CHANGED_SCHEMA,
        },
        additionalProperties: false,
      },
    },
    {
      name: "metonym_extract",
      description: "Emit the Documentation IR.",
      inputSchema: {
        type: "object",
        properties: {
          root: ROOT_SCHEMA,
          format: { type: "string", enum: ["json", "jsonl"] },
        },
        required: ["format"],
        additionalProperties: false,
      },
    },
    {
      name: "metonym_impact",
      description:
        "Trace which documentation examples a set of changed files affects.",
      inputSchema: {
        type: "object",
        properties: {
          root: ROOT_SCHEMA,
          files: {
            type: "array",
            items: { type: "string" },
            description: "Changed files; defaults to git's changed files",
          },
          since: { type: "string", description: "Git diff base ref" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "metonym_coverage",
      description:
        "Report documentation coverage: which exports are documented and exercised by examples.",
      inputSchema: {
        type: "object",
        properties: {
          root: ROOT_SCHEMA,
          check: {
            type: "boolean",
            description: "Enforce the project's configured coverage gates",
          },
        },
        additionalProperties: false,
      },
    },
  ];
  if (allowRun) {
    tools.push({
      name: "metonym_check",
      description:
        "Run documentation examples and report pass/fail. Executes documentation code — only available because the server was started with --allow-run.",
      inputSchema: {
        type: "object",
        properties: {
          root: ROOT_SCHEMA,
          only: { type: "array", items: { type: "string" } },
          filter: { type: "string" },
          changed: CHANGED_SCHEMA,
          timeoutMs: { type: "number" },
        },
        additionalProperties: false,
      },
    });
  }
  return tools;
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  opts: { allowRun: boolean },
): Promise<ToolResult> {
  try {
    switch (name) {
      case "metonym_list": {
        const { examples } = await selectCommand({
          root: strArg(args, "root"),
          filter: strArg(args, "filter"),
          only: arrArg(args, "only"),
          changed: changedArg(args),
        });
        return okJson(stampJson("list", { examples }));
      }
      case "metonym_extract": {
        const format = strArg(args, "format");
        if (format !== "json" && format !== "jsonl") {
          throw new UsageError(
            `invalid format: ${String(format)} (allowed: json, jsonl)`,
          );
        }
        const { docs } = await extractCommand({ root: strArg(args, "root") });
        if (format === "jsonl") {
          return okText(docs.examples.map((e) => JSON.stringify(e)).join("\n"));
        }
        return okText(JSON.stringify({ ...docs, root: "." }));
      }
      case "metonym_impact": {
        const out = await impactCommand({
          root: strArg(args, "root"),
          since: strArg(args, "since"),
          changedPaths: arrArg(args, "files"),
        });
        if (!out.impact) {
          return okJson(
            stampJson("impact", {
              changedFiles: out.changedFiles,
              note: "no changes detected",
            }),
          );
        }
        return okJson(stampJson("impact", out.impact));
      }
      case "metonym_coverage": {
        const { report, gates } = await coverageCommand({
          root: strArg(args, "root"),
          check: boolArg(args, "check"),
        });
        return okJson(
          stampJson("coverage", gates ? { ...report, gates } : report),
        );
      }
      case "metonym_check": {
        if (!opts.allowRun) {
          return errText(
            "metonym_check requires the server to be started with --allow-run",
          );
        }
        const { result } = await checkCommand({
          root: strArg(args, "root"),
          only: arrArg(args, "only"),
          filter: strArg(args, "filter"),
          changed: changedArg(args),
          timeoutMs: numArg(args, "timeoutMs"),
        });
        return okJson(stampJson("run", result));
      }
      default:
        return errText(`unknown tool: ${name}`);
    }
  } catch (err) {
    return errText(err instanceof Error ? err.message : String(err));
  }
}

async function handleLine(
  line: string,
  opts: { allowRun: boolean },
): Promise<void> {
  let msg: JsonRpcMessage;
  try {
    msg = JSON.parse(line);
  } catch {
    writeMessage({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
    return;
  }
  if (
    typeof msg !== "object" ||
    msg === null ||
    typeof msg.method !== "string"
  ) {
    if (msg && typeof msg === "object" && "id" in msg) {
      writeMessage({
        jsonrpc: "2.0",
        id: msg.id ?? null,
        error: { code: -32600, message: "Invalid Request" },
      });
    }
    return;
  }

  const isNotification = !("id" in msg) || msg.id === undefined;
  const respond = (result: unknown) => {
    if (!isNotification) writeMessage({ jsonrpc: "2.0", id: msg.id, result });
  };
  const respondError = (code: number, message: string) => {
    if (!isNotification) {
      writeMessage({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
    }
  };

  try {
    switch (msg.method) {
      case "initialize": {
        const params = (msg.params ?? {}) as { protocolVersion?: string };
        respond({
          protocolVersion: params.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: TOOL_NAME, version: TOOL_VERSION },
        });
        break;
      }
      case "notifications/initialized":
        break;
      case "ping":
        respond({});
        break;
      case "tools/list":
        respond({ tools: listTools(opts.allowRun) });
        break;
      case "tools/call": {
        const params = (msg.params ?? {}) as {
          name?: string;
          arguments?: Record<string, unknown>;
        };
        if (
          !params.name ||
          !(TOOL_NAMES as readonly string[]).includes(params.name)
        ) {
          respondError(-32602, `Unknown tool: ${params.name}`);
          break;
        }
        const result = await callTool(
          params.name,
          params.arguments ?? {},
          opts,
        );
        respond(result);
        break;
      }
      default:
        respondError(-32601, `Method not found: ${msg.method}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    respondError(-32603, message);
  }
}

export async function runMcpServer(opts: { allowRun: boolean }): Promise<void> {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    await handleLine(line, opts);
  }
}
