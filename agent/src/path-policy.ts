// Path policy for the developer-stage pipeline (TN-26-001).
//
// Pure core: no pi imports, no fs. The tool_call path-gate extension
// (Phase 2) is thin wiring over decide(). Every block returns a stable,
// one-line, greppable reason — a deterministic system that is opaque when
// it jams is just a deterministic jam.

import picomatch from "picomatch";

export type Role = "architect" | "test-writer" | "builder";

export type Decision =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: string };

export interface Ctx {
  /** Absolute path of the project root tool paths resolve against. */
  readonly cwd: string;
}

const ALLOW: Decision = { allow: true };
const block = (reason: string): Decision => ({ allow: false, reason });

// --- Tool classes -----------------------------------------------------------

const SEARCH_TOOLS = new Set(["grep", "find", "ls"]);
const READ_TOOLS = new Set(["read", ...SEARCH_TOOLS]);
const WRITE_TOOLS = new Set(["write", "edit"]);
const GATED_TOOLS = new Set([...READ_TOOLS, ...WRITE_TOOLS]);

// Backup layer under the frontmatter allowlist (TN-26-001: only orchestrators
// hold subagent; shell access defeats all path rules).
const FORBIDDEN_TOOLS = new Set(["bash", "subagent"]);

// Denied for every role, both directions.
const ALWAYS_DENY = [".git", ".git/**"] as const;

// --- Zones (v1: hardcoded globs, per TN-26-001) ------------------------------

export interface Zone {
  /** Write is an allowlist: only the role's own artifact kind. */
  readonly writeAllow: readonly string[];
  readonly writeDeny: readonly string[];
  /** Read is a denylist: everything except the role's blind zones. */
  readonly readDeny: readonly string[];
  /** Exceptions within readDeny (e.g. architect may read contracts). */
  readonly readExcept: readonly string[];
}

export const ZONES: Record<Role, Zone> = {
  architect: {
    writeAllow: ["spec.md", "src/**/*.contract.ts"],
    writeDeny: [],
    readDeny: ["tests", "tests/**", "src", "src/**"],
    readExcept: ["src/**/*.contract.ts"],
  },
  "test-writer": {
    writeAllow: ["tests/**"],
    writeDeny: [],
    readDeny: ["src", "src/**"],
    readExcept: [],
  },
  builder: {
    writeAllow: ["src/**"],
    writeDeny: ["src/**/*.contract.ts"],
    readDeny: ["tests", "tests/**"],
    readExcept: [],
  },
};

// --- Glob matching -----------------------------------------------------------
// picomatch (same engine as vitest): conventional globstar semantics, one
// pinned option. dot: true so wildcards match dotfile segments — otherwise
// e.g. builder writes to 'src/.env.example' would fall outside src/**.
// Zone patterns are a closed harness-owned vocabulary (literal segments,
// '*', '**'); paths are the untrusted input and are normalized lexically
// before matching. If zone globs ever become per-repo configurable, treat
// the pattern side as untrusted too and audit picomatch's full language
// (braces, extglobs) before enabling.

const matcherCache = new Map<string, (path: string) => boolean>();

function matchGlob(pattern: string, path: string): boolean {
  let m = matcherCache.get(pattern);
  if (!m) {
    m = picomatch(pattern, { dot: true });
    matcherCache.set(pattern, m);
  }
  return m(path);
}

function matchesAny(patterns: readonly string[], path: string): boolean {
  return patterns.some((p) => matchGlob(p, path));
}

/** Literal prefix of a glob before its first wildcard segment. */
function globBase(pattern: string): string {
  const segs = pattern.split("/");
  const i = segs.findIndex((s) => s.includes("*"));
  return (i === -1 ? segs : segs.slice(0, i)).join("/");
}

/** Do the directory trees rooted at a and b overlap (either direction)? */
function overlaps(a: string, b: string): boolean {
  if (a === "." || b === ".") return true; // project root contains everything
  return a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
}

// --- Normalization (lexical only — no fs, no symlink resolution) --------------

