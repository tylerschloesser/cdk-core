---
paths:
  - "tsconfig*.json"
  - "packages/**"
  - "apps/**"
  - "pnpm-workspace.yaml"
  - "package.json"
---

# TypeScript, the workspace, and how the package is consumed

Loaded when you touch a manifest, a tsconfig, or anything in `packages/` or `apps/`.

## Versions live in one place

Every dependency version is in the `catalog:` block of `pnpm-workspace.yaml`; every manifest
says `"catalog:"`. Adding a dependency means adding a catalog entry *and* the `"catalog:"`
reference — a literal version in a manifest is a bug, not a shortcut.

TypeScript is pinned to `~6.0`, not 7. `verbatimModuleSyntax` and `erasableSyntaxOnly` are on
in `tsconfig.base.json`, so: **no `enum`, no constructor parameter properties, no `namespace`,
no `import =`**, and every type-only import says `import type`. No formatter, no semicolons,
single quotes.

## `packages/cdk-core` is consumed as `dist/`, not as source

This is the one place cdk-core diverges from `thai.ler.dev`, whose workspace packages are
imported as TypeScript source through their `exports` map. It cannot work that way here,
because this package is published to npm (Epoch 5) and its `exports` map is the contract a
consumer outside this repo resolves. Consequences, all of them load-bearing:

- Internal relative imports inside `packages/cdk-core/src` carry **`.js`** specifiers
  (`from '../config.js'`), because the emitted JS is what runs. `.ts` specifiers fail the
  build under `nodenext` without `allowImportingTsExtensions`, which an emitting project
  cannot set.
- `apps/*` import it by **package specifier** (`@tylerschloesser/cdk-core/auth/server`), never
  by a relative path into `src/`. A relative import would bypass the exports map and silently
  test something the published package does not expose.
- `apps/*/tsconfig.json` carry a **project reference** to `../../packages/cdk-core`, so
  `tsc -b` builds it first. `packages/cdk-core/tsconfig.json` is therefore `composite` with
  `declaration`, `rootDir: src`, `outDir: dist`.
- Anything that runs the app needs `dist/` to exist. That is why root `dev` is
  `pnpm --filter @tylerschloesser/cdk-core run build && pnpm -r --parallel run dev`: one
  deterministic build, then `tsc -b --watch` alongside the servers.
- **The package has a `prepare` script, so `pnpm install` builds it.** That is not a
  convenience: pnpm creates the `cdk-core` bin link for `infra` only if `dist/bin/sweep.js`
  already exists when the install runs, and in a fresh clone it does not. Without `prepare`,
  `pnpm exec cdk-core sweep` in `cleanup.yml` fails with `Command "cdk-core" not found`, and
  re-running `pnpm install` afterwards does **not** repair it — pnpm short-circuits with
  "Already up to date" and relinks nothing, `--force` included. The cost is that a type error
  in this package now fails `pnpm install`, not just `pnpm verify`.
  `apps/web/dist` is still not built by any of this, so `pnpm build` before a `cdk` command
  remains required (`.claude/rules/cdk.md`).

## The exports map

Three entries, and the split is not cosmetic:

| Subpath | Environment | Why it is separate |
| --- | --- | --- |
| `.` | synth time (Node + `aws-cdk-lib`) | the constructs |
| `./auth/browser` | DOM | so a web bundle never pulls in `aws-cdk-lib` |
| `./auth/server` | Node | so a Lambda never pulls in DOM-only code |

`auth/server` types Hono's context **structurally** (`RequestLike`) rather than importing
`hono`, so the package has no runtime dependency on a consumer's web framework or its major
version. `aws-cdk-lib` and `constructs` are optional peer dependencies for the same reason: a
consumer that only wants `auth/browser` should not have to install CDK.

## Adding a package to the workspace

`pnpm-workspace.yaml` globs are `apps/*`, `e2e`, `infra`, `packages/*`. A new package needs:
its own `tsconfig.json` extending `../../tsconfig.base.json`, a `typecheck` script that is
`tsc -b`, an entry in the root `tsconfig.json` `references`, and — if it consumes cdk-core — a
project reference to it. `pnpm -r run <script>` skips packages that do not define the script,
so a package with no `test` or `dev` needs no placeholder.
