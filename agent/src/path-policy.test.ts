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

// The architect owns one ticket end to end: it designs, commissions the tests,
// commissions the build, and arbitrates disputes between the two blind roles.
// It therefore READS EVERYTHING and WRITES ALMOST NOTHING.
//
// Blindness is preserved exactly where it is proven load-bearing — the
// test-writer cannot see the implementation, the builder cannot see the tests —
// and the architect is no threat to it because it writes NEITHER. A role that
// cannot write a test cannot make a test agree with an implementation, which is
// the failure the separation exists to prevent. Meanwhile it must read both:
// arbitrating "this test contradicts the spec" is impossible without reading
// the test, and answering "why is this failing?" is the human's whole reason
// for talking to it.
matrix("architect", [
  // own artifacts: spec.md + colocated contracts — the ONLY writable paths
  ["spec.md", A, A, A],
  ["src/orders/orders.contract.ts", A, A, A],
  ["src/x.contract.ts", A, A, A], // ** matches zero intermediate dirs
  // builder output: readable (arbitration + diagnosis), never writable
  ["src/orders/orders.ts", A, A, B],
  ["src/orders/nested/deep.ts", A, A, B],
  ["src", A, A, B],
  ["src/orders", A, A, B],
  // tests: readable (arbitration), never writable — this is the one that stops
  // the tempting shortcut when the builder is stuck and the clock is running
  ["tests", A, A, B],
  ["tests/orders.test.ts", A, A, B],
  ["tests/sub/x.test.ts", A, A, B],
  // rest of repo: readable, not writable
  ["README.md", A, A, B],
  ["docs/guide.md", A, A, B],
  ["agent/extensions/web.ts", A, A, B],
  [".gitignore", A, A, B],
  // .git denied for all roles
  [".git/config", B, B, B],
  // Root search stays blocked, but now for ONE reason only: it overlaps
  // `.git`, which is denied to everybody. With the architect's readDeny empty
  // there is no pipeline blind zone left for it to trip over, so issue #8's
  // friction (`ls src`, `ls tests`, `grep` across the tree) is gone for this
  // role — only the `.git` overlap remains, and that wants result filtering
  // rather than a widened zone.
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

describe("forbidden tools", () => {
  const roles: Role[] = ["architect", "test-writer", "builder"];

  // `bash` is forbidden to EVERY role including the architect. A shell defeats
  // every path rule at once, so the architect gets named tools for the things
  // it legitimately needs (the gates, git) rather than a way to run anything.
  for (const role of roles) {
    test(`${role} bash → block`, () => {
      expect(decide(role, "bash", { command: "cat tests/x.test.ts" }, CTX).allow).toBe(false);
    });
  }

  // `subagent` and `git` are the architect's, and ONLY the architect's.
  //
  // git is the sharper of the two: `git show HEAD:tests/billing.test.ts` hands
  // the builder the test source in one call, and `git log -p` does it by
  // accident. Full git in a blind role's hands defeats blindness more
  // completely than bash would.
  for (const role of ["test-writer", "builder"] as const) {
    test(`${role} subagent → block`, () => {
      expect(decide(role, "subagent", { agent: "scout" }, CTX).allow).toBe(false);
    });
    test(`${role} git → block (git show would reveal the other side's work)`, () => {
      expect(decide(role, "git", { args: ["show", "HEAD:tests/x.test.ts"] }, CTX).allow).toBe(
        false,
      );
    });
  }

  test("architect holds subagent — it commissions the two blind roles", () => {
    expect(decide("architect", "subagent", { agent: "builder" }, CTX).allow).toBe(true);
  });

  test("architect holds git — reflog/bisect archaeology is its job", () => {
    expect(decide("architect", "git", { args: ["reflog"] }, CTX).allow).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The guard log's own directory: readable by all, writable by none
// ---------------------------------------------------------------------------

// `.pi/` holds the guard log and the contract-checksum manifest — the audit
// trail and the drift evidence. Agents must READ them (diagnosing a jam, citing
// the log when escalating) and must never WRITE them, or the record of what
// happened becomes something the accused can edit. The gates write these files
// through plain `fs`, which never passes through the tool hook, so they are
// unaffected. Already closed by the write allowlist; this makes it explicit.
describe(".pi is write-denied for every role, read-allowed for all", () => {
  const roles: Role[] = ["architect", "test-writer", "builder"];
  for (const role of roles) {
    test(`${role} may not write .pi/guard-log.jsonl`, () => {
      expect(d(role, "write", ".pi/guard-log.jsonl").allow).toBe(false);
      expect(d(role, "edit", ".pi/contract-checksums.json").allow).toBe(false);
    });
  }
  test("architect may read the guard log it is expected to cite", () => {
    expect(d("architect", "read", ".pi/guard-log.jsonl").allow).toBe(true);
  });
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
      "path-gate: builder may not use 'bash': forbidden for builder (frontmatter allowlist is the primary layer)",
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

// ---------------------------------------------------------------------------
// Case: the filesystem is case-insensitive, so the gate must be too
// ---------------------------------------------------------------------------

// Two findings, one cause. The friendly one (dogfood Run 6): the architect
// tried to write `SPEC.md`, was refused because the zone glob is the literal
// `spec.md`, and lost turns to a rule that reads as arbitrary — on macOS those
// are the SAME FILE.
//
// The serious one: the same case-sensitivity applies to the DENY side. On a
// case-insensitive filesystem `TESTS/orders.test.ts` IS the tests directory,
// but a case-sensitive `tests/**` pattern does not match it — so a case-varied
// path would walk straight through the blindness the whole pipeline rests on.
describe("zone matching is case-insensitive", () => {
  test("the architect may write its spec whatever the case", () => {
    for (const p of ["spec.md", "SPEC.md", "Spec.md"]) {
      expect(d("architect", "write", p).allow, `write ${p}`).toBe(true);
    }
  });

  test("a case-varied tests path does not escape the builder's blindness", () => {
    for (const p of ["tests/orders.test.ts", "TESTS/orders.test.ts", "Tests/Orders.Test.ts"]) {
      expect(d("builder", "read", p).allow, `read ${p}`).toBe(false);
    }
  });

  test("a case-varied src path does not escape the test-writer's blindness", () => {
    for (const p of ["src/money.ts", "SRC/money.ts", "Src/Money.ts"]) {
      expect(d("test-writer", "read", p).allow, `read ${p}`).toBe(false);
    }
  });

  test("a case-varied contract path is still denied to the builder's pen", () => {
    for (const p of ["src/money.contract.ts", "src/money.CONTRACT.ts"]) {
      expect(d("builder", "write", p).allow, `write ${p}`).toBe(false);
    }
  });

  test("'.git' is denied whatever the case", () => {
    for (const p of [".git/config", ".GIT/config", ".Git/config"]) {
      expect(d("architect", "read", p).allow, `read ${p}`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Reading the harness's own skill files
// ---------------------------------------------------------------------------

// Every run so far has opened with the architect trying to read
// `~/.pi/agent/skills/developer-stage/SKILL.md` and being refused — five
// attempts across four runs, for two different skills. That block was never a
// deliberate policy: it falls out of the generic "absolute path outside the
// project root" containment rule.
//
// Skill files are the agent's own instructions. They contain nothing about the
// run, so reading one leaks neither the tests nor the implementation, and the
// agent asking for them is behaving reasonably.
//
// But the harness root is NOT safe to open wholesale: `auth.json` holds
// credentials and `sessions/` holds transcripts of every other session on the
// machine. So allow the instruction content specifically, read-only.
const HARNESS = "/Users/x/.pi/agent";
const H = (role: Role, tool: string, path: string): Decision =>
  decide(role, tool, { path }, { cwd: "/repo", harnessRoot: HARNESS });

describe("harness skill files are readable, the rest of the harness is not", () => {
  const roles: Role[] = ["architect", "test-writer", "builder"];

  for (const role of roles) {
    test(`${role} may read a top-level skill`, () => {
      expect(H(role, "read", `${HARNESS}/skills/developer-stage/SKILL.md`).allow).toBe(true);
    });
    test(`${role} may read a pack skill`, () => {
      expect(
        H(role, "read", `${HARNESS}/packs/ts/skills/ts-contract-authoring/SKILL.md`).allow,
      ).toBe(true);
    });
    test(`${role} may read a skill's reference files`, () => {
      expect(H(role, "read", `${HARNESS}/skills/issue-tracking/references/setup.md`).allow).toBe(
        true,
      );
    });

    // The part that must stay shut.
    test(`${role} may NOT read harness credentials`, () => {
      expect(H(role, "read", `${HARNESS}/auth.json`).allow).toBe(false);
    });
    test(`${role} may NOT read other sessions' transcripts`, () => {
      expect(H(role, "read", `${HARNESS}/sessions/whatever.jsonl`).allow).toBe(false);
    });
    test(`${role} may NOT read the harness's own source`, () => {
      expect(H(role, "read", `${HARNESS}/src/path-policy.ts`).allow).toBe(false);
    });
    test(`${role} may NOT write a skill file`, () => {
      expect(H(role, "write", `${HARNESS}/skills/developer-stage/SKILL.md`).allow).toBe(false);
      expect(H(role, "edit", `${HARNESS}/skills/developer-stage/SKILL.md`).allow).toBe(false);
    });
    // A path that merely mentions the harness must not be a way out.
    test(`${role} may NOT traverse out of a skills path`, () => {
      expect(H(role, "read", `${HARNESS}/skills/../auth.json`).allow).toBe(false);
      expect(H(role, "read", `${HARNESS}/skills/x/../../auth.json`).allow).toBe(false);
    });
  }

  test("with no harnessRoot configured, nothing outside the project opens up", () => {
    expect(d("architect", "read", `${HARNESS}/skills/developer-stage/SKILL.md`).allow).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// run_tests is the builder's channel, and only the builder's
// ---------------------------------------------------------------------------

// Run 6's architect called `run_tests` once. Harmless in that instance — it was
// diagnosing a blocked red gate — but it revealed a drift: ROLE_TOOLS.architect
// does not list run_tests, yet nothing enforced that, because run_tests is not
// a PATH tool and the gate only inspected path tools.
//
// The declared allowlist binds subagents through their frontmatter. A session
// launched from `.pi/dev-stage-role` has no frontmatter, so the allowlist is
// documentation there and the gate is the only enforcement. It should agree
// with what ROLE_TOOLS says.
//
// run_tests exists as the blind-safe debugging channel for the one role that
// implements against a suite it cannot read. The architect can read the tests
// and has red_gate and green_gate; the test-writer has neither need nor
// business running the implementation.
describe("run_tests is builder-only", () => {
  test("the builder may run it — it is the whole point of the tool", () => {
    expect(decide("builder", "run_tests", {}, CTX).allow).toBe(true);
  });

  for (const role of ["architect", "test-writer"] as const) {
    test(`${role} may not run it`, () => {
      const d = decide(role, "run_tests", {}, CTX);
      expect(d.allow).toBe(false);
      if (!d.allow) expect(d.reason).toMatch(/red_gate|green_gate|builder/);
    });
  }

  test("every role keeps typecheck — each must confirm its own work compiles", () => {
    for (const role of ["architect", "test-writer", "builder"] as const) {
      expect(decide(role, "typecheck", {}, CTX).allow).toBe(true);
    }
  });
});
