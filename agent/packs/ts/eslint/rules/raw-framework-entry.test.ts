import { afterAll, describe, it } from "vitest";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { rawFrameworkEntry } from "./raw-framework-entry.ts";

// TN-26-004: the shipped service runtime is the only src/** module allowed a
// runtime import of the RPC framework — the error taxonomy is code in that
// one file, and a second initTRPC is a second chance to get it wrong.

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("raw-framework-entry", rawFrameworkEntry, {
  valid: [
    // THE CORRECT FORM: procedures come from the shipped runtime.
    `import { createService, applied } from "./service-runtime.js";`,
    // Type-only imports harm nothing, anywhere.
    `import type { TRPCError } from "@trpc/server";
export declare function explain(e: TRPCError): string;`,
    // Inline type specifiers are type-only in effect.
    `import { type inferRouterInputs } from "@trpc/server";`,
    // The runtime file itself is exempt by name.
    {
      code: `import { initTRPC } from "@trpc/server";
export const t = initTRPC.create();`,
      filename: "src/api/service-runtime.ts",
    },
  ],
  invalid: [
    {
      code: `import { initTRPC } from "@trpc/server";`,
      filename: "src/api/api.ts",
      errors: [{ messageId: "rawEntry", data: { source: "@trpc/server" } }],
    },
    // A value import of TRPCError re-maps codes by hand — same door.
    {
      code: `import { TRPCError } from "@trpc/server";`,
      filename: "src/api/errors.ts",
      errors: [{ messageId: "rawEntry", data: { source: "@trpc/server" } }],
    },
    // Adapters are the framework too.
    {
      code: `import { createHTTPServer } from "@trpc/server/adapters/standalone";`,
      filename: "src/api/server.ts",
      errors: [{ messageId: "rawEntry", data: { source: "@trpc/server/adapters/standalone" } }],
    },
    // Re-exporting the framework is importing it for someone else.
    {
      code: `export * from "@trpc/server";`,
      filename: "src/api/facade.ts",
      errors: [{ messageId: "rawEntry", data: { source: "@trpc/server" } }],
    },
  ],
});
