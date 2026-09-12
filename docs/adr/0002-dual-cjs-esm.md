# 2. Dual CJS and ESM build with exports map

- Status: Accepted
- Date: 2026-09-12

## Context

The package shipped a single CommonJS build produced by `tsc` into `build/`,
exposed through `main` and `types` only. This left modern consumers without a
native ES module entry:

- ESM consumers loaded the CJS bundle through Node's interop layer, forfeiting
  named-export static analysis and tree-shaking.
- There was no `exports` map, so the package could not present distinct
  `import` and `require` conditions, nor guarantee correct type resolution for
  each.
- The library carries zero runtime dependencies; the build tooling must not
  change that.

## Decision

Build with [tsup](https://tsup.egoist.dev/) (esbuild-based) to emit both CJS and
ESM from a single `src/index.ts` entry, with generated type declarations.
`tsup.config.ts` sets `format: ['cjs', 'esm']`, `dts: true`, `sourcemap: true`,
`target: 'es2022'`, `clean: true`, and `outDir: 'dist'`. `express`, `redis`, and
`ioredis` are marked `external` so they are never bundled.

`package.json` points at the new artifacts and declares an `exports` map:

```json
"main": "./dist/index.js",
"module": "./dist/index.mjs",
"types": "./dist/index.d.ts",
"exports": {
  ".": {
    "import": { "types": "./dist/index.d.mts", "default": "./dist/index.mjs" },
    "require": { "types": "./dist/index.d.ts", "default": "./dist/index.js" }
  },
  "./package.json": "./package.json"
},
"files": ["dist"],
"sideEffects": false
```

The `build` script is now `tsup` and `clean` removes `dist`.

Rationale:

- One esbuild-backed config produces both module formats plus declarations,
  replacing a hand-managed dual `tsc` setup.
- tsup rewrites relative import specifiers with the correct extensions for the
  ESM output automatically, so native Node ESM resolution works without editing
  the extensionless imports in `src`.
- tsup is a dev dependency only; the shipped bundle keeps its zero *runtime*
  dependencies.

## Consequences

- Build output moves from `build/` to `dist/`; `.gitignore` ignores `dist` and
  the `files` allowlist publishes only `dist`.
- Consumers get correct types and code under both `import` and `require`: ESM via
  `index.mjs` / `index.d.mts`, CJS via `index.js` / `index.d.ts`.
- `sideEffects: false` lets bundlers tree-shake unused exports.
- The `express`, `redis`, and `ioredis` types stay external, preserving the
  no-runtime-dependency guarantee.

## Alternatives considered

- **Two `tsc` passes (one per module format).** Rejected: the extensionless
  relative imports in `src` would need rewriting to satisfy native Node ESM
  resolution, adding manual work that tsup handles automatically.
- **rollup or unbuild.** Rejected: heavier configuration for no gain on a
  library this small; tsup covers the dual-format-with-types case out of the box.
