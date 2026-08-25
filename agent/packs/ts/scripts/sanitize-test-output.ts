// run_tests output sanitizer (TN-26-001, §"Custom tools").
//
// The builder subagent is blind to test SOURCE but must see failure output to
// debug. So run_tests may surface ONLY: the test name, its status, and a
// sanitized failure message that keeps the assertion diff (expected/received)
// while dropping anything that leaks test source — code frames (numbered
// source lines + the ❯/caret pointer), stack traces, absolute/relative file
// paths, and console-captured output.
//
// Design: whitelist by CONSTRUCTION. Consume vitest's structured JSON reporter
// (`vitest --reporter=json`) and extract only three safe fields per test
// (name, status, message). Stack, location, and file paths are discarded
// simply by never reading them. Console output is absent from the JSON
// reporter entirely, so it cannot survive. `sanitizeMessage` is the second
// line of defense for the one free-text field we DO keep (the failure
// message), in case a vitest version embeds a code frame, stack, path, or
// console block inside it.
//
// Pure core: no pi deps, no fs, no shell. Input is the raw JSON string; the
// caller (the future run_tests custom tool) owns spawning vitest and reading
// its output.

export class SanitizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SanitizeError";
  }
}

/**
 * One test's sanitized outcome — the entire public surface run_tests exposes.
 *
 * - `name`    full, human-authored test name (safe: chosen by the test-writer,
 *             carries no source). Derived from vitest's `fullName`, or from
 *             `ancestorTitles` + `title` when absent.
 * - `status`  vitest status verbatim ("passed" | "failed" | "skipped" |
 *             "todo" | "pending" | …). Not narrowed to a union so an unknown
 *             future status still round-trips.
 * - `message` present ONLY for failures, and only when sanitizing leaves
 *             non-empty content. Contains the assertion text / expected-vs-
 *             received diff with all source-leaking material removed.
 */
export interface SanitizedResult {
  readonly name: string;
  readonly status: string;
  readonly message?: string;
}

// --- message sanitizer --------------------------------------------------------

// A path token: file:// URIs, POSIX absolute/relative paths, or Windows drive
// paths, with an optional trailing :line:col. Redacted to a fixed placeholder
// so a leaked location can never survive even inside otherwise-safe text.
const PATH_TOKEN =
  /(?:file:\/\/)?(?:[A-Za-z]:)?(?:\.\.?\/|\/)[\w.\-/\\]*(?::\d+(?::\d+)?)?/g;

const PATH_PLACEHOLDER = "[path]";

/** Lines dropped wholesale — each leaks source or is pure reporter chrome. */
function isSourceLeakingLine(line: string): boolean {
  const t = line.trimStart();
  return (
    // stack frames: "at fn (…:1:2)", "at …:1:2", "❯ …:1:2"
    /^at\s/.test(t) ||
    /^❯\s/.test(t) ||
    // code-frame numbered source line: "  6| expect(secret)…"
    /^\d+\s*\|/.test(t) ||
    // code-frame gutter / caret pointer line: " |            ^"
    /^\|/.test(t) ||
    // console capture headers: "stdout | file > test", "stderr | …"
    /^(?:stdout|stderr)\s*\|/.test(t) ||
    // reporter decoration: separator rules and "[1/2]" progress markers
    /^[⎯\s]*$/.test(line) ||
    /⎯*\[\d+\/\d+\]⎯*/.test(line)
  );
}

/**
 * Strip source-leaking material from a single failure message while preserving
 * the assertion text and expected/received diff.
 *
 * Removes (line-wise, so partial code frames are still caught):
 *   - stack lines (`at … (path:line:col)` and `❯ path:line:col`)
 *   - code-frame blocks (numbered source lines and the `|`/`^` pointer)
 *   - console capture blocks (`stdout |` / `stderr |` headers)
 *   - reporter decoration (separator rules, `[n/m]` markers)
 * Then redacts any residual file path (absolute, relative, or `file://`) in the
 * surviving lines to `[path]`. Collapses runs of blank lines and trims.
 */
export function sanitizeMessage(message: string): string {
  const kept: string[] = [];
  for (const rawLine of message.split("\n")) {
    if (isSourceLeakingLine(rawLine)) continue;
    kept.push(rawLine.replace(PATH_TOKEN, PATH_PLACEHOLDER));
  }
  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n") // collapse blank-line runs left by dropped blocks
    .replace(/[ \t]+$/gm, "") // trailing whitespace on kept lines
    .trim();
}

// --- run parser ---------------------------------------------------------------

interface AssertionResult {
  fullName?: unknown;
  title?: unknown;
  ancestorTitles?: unknown;
  status?: unknown;
  failureMessages?: unknown;
}

interface TestFileResult {
  assertionResults?: unknown;
  status?: unknown;
  message?: unknown;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nameOf(a: AssertionResult): string {
  const full = asString(a.fullName);
  if (full !== "") return full;
  const ancestors = Array.isArray(a.ancestorTitles)
    ? a.ancestorTitles.filter((t): t is string => typeof t === "string")
    : [];
  return [...ancestors, asString(a.title)].filter((s) => s !== "").join(" ");
}

function failureMessageOf(a: AssertionResult): string | undefined {
  if (!Array.isArray(a.failureMessages)) return undefined;
  const sanitized = a.failureMessages
    .filter((m): m is string => typeof m === "string")
    .map(sanitizeMessage)
    .filter((m) => m !== "");
  return sanitized.length > 0 ? sanitized.join("\n\n") : undefined;
}

/**
 * Sanitize a full `vitest --reporter=json` run.
 *
 * @param rawJson the reporter's JSON output (a string).
 * @returns one {@link SanitizedResult} per test, in reporter order. File paths,
 *          stack traces, code frames, and console output are absent by
 *          construction (never read) and by sanitization (of the one free-text
 *          field kept). Throws {@link SanitizeError} if the input is not the
 *          expected vitest JSON shape.
 */
export function sanitizeTestRun(rawJson: string): SanitizedResult[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new SanitizeError("sanitize: input is not valid JSON (expected `vitest --reporter=json` output)");
  }
  if (typeof parsed !== "object" || parsed === null || !("testResults" in parsed)) {
    throw new SanitizeError("sanitize: JSON is missing `testResults` (not a vitest JSON report)");
  }
  const testResults = (parsed as { testResults: unknown }).testResults;
  if (!Array.isArray(testResults)) {
    throw new SanitizeError("sanitize: `testResults` is not an array");
  }

  const results: SanitizedResult[] = [];
  for (const file of testResults as TestFileResult[]) {
    const assertions = Array.isArray(file.assertionResults) ? (file.assertionResults as AssertionResult[]) : [];

    if (assertions.length === 0) {
      // File failed to collect/run (e.g. import error): no per-test results.
      // Surface it as a BLOCKED signal WITHOUT the file path (name is generic).
      if (asString(file.status) === "failed") {
        const message = sanitizeMessage(asString(file.message));
        results.push(message === "" ? { name: "(test file)", status: "failed" } : { name: "(test file)", status: "failed", message });
      }
      continue;
    }

    for (const a of assertions) {
      const status = asString(a.status, "unknown");
      const message = status === "failed" ? failureMessageOf(a) : undefined;
      results.push(message === undefined ? { name: nameOf(a), status } : { name: nameOf(a), status, message });
    }
  }
  return results;
}
