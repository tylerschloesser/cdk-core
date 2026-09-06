## Context

I want to build a shared npm package published to my personal github npm registry - if that's possible.
This package will be used primarily for sharing CDK constructs and Claude skill(s).

The first thing I want to build is a shared construct for a CloudFront website.

1 - Native support for PR previews

I want every github PR to automatically deploy a preview stack(s). Right now I have two separate websites that do this basically the same way.
All websites are going to have the same patterns:

Single-page vite app with index.html and static assets (JS, CSS, images). Mostly hashed and can be cached indefinitely.
One or more backends that are based on path (e.g. /api).
SSE.

I want each website I built to use a shared CDK construct we define here to spin up (as a separate stack - do decouple from prod) a dedicated CloudFront distro for PR preview environments.
That CloudFront should have a wildcard cert (to simplify PR stacks) and leverage CloudFront functions & keyvaluestore to route PR-branch requests (e.g. via a unique hostname). More details here: https://sst.dev/blog/frontends-are-hard/

The goal is to minimize the startup and teardown cost of PR stacks, and also reduce boilerplate as I spin up new websites. The goal is also for Claude to be able to write and post PRs and me to test as e2e as possible.

Note this is not a single cloudfront for all websites. One preview cloudfront per website. This is an important design decision. I want the abstraction to be light, at the CDK construct level. I want each website to still be able to define it's own logic in CloudFront. Though there would be limitations as that would have to be done in a way that doesn't conflict with the preview functions.

The shared library should basically provide both constructs because I ultimately want multiple stacks - and I want the stack knowledge to be at the website level, not the shared repo level.

You can find my existing websites that both implement PR previews (mostly the same way, I hope) here:

/Users/tyler/repos/thai.ler.dev
/Users/tyler/repos/yahn.ty.ler.dev

Note that each website owns it's own backend. The construct consumer will own telling the shared layer what APIs there are and how their mapped (e.g. /api -> lambda). This should basically be the same API as the existing CDK cloudfront, but it will need to accommodate the pr preview branching via hostname. We may want a lightweight service that each PR branch uses to register and deregister new PR endpoints. Note that PRs will almost certainly need to be deployed through CDK for backend stuff (even though S3 deploy would be simple to do outside of CDK).

Note that in general my websites will just have a single prod, as well as PR previews. No other stacks/stages. Maybe some day I'll have a staging, but don't need it right now because it's all for personal use.

2 - Auth

These are all personal websites that I plan to use primarily myself, but may want to share with others. I want them protected in such a way that they're easy to share. To that end, I want Cognito & google auth. I believe I should be able to do that via a shared construct.

I want to keep the coupling to a minimum, though. So I'm still thinking a separate cognito per website. Research the cost impliciations of that and whether it's too much overhead w.r.t my own personal google setup needed.

To clarify - google auth serves two purposes. 1 protect my private website that will have API integrations via my personal key and 2 enable others to potentially use it later.

3 - Claude skills

I need to distribute Claude skills so claude knows how to design for the shared preview feature - and so that claude knows that it is able to create PRs and test against a shared preview e2e.

4 - Reference implementation

This repo should include a reference implementation. Let's use a pnpm monorepo so I can publish just the cdk constructs, and keep the reference website separate. Website should be simple - just a hello world vite webapp and a single ping/pong lambda API. The reference implementation not only serves as a reference, but also allows us to thoroughly test e2e. Claude should leverage playwright scripts to automate the e2e testing. We have aws access via the "admin" profile, as well as github access via gh CLI (for testing PRs). Create whatever domains we need - nothing in this AWS account is super important. (e.g. cdk-core.ty.ler.dev)

5 - Also need local dev

Local dev is a equal priority to PR previews. Local dev allows claude to do most dev, testing & iteration quickly and locally. PR previews are a mechanism for me to verify what claude has done e2e. I will also use local dev for local claude sessions from time-to-time.

6 - Keep it extensible

Note that stuff like data storage is outside of the scope of the shared construct(s). DNS is likely in scope. Keep the layer thin to minimize the need to change the shared construct as websites develop their own infra needs.

## Goal

Goal is to develop a detailed plan.md locally
The plan should be split into epochs that separate claude sessions can execute serially to avoid context overflow/degredation
Research a solution for Claude to automatically finish and epoch, document a local summary of what happened, what deviated from the plan. Update the original plan as needed (if things needed to stray), and begin a new epoch with a fresh session. There are likely patterns for this. This will be a large plan but I will likely get it well-defined enough that claude can do everything, just not in a single context session.

Claude should also plan to farm out as much work to cheaper/faster sonnet sub-agents as possible. The planning session will be Fable/Opus. The orchestrator sessions will be Opus, and the grunt-work should be sonnet.

If we can come up with a good way to do that Claude looping - I may want that as a skill or harness or however I can share it. May increase the scope of this git repo (name is cdk-core right now). Or may put that in a separate repo. Or maybe it's already a tool I can use. Do some research.

## Misc.

I'm a solo dev. Everything is optimized for solo dev. Single AWS account. Personal github. The ultimate goal is to allow me to solo dev webapps fast with heavy claude assistance. I will spend most of my time creating prompts, and I expect claude to be able to iterate over long sessions via automation and e.g. isolated stacks.
