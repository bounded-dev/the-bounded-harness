import { afterAll, describe, it } from "vitest";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { fsdSlicePublicApi } from "./fsd-slice-public-api.ts";

// TN-26-006: a cross-slice import targets the slice root; same-slice deep
// imports are free.
//
// THE VALID LIST IS THE LOAD-BEARING HALF, and here it is doubly so: this rule
// is the one most likely to fire on correct code if its idea of "the slice
// root" is too narrow. All three spellings of a slice's door have to pass, and
// so does every import that never crosses a slice boundary at all — which, in a
// slice being built, is most of them.

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("fsd-slice-public-api", fsdSlicePublicApi, {
  valid: [
    // --- all three spellings of the door ---------------------------------
    {
      code: `import { Meter } from "../meter";`,
      filename: "src/ui/entities/building/status.tsx",
    },
    {
      code: `import { Meter } from "../meter/index.js";`,
      filename: "src/ui/entities/building/status.tsx",
    },
    {
      code: `import { Meter } from "../meter/index";`,
      filename: "src/ui/entities/building/status.tsx",
    },
    // Across layers, through the door.
    {
      code: `import { BuildingCard } from "../../entities/building/index.js";`,
      filename: "src/ui/features/submit-report/form.tsx",
    },
    {
      code: `import { SubmitReport } from "../features/submit-report";`,
      filename: "src/ui/pages/dashboard.tsx",
    },

    // --- inside your own slice, reach for anything ------------------------
    {
      code: `import { useBuilding } from "./model/query.js";`,
      filename: "src/ui/entities/building/index.ts",
    },
    {
      code: `import { statusColour } from "../lib/colour.js";`,
      filename: "src/ui/entities/building/ui/badge.tsx",
    },
    {
      code: `import { BuildingRow } from "../../building/ui/row.js";`,
      filename: "src/ui/entities/building/model/query.ts",
    },

    // --- not this rule's business ----------------------------------------
    // `shared` is segments, not slices: it is not domain-partitioned, so there
    // is no public API for this rule to talk about.
    {
      code: `import { Button } from "../../shared/ui/button.js";`,
      filename: "src/ui/entities/building/status.tsx",
    },
    {
      code: `import { useServiceClient } from "../../../shared/api/client.js";`,
      filename: "src/ui/features/submit-report/model/command.ts",
    },
    // Packages, and anything outside src/ui.
    {
      code: `import { useQuery } from "@tanstack/react-query";`,
      filename: "src/ui/entities/building/model/query.ts",
    },
    {
      code: `import type { BuildingId } from "../../../../heating/heating.js";`,
      filename: "src/ui/entities/building/model/query.ts",
    },
    // Not a frontend file.
    {
      code: `import { x } from "../entities/building/model/query.js";`,
      filename: "src/heating/heating.ts",
    },
    // A file directly under src/ui is in no slice, and reaching a slice's door
    // is still the door.
    {
      code: `import { App } from "./pages/app";`,
      filename: "src/ui/main.tsx",
    },
  ],
  invalid: [
    // The archetype: the deep path is the one you just read, the file exists,
    // the export exists, the import resolves, and nothing but this objects.
    {
      code: `import { useBuilding } from "../building/model/query.js";`,
      filename: "src/ui/entities/meter/status.tsx",
      errors: [{ messageId: "deepImport", data: { specifier: "../building/model/query.js", slice: "entities/building" } }],
    },
    {
      code: `import { BuildingRow } from "../../entities/building/ui/row.js";`,
      filename: "src/ui/features/submit-report/form.tsx",
      errors: [{ messageId: "deepImport", data: { specifier: "../../entities/building/ui/row.js", slice: "entities/building" } }],
    },
    // A nested index that is not the SLICE's index is still inside the slice.
    {
      code: `import { rows } from "../building/ui/index.js";`,
      filename: "src/ui/entities/meter/status.tsx",
      errors: [{ messageId: "deepImport", data: { specifier: "../building/ui/index.js", slice: "entities/building" } }],
    },
    // Types pin a path just as firmly as values do.
    {
      code: `import type { BuildingRow } from "../building/model/row.js";`,
      filename: "src/ui/entities/meter/status.tsx",
      errors: [{ messageId: "deepImport", data: { specifier: "../building/model/row.js", slice: "entities/building" } }],
    },
    // Re-exporting somebody's internals launders them into your own door.
    {
      code: `export { useBuilding } from "../building/model/query.js";`,
      filename: "src/ui/entities/meter/index.ts",
      errors: [{ messageId: "deepImport", data: { specifier: "../building/model/query.js", slice: "entities/building" } }],
    },
    {
      code: `export * from "../building/model/query.js";`,
      filename: "src/ui/entities/meter/index.ts",
      errors: [{ messageId: "deepImport", data: { specifier: "../building/model/query.js", slice: "entities/building" } }],
    },
    // Pages are sliced too.
    {
      code: `import { header } from "../dashboard/ui/header.js";`,
      filename: "src/ui/pages/settings/index.tsx",
      errors: [{ messageId: "deepImport", data: { specifier: "../dashboard/ui/header.js", slice: "pages/dashboard" } }],
    },
    // And so are widgets, the reserved layer.
    {
      code: `import { bar } from "../../widgets/toolbar/ui/bar.js";`,
      filename: "src/ui/pages/dashboard/index.tsx",
      errors: [{ messageId: "deepImport", data: { specifier: "../../widgets/toolbar/ui/bar.js", slice: "widgets/toolbar" } }],
    },
  ],
});