type Normalized = { ok: true; path: string } | { ok: false; reason: string };

function normalize(raw: string, cwd: string): Normalized {
  if (raw.includes("\0")) return { ok: false, reason: "invalid path (NUL byte)" };
  let p = raw;
  if (p.startsWith("/")) {
    const root = cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
    if (p !== root && !p.startsWith(root + "/")) {
      return { ok: false, reason: `absolute path outside project root (${cwd})` };
    }
    p = p.slice(root.length);
  }
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return { ok: false, reason: "path escapes project root" };
      out.pop();
    } else {
      out.push(seg);
    }
  }
  return { ok: true, path: out.length === 0 ? "." : out.join("/") };
}

// --- decide() -----------------------------------------------------------------

function verb(tool: string): string {
  if (WRITE_TOOLS.has(tool)) return "write";
  if (SEARCH_TOOLS.has(tool)) return "search";
  return "read";
}

export function decide(
  role: Role,
  tool: string,
  input: Readonly<Record<string, unknown>>,
  ctx: Ctx,
): Decision {
  if (FORBIDDEN_TOOLS.has(tool)) {
    return block(
      `path-gate: ${role} may not use '${tool}': forbidden for pipeline roles (frontmatter allowlist is the primary layer)`,
    );
  }
  if (!GATED_TOOLS.has(tool)) return ALLOW;

  const raw = input["path"];
  if (raw === undefined || raw === null || raw === "") {
    if (SEARCH_TOOLS.has(tool)) {
      return block(
        `path-gate: ${role} may not use unscoped '${tool}': pass an explicit path inside your zones`,
      );
    }
    return block(`path-gate: ${role} may not ${verb(tool)}: missing path`);
  }
  if (typeof raw !== "string") {
    return block(`path-gate: ${role} may not ${verb(tool)}: invalid path (not a string)`);
  }

  const n = normalize(raw, ctx.cwd);
  if (!n.ok) {
    return block(`path-gate: ${role} may not ${verb(tool)} '${raw}': ${n.reason}`);
  }
  const t = n.path;
  const v = verb(tool);
  const zone = ZONES[role];

  // Zone checks run before the .git catch-all: an overlap with the role's
  // blind zone is the more actionable reason for the agent.
  const gitBlocked = (): Decision | null => {
    const gitHit = SEARCH_TOOLS.has(tool)
      ? ALWAYS_DENY.some((g) => overlaps(t, globBase(g)))
      : matchesAny(ALWAYS_DENY, t);
    return gitHit
      ? block(`path-gate: ${role} may not ${v} '${t}': '.git' is denied for all roles`)
      : null;
  };

  if (WRITE_TOOLS.has(tool)) {
    const denied = zone.writeDeny.find((g) => matchGlob(g, t));
    if (denied) {
      return block(
        `path-gate: ${role} may not write '${t}': denied for ${role} (matches '${denied}')`,
      );
    }
    if (!matchesAny(zone.writeAllow, t)) {
      return block(
        `path-gate: ${role} may not write '${t}': outside ${role} write zones (${zone.writeAllow.join(", ")})`,
      );
    }
    return gitBlocked() ?? ALLOW;
  }

  if (SEARCH_TOOLS.has(tool)) {
    // Searching a directory that contains (or is inside) a blind zone leaks
    // it — block on overlap either way, unless the target itself is an
    // explicit exception (e.g. architect grepping a contract file).
    const hit = zone.readDeny.find((g) => overlaps(t, globBase(g)));
    if (hit && !matchesAny(zone.readExcept, t)) {
      return block(`path-gate: ${role} may not search '${t}': overlaps denied zone '${hit}'`);
    }
    return gitBlocked() ?? ALLOW;
  }

  // read (single path)
  const hit = zone.readDeny.find((g) => matchGlob(g, t));
  if (hit && !matchesAny(zone.readExcept, t)) {
    return block(`path-gate: ${role} may not read '${t}': denied zone '${hit}'`);
  }
  return gitBlocked() ?? ALLOW;
}
