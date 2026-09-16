import { describe, expect, test } from "vitest";
import { composePacks } from "../src/socket-registry.ts";
import { composedPacks, INSTALLED_PACKS } from "./installed.ts";
import { contractPurityOverrides, lintSrcRules, TS_PACK } from "./ts/pack.ts";
import { TS_WEB_PACK } from "./ts-web/pack.ts";

// The real composition, composed for real. socket-registry.test.ts proves the
// mechanism with synthetic packs; this file proves that the harness's own packs
// are wired to it — the half that silently rots when someone adds a pack and
// forgets the list, or renames a socket and updates only one side.

describe("the harness's own composition", () => {
  test("composes without a refusal", () => {
    expect(() => composedPacks()).not.toThrow();
  });

  test("is memoized — a gate reads the same registry every call", () => {
    expect(composedPacks()).toBe(composedPacks());
  });

  test("composes ts before ts-web, because ts-web declares the edge", () => {
    expect(composedPacks().packs).toEqual([TS_PACK, TS_WEB_PACK]);
  });

  // The socket vocabulary is closed and curated (TN-26-005): a socket is born
  // with the machinery that consumes it, and ordinary packs are
  // contribution-only. ts is the foundational pack, so ts owns every socket
  // there is; a new socket appearing here without an ADR behind it is the
  // drift this test exists to make visible.
  test("the ts pack owns both lint sockets, and nothing else defines one", () => {
    const sockets = composedPacks().sockets;
    expect(sockets.map((s) => s.id)).toEqual(["contractPurityOverrides", "lintSrcRules"]);
    expect(sockets.every((s) => s.owner === TS_PACK)).toBe(true);
  });

  test("every pack but ts is contribution-only", () => {
    const definers = INSTALLED_PACKS.filter((p) => p.defines.length > 0).map((p) => p.name);
    expect(definers).toEqual([TS_PACK]);
  });

  test("every socket carries a description — a nameless extension point teaches nobody", () => {
    for (const socket of composedPacks().sockets) {
      expect(socket.description.length, `socket '${socket.id}'`).toBeGreaterThan(20);
    }
  });
});

describe("composition-at-initiation is a parameter, not a rewrite", () => {
  // TN-26-005's future work, exercised today against the real packs: a project
  // that composes only ts gets the ts gates and nothing web-flavoured. If this
  // ever needs more than a second argument, the design failed.
  test("composing ts alone leaves both sockets defined and empty", () => {
    const registry = composePacks(INSTALLED_PACKS, [TS_PACK]);
    expect(registry.packs).toEqual([TS_PACK]);
    expect(registry.read(lintSrcRules)).toEqual([]);
    expect(registry.read(contractPurityOverrides)).toEqual([]);
  });

  test("composing ts-web without ts is refused — the edge is not optional", () => {
    expect(() => composePacks(INSTALLED_PACKS, [TS_WEB_PACK])).toThrow(
      /pack 'ts-web' depends on pack 'ts'/,
    );
  });
});
