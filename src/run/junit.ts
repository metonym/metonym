/**
 * JUnit XML parser for bun test output.
 * Handles entity decoding, stack frame parsing, and expected/received extraction.
 */

export interface JUnitCase {
  name: string;
  classname: string;
  file?: string;
  line?: number;
  timeSec: number;
  status: "passed" | "failed" | "todo" | "skipped";
  failure?: {
    type: string;
    message: string;
    body: string;
  };
}

/**
 * Decode HTML entities in bun's JUnit output.
 * Handles: &#10; &#13; &#9; &quot; &apos; &#039; &amp; &lt; &gt;
 * Note: decode &amp; LAST to avoid double-decoding.
 */
export function decodeEntities(s: string): string {
  return (
    s
      .replace(/&#10;/g, "\n")
      .replace(/&#13;/g, "\r")
      .replace(/&#9;/g, "\t")
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      // Decode &amp; LAST
      .replace(/&amp;/g, "&")
  );
}

/**
 * Parse stack frames from failure body or stderr.
 * Looks for frames like: "at fnName (path:line:col)" or "at path:line:col"
 */
export function parseStackFrames(
  text: string,
): { fn?: string; file: string; line: number; column: number }[] {
  const frames: { fn?: string; file: string; line: number; column: number }[] =
    [];

  // Match "at ... (path:line:col)" and "at path:line:col"
  const frameRegex = /at\s+(?:(.+?)\s+)?\(?([^:)]+):(\d+):(\d+)\)?/g;

  let match = frameRegex.exec(text);
  while (match !== null) {
    const fnName = match[1];
    const file = match[2];
    const line = parseInt(match[3], 10);
    const column = parseInt(match[4], 10);

    frames.push({
      fn: fnName?.trim(),
      file,
      line,
      column,
    });
    match = frameRegex.exec(text);
  }

  return frames;
}

/**
 * Parse Expected/Received from decoded failure message.
 * Looks for patterns like:
 *   Expected: <value>
 *   Received: <value>
 */
export function parseExpectedReceived(msg: string): {
  expected?: string;
  received?: string;
} {
  const expectedMatch = /^Expected:\s*(.*)$/m.exec(msg);
  const receivedMatch = /^Received:\s*(.*)$/m.exec(msg);

  return {
    expected: expectedMatch ? expectedMatch[1].trim() : undefined,
    received: receivedMatch ? receivedMatch[1].trim() : undefined,
  };
}

/**
 * Parse JUnit XML from bun test output.
 * Handles both self-closing and element testcases.
 */
export function parseJUnit(xml: string): JUnitCase[] {
  const cases: JUnitCase[] = [];

  // Match: <testcase ATTRS /> or <testcase ATTRS>BODY</testcase>
  const testcaseRegex = /<testcase\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;

  let match = testcaseRegex.exec(xml);
  while (match !== null) {
    const attrsString = match[1];
    const bodyContent = match[2] || "";

    const trimmedAttrs = attrsString.trim();

    const nameMatch = /name="([^"]*)"/i.exec(trimmedAttrs);
    const classnameMatch = /classname="([^"]*)"/i.exec(trimmedAttrs);
    const fileMatch = /file="([^"]*)"/i.exec(trimmedAttrs);
    const lineMatch = /line="([^"]*)"/i.exec(trimmedAttrs);
    const timeMatch = /time="([^"]*)"/i.exec(trimmedAttrs);

    const name = nameMatch ? nameMatch[1] : "";
    const classname = classnameMatch ? classnameMatch[1] : "";
    const file = fileMatch ? fileMatch[1] : undefined;
    const line = lineMatch ? parseInt(lineMatch[1], 10) : undefined;
    const timeSec = timeMatch ? parseFloat(timeMatch[1]) : 0;

    let status: "passed" | "failed" | "todo" | "skipped" = "passed";
    let failure: JUnitCase["failure"] | undefined;

    const failureMatch =
      /<failure\s+type="([^"]*)"\s+message="([^"]*)"\s*>([\s\S]*?)<\/failure>/.exec(
        bodyContent,
      );
    if (failureMatch) {
      status = "failed";
      failure = {
        type: failureMatch[1],
        message: decodeEntities(failureMatch[2]),
        body: decodeEntities(failureMatch[3]),
      };
    }

    const skippedMatch = /<skipped\s+(?:message="([^"]*)")?\s*\/\s*>/.exec(
      bodyContent,
    );
    if (skippedMatch) {
      const skippedMsg = skippedMatch[1];
      status = skippedMsg === "TODO" ? "todo" : "skipped";
    }

    cases.push({
      name,
      classname,
      file,
      line,
      timeSec,
      status,
      failure,
    });
    match = testcaseRegex.exec(xml);
  }

  return cases;
}
