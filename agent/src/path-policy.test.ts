import { describe, expect, test } from "vitest";
import { decide, ownerOfPath, type Decision, type Role } from "./path-policy.js";

// TN-26-001 blindness matrix, executable form.
// Paths are resolved against a fixed project root (/repo) so tests are hermetic.

const CTX = { cwd: "/repo" } as const;

const d = (role: Role, tool: string, path?: string): Decision =>
  decide(role, tool, path === undefined ? {} : { path }, CTX);

const A = true; // allow
const B = false; // block

const READ_TOOLS = ["read"] as const;
const SEARCH_TOOLS = ["grep", "find", "ls"] as const;
const WRITE_TOOLS = ["write", "edit"] as const;

type Row = [path: string, read: boolean, search: boolean, write: boolean];

function matrix(role: Role, rows: Row[]) {
  describe(role, () => {
    for (const [path, read, search, write] of rows) {
      test(`${role} read ${path} → ${read ? "allow" : "block"}`, () => {
        for (const tool of READ_TOOLS) {
          expect(d(role, tool, path).allow, `${tool} ${path}`).toBe(read);
        }
      });
      test(`${role} search ${path} → ${search ? "allow" : "block"}`, () => {
        for (const tool of SEARCH_TOOLS) {
          expect(d(role, tool, path).allow, `${tool} ${path}`).toBe(search);
        }
      });
      test(`${role} write ${path} → ${write ? "allow" : "block"}`, () => {
        for (const tool of WRITE_TOOLS) {
          expect(d(role, tool, path).allow, `${tool} ${path}`).toBe(write);
        }
      });
    }
  });
}

// ---------------------------------------------------------------------------
// The matrix: role × tool-class × path
// ---------------------------------------------------------------------------

matrix("architect", [
  // own artifacts: spec.md + colocated contracts
  ["spec.md", A, A, A],
  ["src/orders/orders.contract.ts", A, A, A],
  ["src/x.contract.ts", A, A, A], // ** matches zero intermediate dirs
  // builder output: blind (read), forbidden (write)
  ["src/orders/orders.ts", B, B, B],
  ["src/orders/nested/deep.ts", B, B, B],
  ["src", B, B, B],
  ["src/orders", B, B, B], // listing would reveal impl filenames
  // tests: blind, forbidden
  ["tests", B, B, B],
  ["tests/orders.test.ts", B, B, B],
  ["tests/sub/x.test.ts", B, B, B],
  // rest of repo: readable, not writable
  ["README.md", A, A, B],
  ["docs/guide.md", A, A, B],
  ["agent/extensions/web.ts", A, A, B],
  [".gitignore", A, A, B],
  // .git denied for all roles
  [".git/config", B, B, B],
  // root: readable file-by-file; unscoped listing would reveal blind zones
  [".", A, B, B],
]);

matrix("test-writer", [
  // The contract is the interface under test and MUST be readable: the
  // test-writer imports from those exact paths, and dogfood Run 5 died when
  // the gate refused the read the task prompt required (it escalated, was told
  // the wall was intentional, and exited). Contracts are declaration-only —
  // the contract-purity gate enforces that — so reading one leaks no
  // implementation. Blind to src/** means blind to the IMPLEMENTATION, never
  // to the interface. Searches over src DIRECTORIES stay blocked — a listing
  // would reveal the implementation's shape — but a search scoped to one
  // contract file is allowed, since it yields no more than reading it does.
  ["spec.md", A, A, B],
  // read AND search on a specific contract file: grepping one declaration-only
  // file yields exactly what reading it yields, so denying it buys nothing
  ["src/orders/orders.contract.ts", A, A, B],
  ["src/x.contract.ts", A, A, B],
  ["src/orders/orders.ts", B, B, B],
  ["src", B, B, B],
  ["src/orders", B, B, B],
  // own zone
  ["tests", A, A, A], // globstar: tests/** includes 'tests' itself
  ["tests/orders.test.ts", A, A, A],
  ["tests/sub/x.test.ts", A, A, A],
  ["tests/fixtures/sample.json", A, A, A],
  // rest of repo: readable, not writable
  ["README.md", A, A, B],
  ["docs/guide.md", A, A, B],
  [".git/config", B, B, B],
  [".", A, B, B],
]);

