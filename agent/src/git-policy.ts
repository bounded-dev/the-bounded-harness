// The architect uses Git to inspect project history. Mutating Git commands
// bypass file-tool path gates: checkout-index can rewrite a protected file even
// after Edit and rm were refused. Keep this tool read-only on every host.

const READS: Readonly<Record<string, ReadonlySet<string>>> = {
  status: new Set(["--short", "-s", "--branch", "-b", "--porcelain", "--porcelain=v1", "--porcelain=v2"]),
  diff: new Set(["--cached", "--staged", "--stat", "--name-only", "--name-status", "--check", "--no-ext-diff", "--no-textconv"]),
  log: new Set(["--oneline", "--all", "--decorate", "--no-decorate", "--stat", "--name-only", "--name-status"]),
  show: new Set(["--stat", "--oneline", "--name-only", "--name-status", "--no-ext-diff", "--no-textconv"]),
  grep: new Set(["-n", "-i", "--ignore-case", "--line-number", "--fixed-strings", "-F"]),
  "ls-files": new Set(["-s", "--stage", "--cached", "--others", "--exclude-standard"]),
  "rev-parse": new Set(["--show-toplevel", "--abbrev-ref", "--verify", "--is-inside-work-tree"]),
  branch: new Set(["--show-current", "--list", "-l"]),
  blame: new Set(["-L"]),
  reflog: new Set(["--all", "--oneline"]),
};

const GLOBALS = new Set(["--no-pager", "-P", "--no-optional-locks", "--literal-pathspecs"]);

/** Undefined accepts a read-only Git invocation; a sentence refuses it. */
export function gitPolicy(args: readonly string[]): string | undefined {
  let i = 0;
  while (GLOBALS.has(args[i] ?? "")) i++;
  const sub = args[i];
  if (sub === undefined || !Object.hasOwn(READS, sub)) {
    return `git '${sub ?? ""}' is not a read-only architect command`;
  }
  const options = READS[sub]!;
  let afterSeparator = false;
  for (const arg of args.slice(i + 1)) {
    if (arg === "--") { afterSeparator = true; continue; }
    if (afterSeparator) continue;
    if (arg.startsWith("-")) {
      if (options.has(arg) || (sub === "log" && /^-\d+$/.test(arg))) continue;
      return `git ${sub} option '${arg}' is not in its read-only allowlist`;
    }
  }
  return undefined;
}
