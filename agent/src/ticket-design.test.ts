import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { activeTicketDesign, ticketWriteScope } from "./ticket-design.ts";
import { computeManifest, runChecksumGate } from "../packs/ts/scripts/checksum-gate.ts";
import { readReviewed, runRecordDesignReview } from "../packs/ts/scripts/design-review.ts";
import { classifyReviewFreshness } from "../packs/ts/scripts/design-gate.ts";
import { readGuardLog } from "./guard-log.ts";
import { decide } from "./path-policy.ts";
import { evaluatePathGate } from "./path-gate.ts";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "bounded-ticket-design-"));
  roots.push(root);
  mkdirSync(join(root, "docs/tn"), { recursive: true });
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "docs/tn/README.md"), "# Technical Notes\n");
  for (const n of [24, 25]) {
    writeFileSync(join(root, `docs/tn/TN-${n}.md`),
      `---\nissue: ${n}\nstatus: active\ncontracts:\n  - src/t${n}.contract.ts\n---\n\n# Ticket ${n}\n`);
    writeFileSync(join(root, `src/t${n}.contract.ts`), `export interface T${n} {}\n`);
  }
  return root;
}

describe("ticket-numbered design", () => {
  test("requires an active issue number and prevents overlapping ownership", () => {
    const root = project();
    expect(() => activeTicketDesign(root)).toThrow(/BOUNDED_TICKET/);
    vi.stubEnv("BOUNDED_TICKET", "24");
    expect(activeTicketDesign(root)?.note).toBe("docs/tn/TN-24.md");
    writeFileSync(join(root, "docs/tn/TN-25.md"),
      "---\r\nissue: 25\r\nstatus: active\r\ncontracts:\r\n  - src/t24.contract.ts\r\n---\r\n");
    expect(() => activeTicketDesign(root)).toThrow(/both own src\/t24.contract.ts/);
    writeFileSync(join(root, "docs/tn/TN-25.md"),
      "---\nissue: 25\nstatus: superseded\ncontracts:\n  - src/t24.contract.ts\n---\n\nSuperseded by [TN-24](TN-24.md).\n");
    expect(activeTicketDesign(root)?.ticket).toBe("24");
  });

  test("architect writes only its declared contracts, including before creation", () => {
    const root = project();
    vi.stubEnv("BOUNDED_TICKET", "24");
    const scope = ticketWriteScope(root)!;
    const ctx = { cwd: root, ticketScope: { ticket: scope.ticket, contracts: scope.contracts } };
    expect(decide("architect", "write", { path: "src/t24.contract.ts" }, ctx).allow).toBe(true);
    expect(decide("architect", "write", { path: "src/t25.contract.ts" }, ctx).allow).toBe(false);
    expect(decide("architect", "write", { path: "src/T24.contract.ts" }, ctx).allow).toBe(false);
    expect(evaluatePathGate({ role: "architect", toolName: "write", input: { path: "src/t25.contract.ts" }, cwd: root })?.reason)
      .toContain("not owned by ticket #24");
    expect(decide("architect", "write", { path: "docs/tn/TN-25.md" }, ctx).allow).toBe(false);
    expect(decide("architect", "write", { path: "spec.md" }, ctx).allow).toBe(false);
    writeFileSync(join(root, "docs/tn/TN-24.md"),
      "---\nissue: 24\nstatus: draft\ncontracts:\n  - src/t24.contract.ts\n  - src/new.contract.ts\n---\n");
    expect(decide("architect", "write", { path: "src/new.contract.ts" },
      { cwd: root, ticketScope: ticketWriteScope(root) }).allow).toBe(true);
  });

  test("two tickets freeze and review only their own note and contracts", () => {
    const root = project();
    vi.stubEnv("BOUNDED_TICKET", "24");
    expect(Object.keys(computeManifest(root).files)).toEqual(["src/t24.contract.ts"]);
    expect(runRecordDesignReview(root, []).code).toBe(0);
    expect(runChecksumGate(root, true).code).toBe(0);
    const first = readReviewed(root);
    if (!first.ok) throw new Error(first.error);
    expect(Object.keys(first.reviewed)).toEqual(["docs/tn/TN-24.md", "src/t24.contract.ts"]);
    vi.stubEnv("BOUNDED_TICKET", "25");
    expect(runRecordDesignReview(root, []).code).toBe(0);
    expect(runChecksumGate(root, true).code).toBe(0);
    expect(runChecksumGate(root, false).code).toBe(0);
    vi.stubEnv("BOUNDED_TICKET", "24");
    writeFileSync(join(root, "src/t25.contract.ts"), "export interface T25 { changed: true }\n");
    expect(runChecksumGate(root, false).code).toBe(0);
    expect(classifyReviewFreshness(readGuardLog(root), first.reviewed, "24").state).toBe("fresh");
    writeFileSync(join(root, "docs/tn/TN-24.md"),
      "---\nissue: 24\nstatus: active\ncontracts:\n  - src/t24.contract.ts\n---\n\n# Revised ticket\n");
    expect(runChecksumGate(root, false).code).toBe(1);
  });
});
