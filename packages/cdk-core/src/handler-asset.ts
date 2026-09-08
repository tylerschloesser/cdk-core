/**
 * Where the pre-bundled custom-resource handler lives inside the package.
 *
 * Shipped built so a consumer's stack needs no bundler and no `node_modules`
 * at deploy time. `dist/handler-asset.js` sits next to `dist/handlers/`, so
 * this resolves identically from a workspace link and from an installed
 * tarball. Two constructs use `previewResourcesAssetPath` — `PreviewSite`
 * (the machine `PoolUser`) and `PreviewDeployment` (the `KvsRoute`) — which is
 * why it is not a private function on either of them. `authEndpointAssetPath`
 * is the third: the Lambda behind the `/auth/*` behavior.
 */

import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

export function previewResourcesAssetPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))

  // Loaded from `src/` rather than `dist/`, which only ever happens in a
  // vitest run: nothing else imports this package by relative path (see
  // `.claude/rules/typescript-config.md`). The bundle it would otherwise point
  // at is a build artifact, and a unit test may not require a build — so a
  // synth-only caller gets a real directory to hash and no more. Keyed on the
  // directory name rather than on "does the bundle exist", so a *deploy* from
  // an unbuilt `dist/` still fails loudly with `CannotFindAsset` instead of
  // quietly shipping the wrong files.
  if (path.basename(here) === 'src') return path.join(here, 'handlers')

  return path.join(here, 'handlers', 'preview-resources')
}

/**
 * Same reasoning as `previewResourcesAssetPath`, for the `/auth/*` Lambda.
 *
 * In the vitest branch both functions resolve to the same `src/handlers`
 * directory — there is only one `src/` to point at — so a `Template.fromStack`
 * assertion cannot tell the two Lambdas' assets apart by asset hash in that
 * mode. Harmless (nothing here asserts on asset identity) but surprising if
 * you go looking for why two `Code.fromAsset` calls hash the same.
 */
export function authEndpointAssetPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))

  if (path.basename(here) === 'src') return path.join(here, 'handlers')

  return path.join(here, 'handlers', 'auth-endpoint')
}
