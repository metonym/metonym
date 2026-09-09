import { TOOL_NAME, TOOL_VERSION } from "../ir/types";

/**
 * Stamps a JSON output with `tool` identity and a versioned `schema` kind
 * (`"<kind>@1"`). Additive field changes never bump the suffix; renames or
 * removals do.
 */
export function stampJson<T extends object>(
  kind: string,
  payload: T,
): { tool: { name: typeof TOOL_NAME; version: string }; schema: string } & T {
  return {
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    schema: `${kind}@1`,
    ...payload,
  };
}