matrix("builder", [
  // spec + contract: readable, never writable
  ["spec.md", A, A, B],
  ["src/orders/orders.contract.ts", A, A, B],
  ["src/x.contract.ts", A, A, B],
  // own zone
  ["src/orders/orders.ts", A, A, A],
  ["src/orders/nested/deep.ts", A, A, A],
  ["src", A, A, A], // globstar: src/** includes 'src' itself
  ["src/orders", A, A, A], // fs decides if it's a dir; policy sees src/**
  // tests: blind, forbidden
  ["tests", B, B, B],
  ["tests/orders.test.ts", B, B, B],
  ["tests/sub/x.test.ts", B, B, B],
  // rest of repo: readable, not writable
  ["README.md", A, A, B],
  ["docs/guide.md", A, A, B],
  [".git/config", B, B, B],
  [".", A, B, B],
]);

// ---------------------------------------------------------------------------
// Forbidden tools — backup layer under the frontmatter allowlist
// ---------------------------------------------------------------------------

describe("forbidden tools (all roles)", () => {
  const roles: Role[] = ["architect", "test-writer", "builder"];
  for (const role of roles) {
    test(`${role} bash → block`, () => {
      expect(decide(role, "bash", { command: "cat tests/x.test.ts" }, CTX).allow).toBe(false);
    });
    test(`${role} subagent → block`, () => {
      expect(decide(role, "subagent", { agent: "scout" }, CTX).allow).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// Ungated tools — this module only governs path tools
// ---------------------------------------------------------------------------

test("non-path tools are out of scope (allowlist/frontmatter owns them)", () => {
  expect(decide("builder", "typecheck", {}, CTX).allow).toBe(true);
  expect(decide("builder", "run_tests", {}, CTX).allow).toBe(true);
  expect(decide("architect", "web", { url: "https://x" }, CTX).allow).toBe(true);
});

// ---------------------------------------------------------------------------
// Hostile paths — traversal laundering, absolute paths, separators, NUL
// ---------------------------------------------------------------------------

describe("hostile paths", () => {
  test("'..' laundering into a blind zone is blocked after normalization", () => {
    expect(d("builder", "read", "src/../tests/orders.test.ts").allow).toBe(false);
    expect(d("builder", "read", "./tests/orders.test.ts").allow).toBe(false);
    expect(d("builder", "read", "tests//sub/x.test.ts").allow).toBe(false);
    // contracts are readable, but implementation laundered through '..' is not
    expect(d("test-writer", "read", "tests/../src/x.ts").allow).toBe(false);
  });

  test("'..' that escapes the project root is blocked", () => {
    expect(d("builder", "write", "../escape.ts").allow).toBe(false);
    expect(d("architect", "read", "../harness-secrets").allow).toBe(false);
    expect(d("builder", "read", "docs/../../escape").allow).toBe(false);
  });

  test("absolute paths must live under the project root", () => {
    expect(d("builder", "write", "/repo/src/x.ts").allow).toBe(true);
    expect(d("builder", "read", "/repo/tests/x.test.ts").allow).toBe(false);
    expect(d("builder", "write", "/etc/evil.ts").allow).toBe(false);
    expect(d("architect", "read", "/etc/passwd").allow).toBe(false);
  });

  test("legitimate normalization still works", () => {
    expect(d("builder", "read", "src/./x.ts").allow).toBe(true);
    expect(d("builder", "read", "tests/../src/x.ts").allow).toBe(true);
    // normalizes to src/evil.ts — genuinely inside the builder's zone
    expect(d("builder", "write", "src/x.ts/../evil.ts").allow).toBe(true);
  });

  test("backslash is a literal filename char (POSIX semantics), not traversal", () => {
    // 'tests\\x' is one segment: a file named tests\x at root. Not in any zone.
    expect(d("builder", "read", "tests\\x").allow).toBe(true);
    expect(d("builder", "write", "tests\\x").allow).toBe(false); // root file: outside write zones
  });

  test("NUL byte and empty paths are rejected", () => {
    expect(d("builder", "read", "src/x\0.ts").allow).toBe(false);
    expect(d("builder", "write", "").allow).toBe(false);
  });

  test("unscoped search tools are blocked for every role", () => {
    for (const role of ["architect", "test-writer", "builder"] as const) {
      for (const tool of SEARCH_TOOLS) {
        expect(d(role, tool).allow, `${role} ${tool} (no path)`).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Block reasons are stable, one-line, greppable (TN: a deterministic system
// that is opaque when it jams is just a deterministic jam)
// ---------------------------------------------------------------------------

describe("block reasons", () => {
  const reason = (role: Role, tool: string, path?: string) => {
    const r = d(role, tool, path);
    if (r.allow) throw new Error(`expected block, got allow: ${role} ${tool} ${path}`);
    return r.reason;
  };

  test("exact reason strings", () => {
    expect(reason("builder", "read", "tests/orders.test.ts")).toBe(
      "path-gate: builder may not read 'tests/orders.test.ts': denied zone 'tests/**'",
    );
    expect(reason("builder", "write", "src/x.contract.ts")).toBe(
      "path-gate: builder may not write 'src/x.contract.ts': denied for builder (matches 'src/**/*.contract.ts')",
    );
    expect(reason("architect", "write", "src/orders/orders.ts")).toBe(
      "path-gate: architect may not write 'src/orders/orders.ts': outside architect write zones (spec.md, src/**/*.contract.ts)",
    );
    expect(reason("test-writer", "grep")).toBe(
      "path-gate: test-writer may not use unscoped 'grep': pass an explicit path inside your zones",
    );
    expect(reason("builder", "bash", "ignored")).toBe(
      "path-gate: builder may not use 'bash': forbidden for pipeline roles (frontmatter allowlist is the primary layer)",
    );
    expect(reason("builder", "write", "../escape.ts")).toBe(
      "path-gate: builder may not write '../escape.ts': path escapes project root",
    );
    expect(reason("architect", "read", "/etc/passwd")).toBe(
      "path-gate: architect may not read '/etc/passwd': absolute path outside project root (/repo)",
    );
    expect(reason("builder", "read", ".git/config")).toBe(
      "path-gate: builder may not read '.git/config': '.git' is denied for all roles",
    );
    expect(reason("builder", "ls", ".")).toBe(
      "path-gate: builder may not search '.': overlaps denied zone 'tests'",
    );
  });
});

// --- ownerOfPath --------------------------------------------------------------
// "Who may fix this file?" — derived from the same write zones as decide(), so
// gate routing can never disagree with what the path gate actually permits.

describe("ownerOfPath", () => {
  const cases: [path: string, owner: Role | null][] = [
    ["spec.md", "architect"],
    ["src/orders/orders.contract.ts", "architect"],
    ["src/orders.contract.ts", "architect"],
    ["tests/orders.test.ts", "test-writer"],
    ["tests/fakes/clock.ts", "test-writer"],
    ["src/orders/orders.ts", "builder"],
    ["src/shared/errors.ts", "builder"],
    // Outside every write zone: nobody in the pipeline may fix it.
    ["vitest.config.ts", null],
    ["package.json", null],
    ["tsconfig.json", null],
    ["docs/notes.md", null],
  ];
  for (const [path, owner] of cases) {
    test(`${path} → ${owner ?? "(unowned)"}`, () => {
      expect(ownerOfPath(path)).toBe(owner);
    });
  }

  test("normalizes before matching (leading ./ and redundant segments)", () => {
    expect(ownerOfPath("./tests/orders.test.ts")).toBe("test-writer");
    expect(ownerOfPath("src/orders/../orders/orders.ts")).toBe("builder");
  });

  test("paths escaping the project root are unowned, never mis-routed", () => {
    expect(ownerOfPath("../elsewhere/src/x.ts")).toBe(null);
  });

  test("every owned path agrees with decide(): its owner may write it", () => {
    for (const [path, owner] of cases) {
      if (owner === null) continue;
      expect(decide(owner, "write", { path }, CTX).allow, `${owner} write ${path}`).toBe(true);
    }
  });
});
