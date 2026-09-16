// The ts-web reference layout, as text (TN-26-006 B1).
//
// WHY THESE ARE STRINGS AND NOT FILES. The ts pack's one shipped artifact —
// `packs/ts/api/service-runtime.ts` — is a real file, copied verbatim, and it
// typechecks inside the harness because it imports nothing but `@trpc/server`.
// A frontend skeleton cannot be that: `main.tsx` imports an `App` the target's
// own contract has not declared yet, `client.tsx` imports the router type out of
// the target's own service contract, and `app.css` is not TypeScript at all.
// Files that cannot resolve inside the harness cannot typecheck inside it
// either, so storing them as files would buy nothing and cost a tsconfig full
// of exclusions.
//
// The verification happens where it is actually available instead: the
// generator's suite emits the whole layout into a temp project, symlinks the
// harness's `node_modules`, writes the tsconfig a web target uses, and runs the
// real `tsc` over it — the red gate's shadow-project trick, applied to a
// generator. The pinned web stack in the harness's package.json is what makes
// that possible, and it is the same pin list `contrib.json` records for deliver.
//
// EVERY EXPORT HERE IS THE FILE'S BODY WITHOUT ITS MARKER. `markerFor` in
// new-web-app.ts prepends the marker in the comment syntax the extension
// demands, so the marker sentence has exactly one source.

/** The CSS-first Tailwind v4 entry, plus the token block everything restyles
 *  through (TN-26-006: shadcn components are pack-owned and never hand-edited,
 *  so tokens are the whole restyling surface).
 *
 *  `@theme` is Tailwind v4's CSS-first configuration — these custom properties
 *  BECOME utilities (`--color-primary` gives `bg-primary`, `text-primary`), so
 *  the component kit can name semantic colours and a project can repaint the
 *  whole app by editing this one block. No `tailwind.config.js` exists in v4
 *  and none should be added. */
export const APP_CSS = `@import "tailwindcss";

/* The design tokens. Restyling this app means editing THIS block: the
   component kit under shared/ui is generated and pack-owned, so a variant
   these tokens cannot express is a pack change, not a local edit. */
@theme {
  --color-background: oklch(1 0 0);
  --color-foreground: oklch(0.21 0.02 264);
  --color-muted: oklch(0.97 0.01 264);
  --color-muted-foreground: oklch(0.55 0.02 264);
  --color-primary: oklch(0.55 0.18 264);
  --color-primary-foreground: oklch(0.99 0 0);
  --color-destructive: oklch(0.58 0.22 27);
  --color-destructive-foreground: oklch(0.99 0 0);
  --color-border: oklch(0.92 0.01 264);
  --color-ring: oklch(0.55 0.18 264);
  --radius-card: 0.75rem;
}

@media (prefers-color-scheme: dark) {
  @theme {
    --color-background: oklch(0.21 0.02 264);
    --color-foreground: oklch(0.98 0 0);
    --color-muted: oklch(0.27 0.02 264);
    --color-muted-foreground: oklch(0.71 0.02 264);
    --color-border: oklch(0.32 0.02 264);
  }
}

html,
body,
#root {
  height: 100%;
}

body {
  background-color: var(--color-background);
  color: var(--color-foreground);
}
`;

/** The Vite entry document. `/src/ui/main.tsx` is an absolute, project-rooted
 *  specifier because Vite serves from the project root, not from `index.html`'s
 *  directory. */
export const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/ui/main.tsx"></script>
  </body>
</html>
`;

/**
 * Vite's config: React, Tailwind v4's own plugin, and the `/trpc` proxy.
 *
 * THE PROXY IS A PLACEHOLDER and says so in the file. The dev server and the
 * service's HTTP entry are two processes, and making `npm run dev` start both —
 * and agree on a port — is Phase C. Until then the proxy points at the default
 * `serveStandalone` port, which is right often enough to be useful and wrong
 * loudly enough to be noticed.
 */
export const VITE_CONFIG = `import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      // PLACEHOLDER (TN-26-006 Phase C wires this for real). The service's HTTP
      // entry is \`serveStandalone\` from the generated service-runtime; point
      // this at wherever it listens. Until \`npm run dev\` starts both processes,
      // run the service yourself in another terminal.
      "/trpc": { target: "http://localhost:3000", changeOrigin: true },
    },
  },
});
`;

/**
 * The browser entry.
 *
 * It mounts `<App />` from `./app.js`, and the generator does NOT emit
 * `src/ui/app.tsx`: that file is the architect's to declare as
 * `src/ui/app.contract.ts`, after which `design_gate`'s scaffold step writes a
 * throwing `.tsx` skeleton for it (TN-26-006 A1) and the builder implements it.
 * A generated placeholder there would be a file the scaffolder overwrites and
 * the builder then un-marks, so the next sync would see hand-written work at a
 * pack-owned path and block — the layout would fight the pipeline once per run.
 *
 * `./app.js` with a `.js` extension is the harness's NodeNext specifier style,
 * which Vite resolves to `app.tsx` natively. One spelling, both toolchains.
 */
export function mainTsx(options: { readonly wrapInProvider: boolean }): string {
  const providerImport = options.wrapInProvider
    ? `import { TrpcProvider } from "./shared/api/client.js";\n`
    : "";
  const tree = options.wrapInProvider
    ? `    <TrpcProvider>\n      <App />\n    </TrpcProvider>\n`
    : `    <App />\n`;
  const note = options.wrapInProvider
    ? ""
    : `// No service contract in this tree yet, so nothing wraps the app but StrictMode.\n` +
      `// The moment a *.contract.ts re-exports ServiceRouter, re-run the generator:\n` +
      `// it emits shared/api/client.tsx and wraps the tree in the provider here.\n`;
  return `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.js";
${providerImport}import "./app.css";

${note}const container = document.getElementById("root");
if (container === null) {
  // index.html is generated and carries the mount point; a missing #root means
  // something replaced it, and a silent no-render is the worst possible answer.
  throw new Error("index.html has no <div id=\\"root\\"> — the app has nowhere to mount");
}

createRoot(container).render(
  <StrictMode>
${tree}  </StrictMode>,
);
`;
}

