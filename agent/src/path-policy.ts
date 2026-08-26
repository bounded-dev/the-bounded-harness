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

// --- Role tool allowlists (frontmatter source of truth) ----------------------
// The tool allowlist is the ONLY enforcement layer that PREVENTS rather than
// detects (TN-26-001 §"Blindness and enforcement", layer 1): a capability an
// agent never holds cannot be misused, whatever the prompt says. These arrays
// are the canonical data; each pipeline agent's frontmatter `tools:` must equal
// its role's entry here (asserted by agent-config-drift.test.ts), and the
// orchestrator never grants a worker `subagent` or `bash`. Rationale:
//
//   · No `bash` for any worker — shell access defeats every path rule (a
//     builder could `cat tests/`, an architect could read `src/`). The builder
//     sees test FAILURES, never test SOURCE, through the sanitized `run_tests`
//     tool instead of a shell.
//   · No `subagent` for any worker — only orchestrators orchestrate; a worker
//     that could spawn subagents could launder its blindness through a child.
//   · `run_tests` is builder-only — the blind-safe debugging channel for the
//     one role implementing against a hidden suite. The architect and
//     test-writer never run the suite; the orchestrator runs the red/green
//     gates itself and never trusts a worker's word on pass/fail.
//   · `typecheck` for all three — types are the contract's shared language;
//     every role must be able to confirm its own work compiles.
export const ROLE_TOOLS: Record<Role, readonly string[]> = {
  architect: ["read", "grep", "find", "ls", "write", "edit", "typecheck"],
  "test-writer": ["read", "grep", "find", "ls", "write", "edit", "typecheck"],
  builder: ["read", "grep", "find", "ls", "write", "edit", "run_tests", "typecheck"],
};

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

// WHAT BLINDNESS ACTUALLY IS (corrected after dogfood Run 5)
//
// The blindness is between TESTS and IMPLEMENTATION, and nowhere else:
//
//     artifact          architect   test-writer   builder
//     contract          read        read          read     ← shared
//     spec.md           read        read          read     ← shared
//     implementation    –           –             write
//     tests             –           write         –        ← the real blindness
//
// The contract and the spec are the SHARED interface: all three roles work
// against them, and they are declaration-only by construction (contract-purity
// enforces it), so sharing them leaks nothing. An earlier version of this file
// stated the rule as "src is ALWAYS blind, contracts included", which is a
// muddled reading of the same idea — and it killed a live run, because the
// test-writer imports from contract paths it was then refused permission to
// read. It escalated, was told the wall was intentional, and exited without
// writing a test.
//
// So: deny an agent the OTHER SIDE's work product. Never deny it the interface
// it is working against.
export const ZONES: Record<Role, Zone> = {
  architect: {
    writeAllow: ["spec.md", "src/**/*.contract.ts"],
    writeDeny: [],
    readDeny: ["tests", "tests/**", "src", "src/**"],
    readExcept: ["src/**/*.contract.ts"],
  },
  // The contract is the interface under test, so the test-writer must be able
  // to read it — it imports from those exact paths. Dogfood Run 5 died here:
  // the task prompt told the test-writer to import from the contract, the gate
  // refused the read, and the role escalated and exited without writing a
  // test. Contracts are declaration-only (the contract-purity gate enforces
  // it), so this leaks no implementation; blind to src/** means blind to the
  // IMPLEMENTATION, never to the interface. Searches over src/ remain denied:
  // a directory listing would reveal the implementation's shape.
  "test-writer": {
    writeAllow: ["tests/**"],
    writeDeny: [],
    readDeny: ["src", "src/**"],
    readExcept: ["src/**/*.contract.ts"],
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

// --- Ownership (who may FIX a file) ------------------------------------------

/** Upstream-first: the order the pipeline produces artifacts (contract → tests
 *  → implementation), and so the order in which a defect should be repaired. */
export const ROLES_UPSTREAM_FIRST: readonly Role[] = ["architect", "test-writer", "builder"];

/**
 * The role whose write zone owns `path` — i.e. the only role the path gate
 * would let repair it — or `null` when no pipeline role may write it (config,
 * build files, anything outside the project).
 *
 * Derived from the same ZONES that decide() enforces, so gate routing can
 * never drift from what the path gate actually permits. Input is a
 * PROJECT-RELATIVE path (tsc diagnostics are relativized before they get
 * here); absolute paths are unowned rather than guessed at.
 */
export function ownerOfPath(path: string): Role | null {
  if (path.startsWith("/")) return null;
  const n = normalize(path, "/");
  if (!n.ok || n.path === ".") return null;
  return (
    ROLES_UPSTREAM_FIRST.find((role) => {
      const zone = ZONES[role];
      return !matchesAny(zone.writeDeny, n.path) && matchesAny(zone.writeAllow, n.path);
    }) ?? null
  );
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
