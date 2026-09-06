# cdk-core

Shared CDK constructs (`@tylerschloesser/cdk-core`), a Claude Code plugin of skills, and a
reference site (`cdk-core.ty.ler.dev`) that dogfoods PR previews on this repo. **`plan.md` is
the spec** — its Status block says what exists today; `docs/prior-art.md` says where the
patterns came from. This file holds only what must stay true.

## Working in epochs

Work here happens one epoch per session. Start a session with `/epoch <n>` and end it with
`/handoff`; both are skills in `.claude/skills/`. The next session reads only `plan.md`,
`progress.md`, this file, `.claude/rules/`, and git — nothing from your conversation
survives, so anything the next session must know goes in those files before you stop.

- Decisions in `plan.md` are settled; `[revised]` marks ones corrected by measurement, and
  those are the *most* settled. Disagree in the handoff, not in the code.
- A change that invalidates a claim in `plan.md`, this file, or a rule fixes it **in the same
  commit**. A false claim is worse than a missing one: the next session will "fix" working code.
- Three samples are not a measurement. Interleave, randomize order, report median and range.

## Always true

- **AWS**: account `063257577013`, profile `admin` (SSO, no default region — pass
  `--region us-east-1` and set `env` explicitly in CDK). The account hosts three other
  production sites. **Never `delete-stack` or `destroy` a name you have not just read back
  from `aws cloudformation list-stacks`**, and never one that is not `CdkCore-pr-<n>` unless
  the epoch section says so. The GitHub OIDC provider already exists: import, never create.
- **Every PR-numbered stack you create is deleted before you stop**, unless `progress.md`
  records why it is alive. Until `cdk-core sweep` is implemented (Epoch 3) the check is
  `aws cloudformation list-stacks` for `CdkCore-pr-*`, `cloudfront-keyvaluestore list-keys` on
  the KVS, and `aws s3 ls` on the preview bucket's `pr-<n>/` prefix — plus
  `scripts/verify-preview.sh <n> --expect-absent`, which asserts all of it from the outside.
- **`pnpm verify`, `pnpm dev` and `pnpm e2e` never touch AWS or need credentials.** That
  property is what lets a session verify its own work before opening a PR. Keep it. `verify`
  is lint + typecheck + unit tests + build; `e2e` is the browser suite and is deliberately
  *not* inside it (`pnpm --filter e2e exec playwright install chromium` once per clone).
- **The GitHub repo is public.** Nothing secret goes in a tracked file — and the account id
  and zone ids already in this file and `plan.md` are world-readable, so do not add more
  account detail without asking.
- Delegate per `plan.md` → Delegation plan: `implementer`/`verifier` (`.claude/agents/`, both
  sonnet) for chunks with a one-line acceptance check; the orchestrator does every AWS
  interaction, every measurement, and anything touching the Construct API.
- Dependency versions live in the `catalog:` block of `pnpm-workspace.yaml`; manifests say
  `"catalog:"`. `erasableSyntaxOnly` + `verbatimModuleSyntax`: no `enum`, no constructor
  parameter properties, `import type`. No formatter; no semicolons; single quotes.
- Rule files in `.claude/rules/` load when you read matching paths; read the relevant one
  **before** planning, not after your first file read. Keep this file under 100 lines and
  each rule under about 120.
