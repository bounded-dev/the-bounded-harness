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

// Backup layer under the frontmatter allowlist. Two tiers, because the roles
// are no longer symmetric: the architect drives a whole ticket and needs
// capabilities the two blind roles must never hold.
//
//   · `bash` — forbidden to EVERY role, architect included. A shell defeats
//     every path rule at once, so the architect gets named tools for what it
//     legitimately needs (the gates, git) rather than a way to run anything.
//     This is the difference between a wall and a suggestion.
//   · `subagent` and `git` — the architect's alone. It commissions the two
//     blind roles, and it does the archaeology (reflog, bisect, blame) that a
//     closed verb list would cage exactly when it is most needed.
//
// git is the sharper exclusion of the two: `git show HEAD:tests/x.test.ts`
// hands the builder the test source in a single call and `git log -p` does it
// by accident, so full git in a blind role's hands defeats blindness more
// completely than bash would.
const FORBIDDEN_ALL_ROLES = ["bash"] as const;
const ARCHITECT_ONLY_TOOLS = ["subagent", "git"] as const;

const FORBIDDEN_TOOLS: Record<Role, ReadonlySet<string>> = {
  architect: new Set(FORBIDDEN_ALL_ROLES),
  "test-writer": new Set([...FORBIDDEN_ALL_ROLES, ...ARCHITECT_ONLY_TOOLS]),
  builder: new Set([...FORBIDDEN_ALL_ROLES, ...ARCHITECT_ONLY_TOOLS]),
};

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
//   · The GATE TOOLS are the architect's alone, and they exist so it never
//     needs a shell. Each is thin wiring over an already-tested pack module,
//     which also removes a documented waste: dogfood Run 4's orchestrator
//     spent its first ~3 minutes `find`-ing the pack and `head`-ing three gate
//     scripts to work out how to invoke them. A tool schema cannot be
//     mis-invoked that way, and every call lands in the guard log — so "did
//     the architect actually run the gate" becomes checkable, not trusted.
//   · No `sleep` is reachable by anyone. Run 4's orchestrator ran `sleep 90`
//     and then `sleep 60`; with no shell that failure mode stops existing
//     rather than being a paragraph asking it not to.
export const GATE_TOOLS: readonly string[] = [
  "contract_purity",
  "scaffold",
  "freeze_contracts",
  "check_drift",
  "red_gate",
  "green_gate",
];

export const ROLE_TOOLS: Record<Role, readonly string[]> = {
  architect: [
    "read",
    "grep",
    "find",
    "ls",
    "write",
    "edit",
    "typecheck",
    "subagent",
    "git",
    ...GATE_TOOLS,
  ],
  "test-writer": ["read", "grep", "find", "ls", "write", "edit", "typecheck"],
  builder: ["read", "grep", "find", "ls", "write", "edit", "run_tests", "typecheck"],
};

// Denied for every role, both directions.
const ALWAYS_DENY = [".git", ".git/**"] as const;

// Denied for every role on WRITE only. `.pi/` holds the guard log and the
// contract-checksum manifest — the audit trail and the drift evidence. Every
// role must be able to READ them (diagnosing a jam, citing the log when
// escalating) and none may WRITE them, or the record of what happened becomes
// something the accused can edit. The gates write these files through plain
// `fs`, which never passes through the tool hook, so they are unaffected.
const ALWAYS_WRITE_DENY = [".pi", ".pi/**"] as const;

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
  // The architect owns one ticket end to end: it designs, commissions the two
  // blind roles, and arbitrates between them. So it READS EVERYTHING and WRITES
  // ALMOST NOTHING.
  //
  // This is not a hole in the blindness — it is where the blindness is aimed.
  // The failure the separation exists to prevent is one agent making a test
  // agree with an implementation, and a role that can write NEITHER cannot
  // commit it. Meanwhile the architect must read both: arbitrating "this test
  // contradicts the spec" is impossible without reading the test, and
  // answering "why is this failing?" is the human's whole reason for talking
  // to it. An empty readDeny also leaves no pipeline blind zone for a search
  // to overlap, so this role stops tripping most of issue #8's friction —
  // `ls src` and `ls tests` now work. Root `ls .` still blocks, but on the
  // `.git` overlap alone, which wants result filtering rather than a wider
  // zone.
  architect: {
    writeAllow: ["spec.md", "src/**/*.contract.ts"],
    writeDeny: [],
    readDeny: [],
    readExcept: [],
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
    // nocase: macOS and Windows filesystems are case-insensitive, so
    // case-sensitive matching is not merely unhelpful — it is wrong in both
    // directions. It refused the architect's `SPEC.md` when `spec.md` is
    // literally the same file (dogfood Run 6), and, far worse, it would let
    // `TESTS/orders.test.ts` slip past a `tests/**` denial and hand a blind
    // role the other side's work. Zone patterns are a closed harness-owned
    // vocabulary, so widening the match costs nothing and closes that hole.
    m = picomatch(pattern, { dot: true, nocase: true });
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
  if (FORBIDDEN_TOOLS[role].has(tool)) {
    return block(
      `path-gate: ${role} may not use '${tool}': forbidden for ${role} (frontmatter allowlist is the primary layer)`,
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
    const alwaysDenied = ALWAYS_WRITE_DENY.find((g) => matchGlob(g, t));
    if (alwaysDenied !== undefined) {
      return block(
        `path-gate: ${role} may not write '${t}': '.pi' is the guard log and checksum manifest — read-only for every role`,
      );
    }
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
