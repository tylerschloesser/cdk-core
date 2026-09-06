## Context

I want to build a shared npm package published from this repo. It will be used primarily for sharing CDK constructs and Claude skill(s).

The first thing I want to build is a shared construct for a CloudFront website.

### 1 - Native support for PR previews

I want every github PR to automatically deploy a preview stack(s). Right now I have two separate websites that do this in broadly similar ways.

All websites are going to have the same patterns:

- Single-page vite app with index.html and static assets (JS, CSS, images). Mostly hashed and can be cached indefinitely.
- One or more backends that are based on path (e.g. /api).
- SSE.

I want each website I build to use a shared CDK construct we define here to spin up (as a separate stack - to decouple from prod) a dedicated CloudFront distro for PR preview environments. That CloudFront should have a wildcard cert (to simplify PR stacks) and leverage CloudFront Functions & KeyValueStore to route PR-branch requests (e.g. via a unique hostname). More details here: https://sst.dev/blog/frontends-are-hard/

The goal is to minimize the startup and teardown cost of PR stacks, and also reduce boilerplate as I spin up new websites. The goal is also for Claude to be able to write and post PRs and for me to test as e2e as possible.

Note this is not a single cloudfront for all websites. One preview cloudfront per website. This is an important design decision. I want the abstraction to be light, at the CDK construct level. I want each website to still be able to define its own logic in CloudFront. Though there would be limitations, as that would have to be done in a way that doesn't conflict with the preview functions.

The shared library should provide both constructs (prod + preview) because I ultimately want multiple stacks - and I want the stack knowledge to be at the website level, not the shared repo level.

Each website owns its own backend. The construct consumer will own telling the shared layer what APIs there are and how they're mapped (e.g. /api -> lambda). This should basically be the same API as the existing CDK cloudfront, but it will need to accommodate the PR preview branching via hostname. PRs will almost certainly need to be deployed through CDK for backend stuff (even though S3 deploy would be simple to do outside of CDK).

In general my websites will just have a single prod, plus PR previews. No other stacks/stages. Maybe some day I'll have a staging, but I don't need it right now because it's all for personal use.

Two things the plan must pin down explicitly rather than discover during implementation:

**Hostname and certificate scheme.** State it up front (e.g. `pr-123.preview.<site>`), because it constrains the CloudFront Function routing logic. A wildcard cert covers exactly one label, and CloudFront certs must live in us-east-1. Make sure the scheme you pick actually works with a single wildcard cert.

**SSE.** This is a hard requirement, not a nice-to-have. Address how streaming responses survive the CloudFront + origin path: Lambda invoke mode, cache/origin request policy, and buffering behavior. Prove it works in the reference implementation's e2e tests.

### 2 - PR endpoint registration

Something has to write and remove the hostname -> origin mapping in the KeyValueStore as PRs open and close. This is the crux of the design, so I want you to research the options and advise. My hunch is a small registration API, to keep the PR stacks decoupled from the shared preview stack. But it is safe to assume everything is in the same AWS account, so if a more direct approach is drastically simpler, I'm open to it.

Compare at least:

- **A registration API** - a small Lambda the PR stack calls on deploy/teardown. Decoupled, works cross-account, but it's another component to build, secure and maintain.
- **A CDK custom resource** in the PR stack writing KVS directly. No new service, and teardown comes free with CloudFormation delete. Trivial IAM in a single account.
- **A GitHub Action step** calling the AWS API after `cdk deploy`. Simplest, but teardown correctness depends on the workflow actually running, and it splits infra truth between CDK and CI.

Whatever you recommend, the plan must specifically address:

- the KVS update API's ETag / optimistic concurrency behavior when two PR deploys land at once
- what happens on teardown failure - a force-deleted branch, a cancelled workflow, a rolled-back stack
- an orphan sweeper, regardless of which mechanism wins

### 3 - Auth

These are all personal websites that I plan to use primarily myself, but may want to share with others. I want them protected in such a way that they're easy to share. To that end, I want Cognito & Google auth, via a shared construct.

Google auth serves two purposes: (1) protect my private websites, which will have API integrations via my personal keys, and (2) enable others to potentially use them later.

