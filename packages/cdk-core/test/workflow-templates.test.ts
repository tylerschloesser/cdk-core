/**
 * The four AWS-touching workflows and their templates under
 * `plugins/cdk-core/skills/new-site/templates/` are written together, in the
 * same epoch (Epoch 3), precisely so the templates cannot drift from the
 * proven workflows they came from: a template is a byte-for-byte copy of the
 * real `.github/workflows/*.yml` file with this repo's own values swapped for
 * placeholders, and this test proves the substitution round-trips exactly.
 * Epoch 5 wires the `new-site` skill around these templates; nothing here
 * depends on that skill existing yet.
 *
 * Placeholder values are substituted longest-first
 * (`@tylerschloesser/cdk-core` before `cdk-core.ty.ler.dev` before
 * `CdkCore`) purely for symmetry with how the templates themselves were
 * produced — a naive shortest-first or case-insensitive replacement could
 * have let `CdkCore` corrupt `cdk-core.ty.ler.dev`. The placeholder tokens
 * substituted here (`{{SITE_DOMAIN}}`, `{{STACK_PREFIX}}`,
 * `{{PACKAGE_NAME}}`) don't overlap as substrings, so order doesn't actually
 * change the result — but it's kept longest-first anyway so the test reads
 * the same way the templates were built.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const WORKFLOWS_DIR = `${REPO_ROOT}.github/workflows`
const TEMPLATES_DIR = `${REPO_ROOT}plugins/cdk-core/skills/new-site/templates`

const WORKFLOW_NAMES = ['deploy', 'pr-preview', 'pr-teardown', 'cleanup']

// Longest-first: a shorter placeholder's value must never be a substring
// match inside a longer one's.
const SUBSTITUTIONS: ReadonlyArray<readonly [string, string]> = [
  ['{{PACKAGE_NAME}}', '@tylerschloesser/cdk-core'],
  ['{{SITE_DOMAIN}}', 'cdk-core.ty.ler.dev'],
  ['{{STACK_PREFIX}}', 'CdkCore'],
]

function render(template: string): string {
  let result = template
  for (const [placeholder, value] of SUBSTITUTIONS) {
    result = result.split(placeholder).join(value)
  }
  return result
}

describe('workflow templates', () => {
  it('list the same four workflows as .github/workflows/', () => {
    // `.github/workflows/` also holds ci.yml, which is deliberately out of
    // scope here: it never touches AWS and so never gets a template. Every
    // workflow that does touch AWS requests `id-token: write` to assume the
    // deploy role, so that's what distinguishes "the AWS-touching workflow
    // set" from the directory listing as a whole — a fifth AWS workflow
    // added later, with the same permission, fails this test until a
    // template exists for it.
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
