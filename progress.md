# Progress log

One entry per epoch (or per stop), newest last. Heading format is fixed — `/epoch` tails it:

`## Epoch <n> — <title> — <YYYY-MM-DD> — <DONE | PARTIAL | BLOCKED>`

## Epoch 0 — Plan and session mechanism — 2026-09-06 — DONE

**Shipped.** `plan.md` (decisions D1–D11, construct API, Epochs 1–6, acceptance criteria,
cost guardrails, delegation plan, session mechanism), `docs/prior-art.md` (thai vs yahn),
`docs/research/{cloudfront-kvs-sse,cognito-google-auth,claude-code-primitives}.md` (cited
research, 2026-09-06), `CLAUDE.md`, `.claude/skills/{epoch,handoff}`,
`.claude/agents/{implementer,verifier}`, `.claude/settings.json`, `.gitignore`, `README.md`.

**Acceptance test.** In a fresh session, `/epoch 1` prints the Status block, this entry, and
the Epoch 1 section. (Checked by running the skill's `awk` extraction by hand; see below.)

**Deviations from the plan.** None — this is the plan. Two things the prompt assumed that
research overturned, recorded in `plan.md`: Google's redirect-URI exact match is not the
constraint on per-PR callbacks (Google only sees the Cognito pool domain; Cognito's own
callback list is), and CloudFront Functions have had origin selection since 2024-11 so
Lambda@Edge is not needed.

**Left undone / untested.** The `/epoch` skill's `` !`awk` `` extraction was verified from a
shell, not from inside a Claude session. Whether `claude -p "/epoch n"` works headlessly is
unverified and optional.

**AWS resources alive after this epoch.** None. No GitHub repo yet either (Epoch 1 creates it).

**What the next epoch needs to know.**
- Read `plan.md` → Construct API before scaffolding `packages/cdk-core`; the `exports` map
  and prop names are the contract every later epoch builds on.
- The reference app deliberately has *two* backends (`api` buffered, `events` streaming) so
  the multi-backend path is exercised from day one.
- `thai.ler.dev` and `yahn.ty.ler.dev` on this machine are the style reference (pnpm catalog,
  oxlint config, tsconfig base, Playwright config). Copy conventions, not code.
- The npm name is `@tylerschloesser/cdk-core`; nothing is published until Epoch 5.
