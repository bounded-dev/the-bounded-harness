import { afterAll, describe, it } from "vitest";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { fsdDownwardImports } from "./fsd-downward-imports.ts";

// TN-26-006: shared < entities < features < widgets < pages, and imports flow
// strictly downward.
//
// THE VALID LIST IS THE LOAD-BEARING HALF. A directional rule that refuses too
// much is worse than no rule at all: every correct import it blocks is a bounce
// the worker cannot resolve by writing better code, only by arguing with a
// gate. So the cases below are mostly the shapes that MUST pass — every legal
// direction, every path that leaves the UI root, every file that belongs to no
// layer.

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("fsd-downward-imports", fsdDownwardImports, {
  valid: [
    // --- every legal direction -------------------------------------------
    {
      code: `import { Button } from "../../shared/ui/button.js";`,
      filename: "src/ui/entities/building/status.tsx",
    },
    {
      code: `import { BuildingCard } from "../../entities/building/index.js";`,
      filename: "src/ui/features/submit-report/form.tsx",
    },
    {
      code: `import { SubmitReport } from "../features/submit-report/index.js";`,
      filename: "src/ui/pages/dashboard.tsx",
    },
    {
      code: `import { Toolbar } from "../widgets/toolbar/index.js";`,
      filename: "src/ui/pages/dashboard.tsx",
    },
    // Same layer, different slice: direction is fine (the public-API rule has
    // its own opinion about the shape).
    {
      code: `import { Meter } from "../meter/index.js";`,
      filename: "src/ui/entities/building/status.tsx",
    },
    // Same slice, and its own segments.
    {
      code: `import { useBuilding } from "./model/query.js";`,
      filename: "src/ui/entities/building/index.ts",
    },
    // shared reaching within shared.
    {
      code: `import { cn } from "../lib/cn.js";`,
      filename: "src/ui/shared/ui/button.tsx",
    },

    // --- not this rule's business ----------------------------------------
    // The domain and the contracts live outside src/ui; the direction being
    // policed is the UI's own internal one.
    {
      code: `import type { BuildingId } from "../../../heating/heating.js";`,
      filename: "src/ui/shared/ui/badge.tsx",
    },
    // Packages are not layers.
    {
      code: `import { useMemo } from "react";`,
      filename: "src/ui/shared/ui/button.tsx",
    },
    // A file directly under src/ui belongs to no layer and composes everything.
    {
      code: `import { App } from "./pages/app.js";`,
      filename: "src/ui/main.tsx",
    },
    // Not a frontend file at all.
    {
      code: `import { createReport } from "../features/x.js";`,
      filename: "src/heating/heating.ts",
    },
    // An import that climbs out of src/ui entirely.
    {
      code: `import { clock } from "../../../../shared/clock.js";`,
      filename: "src/ui/entities/building/status.tsx",
    },
  ],
  invalid: [
    // The archetype: a shared component reaching into a feature. It compiles,
    // it runs, and it has just made the Button unreusable.
    {
      code: `import { ReportForm } from "../../features/submit-report/index.js";`,
      filename: "src/ui/shared/ui/button.tsx",
      errors: [{ messageId: "upward", data: { from: "shared", to: "features" } }],
    },
    {
      code: `import { Dashboard } from "../../pages/dashboard.js";`,
      filename: "src/ui/entities/building/status.tsx",
      errors: [{ messageId: "upward", data: { from: "entities", to: "pages" } }],
    },
    {
      code: `import { SubmitReport } from "../../features/submit-report/index.js";`,
      filename: "src/ui/entities/building/status.tsx",
      errors: [{ messageId: "upward", data: { from: "entities", to: "features" } }],
    },
    // widgets sits between features and pages, even though nothing emits it.
    {
      code: `import { Toolbar } from "../../widgets/toolbar/index.js";`,
      filename: "src/ui/features/submit-report/form.tsx",
      errors: [{ messageId: "upward", data: { from: "features", to: "widgets" } }],
    },
    // A type import is a dependency too: shared props typed by a feature's
    // model couples them just as firmly, and the coupling vanishing at runtime
    // does not make it less of an inversion.
    {
      code: `import type { ReportDraft } from "../../features/submit-report/index.js";`,
      filename: "src/ui/shared/ui/field.tsx",
      errors: [{ messageId: "upward", data: { from: "shared", to: "features" } }],
    },
    // Re-exporting upward is importing upward on somebody else's behalf.
    {
      code: `export { ReportForm } from "../../features/submit-report/index.js";`,
      filename: "src/ui/shared/ui/index.ts",
      errors: [{ messageId: "upward", data: { from: "shared", to: "features" } }],
    },
    {
      code: `export * from "../../pages/dashboard.js";`,
      filename: "src/ui/entities/building/index.ts",
      errors: [{ messageId: "upward", data: { from: "entities", to: "pages" } }],
    },
    // An absolute path resolves the same way — the last src/ui/ wins.
    {
      code: `import { Dashboard } from "../../pages/dashboard.js";`,
      filename: "/home/dev/project/src/ui/entities/building/status.tsx",
      errors: [{ messageId: "upward", data: { from: "entities", to: "pages" } }],
    },
  ],
});