I want to keep coupling to a minimum, so I'm still thinking a separate Cognito pool per website. Research the cost implications. Note that Cognito user pool free tiers are per-pool, so the AWS cost of extra pools is likely near zero - the real overhead to evaluate is the per-site OAuth client configuration I have to do by hand in the Google Cloud console. Weigh that, and tell me whether per-site pools are worth it.

Two things collide with the PR preview design and must be solved in the plan:

**Shared auth callback.** Google requires exact OAuth redirect URIs - no wildcards. Cognito app client callback URLs are also exact, with a hard cap on how many can be listed. Per-PR hostnames therefore cannot each be registered. I need a shared callback host per site (e.g. `auth.<site>`) that receives the callback and returns the user to the correct PR hostname. Design this and account for it in the construct API. Research and compare at least:

- a **per-PR app client** within one pool per site - isolates token audience, shares the user directory, keeps a single Google OAuth registration
- Cognito groups or a custom claim to namespace PR users within one pool. I want to know whether I can namespace a single pool so PR users don't overlap - answer that properly, including what "overlap" actually means here: a shared user directory is a different problem from token audience (`aud`) validation, and the second is probably the isolation that actually matters
- a fixed shared callback host that bounces to the PR host via the OAuth `state` param

Whatever the bounce design, it must validate the return host against an allowlist. Do not build an open redirector.

**Machine auth for Claude.** Claude needs to hit PR endpoints and drive the PR preview UI end-to-end without a Google account. This is a first-class requirement, not an afterthought - without it, Claude can't verify its own work. Research and recommend, e.g.: a dedicated test user in the pool plus an app client with USER_PASSWORD_AUTH and credentials in Secrets Manager/SSM; a client-credentials app client with a resource server for API-only calls; or a preview-only signed bypass. Constraints:

- it must be structurally impossible in the prod stack - not merely disabled by config
- the plan must state how a machine-obtained token becomes a browser session Playwright can use (seeded cookie, localStorage, header), not just how to get a token

### 4 - Claude skills

I need to distribute Claude skills so Claude knows how to design for the shared preview feature - and so Claude knows it is able to create PRs and test against a shared preview e2e. That includes knowing how to authenticate against a preview using the machine auth path from section 3.

### 5 - Reference implementation

This repo should include a reference implementation. Let's use a pnpm monorepo so I can publish just the CDK constructs and keep the reference website separate. The website should be simple - a hello world vite webapp and a single ping/pong lambda API, plus whatever is needed to exercise SSE and auth. The reference implementation not only serves as a reference, but also lets us thoroughly test e2e. Claude should leverage playwright scripts to automate the e2e testing.

We have AWS access via the `admin` profile, and github access via the `gh` CLI (for testing PRs). Create whatever domains we need - nothing in this AWS account is super important (e.g. cdk-core.ty.ler.dev).

### 6 - Local dev

Local dev is an equal priority to PR previews. Local dev allows Claude to do most dev, testing & iteration quickly and locally. PR previews are a mechanism for me to verify what Claude has done e2e. I will also use local dev for local Claude sessions from time to time.

### 7 - Keep it extensible

Stuff like data storage is outside the scope of the shared construct(s). DNS is likely in scope. Keep the layer thin to minimize the need to change the shared construct as websites develop their own infra needs.

## Existing implementations to study

Both of these already implement PR previews, but they have diverged - don't assume they're the same:

- `/Users/tyler/repos/thai.ler.dev` - has a dedicated `infra/cdk/lib/preview-stack.ts` and a single `.github/workflows/preview.yml`
- `/Users/tyler/repos/yahn.ty.ler.dev` - has no separate preview stack (preview logic appears to live in `app-stack.ts`), and three workflows: `pr-preview.yml`, `pr-teardown.yml`, `cleanup.yml`

First deliverable: a comparison of both implementations, a recommendation on which shape to standardize on, and an explicit list of what each one does that the other doesn't - so we consciously carry capability forward instead of silently dropping it. `yahn.ty.ler.dev`'s `cleanup.yml` in particular looks like an orphan sweeper; I want that pattern kept.

## Open questions the plan must resolve

Record each of these in a decisions log in plan.md, with the answer and the reasoning:

