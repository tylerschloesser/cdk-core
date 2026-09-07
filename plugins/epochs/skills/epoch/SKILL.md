---
name: epoch
description: Start executing one epoch of plan.md in this session. Loads the plan's Status block, the progress log, and the epoch's own section, then runs it under the repo's delegation and verification rules. Use as `/epoch <n>` at the start of a fresh session.
argument-hint: <epoch-number>
disable-model-invocation: true
---

You are the orchestrator for **Epoch $0** of `plan.md`. This session exists to execute that
one epoch and hand off cleanly. Do not start the next epoch.

## What is already true

Plan status (the top of `plan.md`, corrected in place after every epoch):

!`awk '/^> ## Status/{p=1} p&&/^## /&&!/^> /{exit} p' plan.md`

Progress log entries so far (`progress.md`, newest last):

!`test -f progress.md && tail -n 120 progress.md || echo "(no progress.md yet)"`

Git state:

!`git status --short --branch | head -20 && git log --oneline -8`

## The epoch you are executing

!`awk '/^### Epoch $0 /{p=1; print; next} p && (/^### Epoch / || /^## /){exit} p' plan.md`

If the block above is empty, Epoch $0 does not exist in `plan.md`; say so and stop.

## Rules for this session

1. **Read `plan.md` in full before touching a file** — at minimum the Status block, the
   Decisions log, whatever section the plan says everything else derives from, and this
   epoch's section. Decisions in the plan are
   settled. Anything marked `[revised]` was corrected against a measurement and is the
   *most* settled part. If you disagree, implement as written and record the disagreement
   in your handoff.
2. **If the repo has `.claude/rules/*.md` files, read every one whose `paths` cover what
   this epoch touches** before planning, not after your first file read.
3. **Check the previous epoch's exit before building on it.** Run its acceptance test
   (listed in its plan section) or the fastest proxy for it. A prior epoch that reports
   done but fails its own check is a blocker to record, not something to silently repair.
4. **If the plan has a Delegation plan and the repo defines `implementer`/`verifier` agents
   (`.claude/agents/`), delegate per that plan**: those agents for chunks that carry a
   one-line acceptance check; keep design, the judgment calls on any interface other repos
   depend on, every interaction with live infrastructure, and every measurement for
   yourself. Verify a subagent's confident claim before building on it.
5. **If this epoch touches live infrastructure, read the repo's own conventions for
   credentials and regions from `CLAUDE.md` or its rules before the first call.** Never
   delete or destroy a named resource you have not just read back from a listing; treat any
   account or environment this repo shares with other projects as shared, not yours alone.
6. **Every resource this epoch creates needs its teardown proven** before the epoch is
   called done (see the plan's Cost guardrails section, if it has one).
7. **A change that invalidates a claim in `plan.md`, `CLAUDE.md` or a rule file fixes it in
   the same commit.** A false claim is worse than a missing one.
8. Commit as you go, one commit per coherent chunk, on a branch named `epoch-$0-<slug>`
   unless the epoch section says otherwise.
9. **Finish by running `/handoff`.** It writes the progress entry, corrects the plan, and
   commits. Do not end the session without it, and do not write the handoff by hand.

Start now: confirm the prior epoch's exit, then plan this epoch as chunks with acceptance
checks, then execute.