/**
 * The ONE door to the network (TN-26-006).
 *
 * `client-one-door` (B2) refuses a runtime `@trpc/*` or `@tanstack/*` import
 * anywhere but under `src/ui/shared/api/`, for the same reason
 * `raw-framework-entry` gives the service runtime one door: a second transport
 * is a second place the URL, the batching, the headers and the error handling
 * can be got wrong, and they will be got wrong differently.
 *
 * It is a `.tsx`, not the `.ts` the plan named, because it exports a React
 * component and JSX does not parse in a `.ts` file — the same fact that gave
 * the scaffolder a `.tsx` mode in TN-26-006 A1. Splitting the provider into a
 * second file would have kept the extension and lost the one door.
 *
 * `routerSpecifier` points at the service's IMPLEMENTATION module, never at its
 * `*.contract.ts`: a contract's ambient declarations are a second identity for
 * everything they declare (ADR 2026-023), and the implementation module
 * re-exports every type its contract declares.
 */
export function clientTsx(routerSpecifier: string): string {
  return `import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink, type TRPCClient } from "@trpc/client";
import { createContext, useContext, type ReactElement, type ReactNode } from "react";
import type { ServiceRouter } from "${routerSpecifier}";

/** The typed client. Every procedure the service declares is reachable here,
 *  with its real input and output types — that is what the router type is for,
 *  and why a service contract must re-export it (router-type-reexported). */
export type ServiceClient = TRPCClient<ServiceRouter>;

/** \`/trpc\` is a same-origin path, proxied to the service by vite.config.ts in
 *  development and by whatever serves the built assets in production. The app
 *  never learns the service's real host. */
export const serviceClient: ServiceClient = createTRPCClient<ServiceRouter>({
  links: [httpBatchLink({ url: "/trpc" })],
});

/** One QueryClient for the whole app: the cache IS the shared read model, and
 *  a second one would silently split it in half. */
export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false } },
});

const ServiceClientContext = createContext<ServiceClient | undefined>(undefined);

/**
 * The client, from inside a component.
 *
 * Reading it from context rather than importing \`serviceClient\` directly is
 * what makes a component testable: a test renders it under a provider holding a
 * fake, and nothing in the component knows the difference.
 */
export function useServiceClient(): ServiceClient {
  const client = useContext(ServiceClientContext);
  if (client === undefined) {
    throw new Error("useServiceClient outside <TrpcProvider> — mount the provider at the app root");
  }
  return client;
}

export interface TrpcProviderProps {
  readonly children: ReactNode;
  /** A stand-in client, for tests. Production passes nothing. */
  readonly client?: ServiceClient;
}

export function TrpcProvider(props: TrpcProviderProps): ReactElement {
  return (
    <QueryClientProvider client={queryClient}>
      <ServiceClientContext.Provider value={props.client ?? serviceClient}>
        {props.children}
      </ServiceClientContext.Provider>
    </QueryClientProvider>
  );
}
`;
}

/**
 * The FSD layer directories, in import order — lower layers first.
 *
 * `widgets` is RESERVED, not emitted: the lints know the name and place it
 * between features and pages, so a project that grows composite blocks can add
 * the directory and be policed correctly from the first file. Emitting an empty
 * one would invite a layer nobody needs yet (TN-26-006).
 *
 * `processes` is dropped — FSD deprecated it itself.
 */
export const LAYER_NOTES: readonly { readonly dir: string; readonly note: string }[] = [
  {
    dir: "src/ui/shared/ui",
    note: "The generic component kit: dumb, domain-free, reusable. Pack-owned and generated — restyle through the tokens in app.css, never by editing a component here.",
  },
  {
    dir: "src/ui/entities",
    note: "The READ side (ADR 2026-030). One slice per domain entity: its display components and its query hooks. Each slice exposes a public API through its index; cross-slice imports target the index, never a file inside it.",
  },
  {
    dir: "src/ui/features",
    note: "The WRITE side (ADR 2026-030). One slice per user interaction: its form or action and its command hooks. May import entities and shared; never another feature's internals.",
  },
  {
    dir: "src/ui/pages",
    note: "Routes, composing features and entities into screens. The top layer: everything may be imported here, and nothing may import a page.",
  },
];