1. **CloudFront Function origin selection.** Confirm the *current* capability of CloudFront Functions to select or override the request origin, versus needing Lambda@Edge. This single fact determines the routing design, latency and cost profile. Verify against current AWS docs - do not rely on recalled knowledge.
2. **KeyValueStore limits.** Max store size, key and value size, keys per store, update rate, and the ETag concurrency model. Does anything here bound how many PRs I can have open at once?
3. **Registration mechanism** - section 2.
4. **Cognito namespacing and the shared callback** - section 3.
5. **Machine auth path** - section 3.
6. **Package registry.** GitHub Packages under my scope vs. just publishing public on npmjs. For a solo dev, public npm avoids auth config in every consumer repo and every CI job. Compare briefly and pick one.
7. **Session strategy** - see below.

## Deliverable: plan.md

Develop a detailed plan.md locally (or a series of plans, if that's what the session-strategy research recommends). Requirements:

**Self-contained.** A fresh Claude session reading only plan.md, plus whatever progress log you design, must be able to execute the next epoch correctly. No implicit reliance on the conversation that produced it.

**The construct API comes before any implementation.** plan.md must contain a draft TypeScript interface for both constructs - props, defaults, and escape hatches. Everything else derives from this, and I want to be able to review the abstraction in five minutes rather than five sessions.

**Split into epochs** that separate Claude sessions can execute serially, to avoid context overflow and degradation. For each epoch: goal, deliverables, acceptance test, files touched, and what to do if blocked.

**Acceptance criteria, per epoch and overall.** Without testable exit conditions, session 4 has no way to know whether session 3 actually succeeded. Propose concrete targets and I'll adjust - something in the shape of:

- PR preview deploys in under N minutes from push
- teardown leaves zero billable resources, verified by a sweeper
- onboarding a new website costs under ~50 lines of CDK in the consumer repo
- `pnpm dev` gives a working local site + API in under 10 seconds
- Claude can take a PR from open to verified-in-preview with no human step

**Cost guardrails.** Leaked PR stacks are the most likely way this design costs me real money. Every epoch that creates AWS resources needs a teardown story.

**Delegation plan.** The planning session is Fable/Opus, orchestrator sessions are Opus, and grunt work should go to Sonnet subagents. Be concrete about the split rather than "delegate as much as possible" - subagents don't share context, so anything handed off has to be self-contained with explicit file paths. My starting assumption, adjust if you disagree:

- Sonnet: test writing, scaffolding, doc updates, log triage, mechanical refactors, and read-heavy exploration where only the conclusion comes back
- Opus orchestrator: CDK design decisions, cross-cutting changes, anything requiring judgment about the construct API

## Session strategy - research this properly

This will be a large plan. I expect to get it well-defined enough that Claude can do everything, just not in a single context session. So: research how to execute long multi-session work without overloading or degrading context, and recommend a concrete mechanism this repo will actually use.

Specifically, I want to know how a session should finish an epoch - write a local summary of what happened and what deviated from the plan, update the original plan where things had to stray - and then begin the next epoch in a fresh session.

Start from what Claude Code already provides and justify any custom tooling against that baseline: slash commands in `.claude/commands/`, subagents, hooks, headless `claude -p`, CLAUDE.md, plan mode, and whatever else is current. There are likely established patterns for this - find them. Only propose a custom harness if you can name a specific thing the built-in primitives can't do.

Bootstrapping constraint: the mechanism has to be usable by the very next session. Don't design something that requires this session to also build a whole harness before any real work can start.

Deliverable: a written recommendation, plus the actual mechanism committed to this repo.

If the mechanism turns out to be good and generalizable, I may want it as a skill or harness I can share. That may increase the scope of this repo (named cdk-core right now), or it may belong in a separate repo. Note the recommendation; don't decide it now.

## Misc

I'm a solo dev. Everything is optimized for solo dev. Single AWS account. Personal github. The ultimate goal is to allow me to solo dev webapps fast with heavy Claude assistance. I will spend most of my time creating prompts, and I expect Claude to be able to iterate over long sessions via automation and e.g. isolated stacks.

**Future goal, explicitly not part of this plan:** I want `thai.ler.dev` and `yahn.ty.ler.dev` to eventually migrate onto cdk-core. Don't plan or execute that migration here, but let it inform the construct API - the API should be capable of expressing what those two sites already do.
