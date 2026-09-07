---
paths:
  - "plugins/**"
  - ".claude-plugin/**"
  - ".claude/settings.json"
  - ".claude/skills/**"
  - ".claude/agents/**"
---

# The plugin, its skills, and the templates they ship

Loaded when you touch the marketplace, the plugin, a skill or the templates. The workflow
templates specifically are also `.claude/rules/workflows.md`; publishing the npm package is
`.claude/rules/typescript-config.md`.

## Shape

```
.claude-plugin/marketplace.json          marketplace `tylerschloesser`, two plugins
plugins/cdk-core/.claude-plugin/plugin.json
plugins/cdk-core/agents/{implementer,verifier}.md
plugins/cdk-core/skills/{preview,preview-auth,new-site}/SKILL.md
plugins/cdk-core/skills/new-site/templates/  app.ts  cdk.json  infra-package.json  workflows/
plugins/epochs/.claude-plugin/plugin.json
plugins/epochs/skills/{epoch,handoff}/SKILL.md
```

`.claude/skills/{epoch,handoff}` are the session mechanism this repo actually runs: they carry
this repo's AWS specifics (profile, region, the account's other tenants). `plugins/epochs`
ships generalized copies of the same two skills for other repos to install. The two are
deliberately not byte copies, for the same reason the agent copies under `plugins/cdk-core`
are not (see finding 4 below). `.claude/settings.json` enables both plugins from this repo's
own checkout (`"source": {"source": "directory", "path": "."}`), so the repo dogfoods them; a
consumer uses `{"source": "github", "repo": "tylerschloesser/cdk-core"}`. `enabledPlugins` keys
are `cdk-core@tylerschloesser` and `epochs@tylerschloesser` — `plugin@marketplace`.

Validate every manifest before committing:

```
claude plugin validate ./plugins/cdk-core
claude plugin validate ./plugins/epochs
claude plugin validate ./.claude-plugin/marketplace.json
```

Note that `claude plugin validate <dir>` on a directory with **no** manifest validates the
loose components and passes. A green result is only a statement about the manifest if the
output line says `Validating plugin manifest:`.

## The things that bit

1. **The skills appear one session late.** The first session started after
   `extraKnownMarketplaces` lands registers the marketplace; the *next* one exposes the
   plugin's skills. Measured twice, in both the absolute-path and relative-`"."` directory
   forms. `claude plugin marketplace list` tells you which half you are in. Do not debug a
   manifest over this — start a second session.
2. **`infra/bin/app.ts` is generated from `templates/app.ts`.** `test/workflow-templates.test.ts`
   renders the template with this repo's values and asserts **byte** equality, the same guard
   the four workflow templates have. Editing either alone goes red. The substitution table
   lives in that test; regenerate with the same table rather than hand-editing the template.
   A useful side effect: a lost `infra/bin/app.ts` can be restored from its own template.
3. **A skill that states something false is worse than a missing skill**, because a later
   session acts on it. Every command a skill names gets run, or checked against the tool's
   `--help`, before it is committed — that is what `plan.md`'s Delegation line means by
   "verifier checks every command in a skill actually runs". Two false claims were caught this
   way in Epoch 5 and one shipped for a few minutes.
4. **The plugin's agent copies are deliberately not byte copies** of `.claude/agents/`. Two
   sentences are generalized: reading `.claude/rules/` is conditional on the repo having them,
   and "no semicolons, single quotes" became "match the surrounding style". A plugin that
   asserts this repo's conventions is stating something false about a consumer's.
5. **A template directory can hold more than templates.** `workflow-templates.test.ts` pairs
   `.github/workflows/` against `templates/workflows/` with a `.yml` filter, so `app.ts`,
   `cdk.json` and `infra-package.json` alongside it are invisible to it. Deliberate; adding a
   fifth AWS-touching workflow still fails the test until its template exists.

## Skill voice

Short declarative sentences, no emoji, no marketing, no "simply"/"just". A real command beats a
description of one. Site-specific values are `<domain>` / `<Prefix>` / `<n>`; one concrete
example using this repo is fine. Numbers are measurements with their source, never promises —
`preview`'s timings all trace to `plan.md`'s Status block. Aim for 100-190 lines; a skill nobody
reads to the end is worse than a short one.

**Say when *not* to ask.** A skill that only lists dangers teaches a model to stop and ask about
everything, which in a `-p` session means it stops dead — that is exactly how the first A5 run
failed. `preview` names the actions that are routine (opening a PR, deploying a preview: they
are self-cleaning and IAM-scoped) *and* the ones that are not (deleting a stack, deploying
production, publishing, force-pushing, the prod user pool). Both halves are load-bearing.
