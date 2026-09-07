/**
 * Two kinds of template live under `plugins/cdk-core/skills/new-site/templates/`,
 * and both are proven the same way: a template is a byte-for-byte copy of a
 * real file in this repo with this repo's own values swapped for
 * placeholders, and this test proves the substitution round-trips exactly.
 *
 * The four AWS-touching workflows (`templates/workflows/*.yml`) are written
 * together with the real `.github/workflows/*.yml` they came from, in the
 * same epoch (Epoch 3), precisely so the templates cannot drift. Epoch 5
 * added `templates/app.ts`, produced the same way from `infra/bin/app.ts`,
 * and reuses the same `render()` helper and the same guarantee. Epoch 5
 * wires the `new-site` skill around these templates; nothing here depends on
 * that skill existing yet.
 *
 * Placeholder values are substituted longest-first
 * (`@tylerschloesser/cdk-core` before `cdk-core.ty.ler.dev` before
 * `CdkCore`, and similarly for `app.ts`'s own table) purely for symmetry with
 * how the templates themselves were produced — a naive shortest-first or
 * case-insensitive replacement could have let `CdkCore` corrupt
 * `cdk-core.ty.ler.dev`. None of the placeholder tokens substituted here
 * (workflow or `app.ts`) overlap as substrings of one another's *values*, so
 * order doesn't actually change the result — but it's kept longest-first
 * anyway so the test reads the same way the templates were built.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const WORKFLOWS_DIR = `${REPO_ROOT}.github/workflows`
const TEMPLATES_DIR = `${REPO_ROOT}plugins/cdk-core/skills/new-site/templates/workflows`
const APP_TS_TEMPLATE = `${REPO_ROOT}plugins/cdk-core/skills/new-site/templates/app.ts`
const APP_TS_REAL = `${REPO_ROOT}infra/bin/app.ts`

const WORKFLOW_NAMES = ['deploy', 'pr-preview', 'pr-teardown', 'cleanup', 'publish']

// Longest-first: a shorter placeholder's value must never be a substring
// match inside a longer one's.
const SUBSTITUTIONS: ReadonlyArray<readonly [string, string]> = [
  ['{{PACKAGE_NAME}}', '@tylerschloesser/cdk-core'],
  ['{{SITE_DOMAIN}}', 'cdk-core.ty.ler.dev'],
  ['{{STACK_PREFIX}}', 'CdkCore'],
]

// `app.ts`'s own table — one entry per placeholder that appears in
// `templates/app.ts`, with this repo's real value. Also longest-first, for
// the same symmetry-with-how-it-was-built reason as `SUBSTITUTIONS` above.
const APP_TS_SUBSTITUTIONS: ReadonlyArray<readonly [string, string]> = [
  ['{{PACKAGE_NAME}}', '@tylerschloesser/cdk-core'],
  ['{{PREVIEW_AUTH_PREFIX}}', 'cdk-core-preview'],
  ['{{ROLE_NAME}}', 'cdk-core-github-deploy'],
  ['{{SITE_DOMAIN}}', 'cdk-core.ty.ler.dev'],
  ['{{REPO_OWNER_ID}}', '2300885'],
  ['{{STACK_PREFIX}}', 'CdkCore'],
  ['{{AUTH_PREFIX}}', 'cdk-core'],
  ['{{ZONE_NAME}}', 'ty.ler.dev'],
  ['{{ACCOUNT_ID}}', '063257577013'],
  ['{{REPO_ID}}', '1359473287'],
  ['{{ZONE_ID}}', 'Z038502736IM0QLQT7VFN'],
  ['{{REGION}}', 'us-east-1'],
  ['{{REPO}}', 'tylerschloesser/cdk-core'],
]

function render(template: string, substitutions: ReadonlyArray<readonly [string, string]> = SUBSTITUTIONS): string {
  let result = template
  for (const [placeholder, value] of substitutions) {
    result = result.split(placeholder).join(value)
  }
  return result
}

describe('workflow templates', () => {
  it('list the same workflows as .github/workflows/', () => {
    // `.github/workflows/` also holds ci.yml, which is deliberately out of
    // scope here: it never authenticates to anything by OIDC and so never
    // gets a template. `id-token: write` is what distinguishes "the
    // OIDC-authenticating workflow set" from the directory listing as a
    // whole — most of these workflows request it to assume the AWS deploy
    // role, but `publish.yml` requests the same permission for npm's
    // trusted-publishing OIDC exchange and touches no AWS at all. A new
    // workflow added later with either kind of OIDC use fails this test
    // until a template exists for it.
    const workflowFiles = readdirSync(WORKFLOWS_DIR)
      .filter((name) => name.endsWith('.yml'))
      .filter((name) => readFileSync(`${WORKFLOWS_DIR}/${name}`, 'utf8').includes('id-token: write'))
      .map((name) => name.replace(/\.yml$/, ''))
      .sort()

    const templateFiles = readdirSync(TEMPLATES_DIR)
      .filter((name) => name.endsWith('.yml'))
      .map((name) => name.replace(/\.yml$/, ''))
      .sort()

    expect(templateFiles).toEqual(workflowFiles)
    expect(templateFiles).toEqual([...WORKFLOW_NAMES].sort())
  })

  for (const name of WORKFLOW_NAMES) {
    it(`${name}.yml: template substituted matches the real workflow byte-for-byte`, () => {
      const template = readFileSync(`${TEMPLATES_DIR}/${name}.yml`, 'utf8')
      const workflow = readFileSync(`${WORKFLOWS_DIR}/${name}.yml`, 'utf8')

      const rendered = render(template)

      // Not a shape/regex match — the whole point is that the template can
      // never silently drift from the workflow it was copied from.
      expect(rendered).toBe(workflow)
    })

    it(`${name}.yml: no unsubstituted placeholder remains after substitution`, () => {
      const template = readFileSync(`${TEMPLATES_DIR}/${name}.yml`, 'utf8')
      const rendered = render(template)

      // Matches our own {{ALL_CAPS}} placeholder shape, not a GitHub Actions
      // `${{ expression }}`, which always has a space after `{{`.
      expect(rendered).not.toMatch(/\{\{[A-Z_]+\}\}/)
    })
  }
})

describe('app.ts template', () => {
  it('no placeholder token is a substring of another — the claim substitution order rests on', () => {
    const tokens = APP_TS_SUBSTITUTIONS.map(([placeholder]) => placeholder)
    for (const a of tokens) {
      for (const b of tokens) {
        if (a === b) continue
        expect(b.includes(a)).toBe(false)
      }
    }
  })

  it('template substituted matches infra/bin/app.ts byte-for-byte', () => {
    const template = readFileSync(APP_TS_TEMPLATE, 'utf8')
    const real = readFileSync(APP_TS_REAL, 'utf8')

    const rendered = render(template, APP_TS_SUBSTITUTIONS)

    // Not a shape/regex match — the whole point is that the template can
    // never silently drift from the app it was copied from.
    expect(rendered).toBe(real)
  })

  it('no unsubstituted placeholder remains after substitution', () => {
    const template = readFileSync(APP_TS_TEMPLATE, 'utf8')
    const rendered = render(template, APP_TS_SUBSTITUTIONS)

    // Matches our own {{ALL_CAPS}} placeholder shape, not a TypeScript
    // template literal `${{ ... }}`, which does not occur in this file.
    expect(rendered).not.toMatch(/\{\{[A-Z_]+\}\}/)
  })
})
