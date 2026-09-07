---
name: handoff
description: Close out the current epoch so a fresh session can start the next one. Runs the epoch's acceptance test, appends a progress.md entry, corrects plan.md in place (Status block and [revised] markers), updates rules, and commits. Use at the end of every /epoch session, or when stopping mid-epoch.
argument-hint: [blocked]
---

You are finishing an epoch of `plan.md`. The next session will read only `plan.md`,
`progress.md`, `CLAUDE.md`, `.claude/rules/` and git; nothing in this conversation survives.
Everything the next session must know has to land in those files now.

Current state:

!`git status --short --branch | head -30`

!`awk '/^> ## Status/{p=1} p&&/^## /&&!/^> /{exit} p' plan.md`

Do these in order. Do not skip one because it seems obvious.

1. **Run the epoch's acceptance test** exactly as written in its `plan.md` section, and
   record the real result. If it fails or cannot be run, the epoch is not done: say so
   plainly in the progress entry and the Status block. Never soften a FAIL into a "mostly".
2. **Append an entry to `progress.md`** (create it if missing) with this exact heading
   form so the next `/epoch` can find it:

   ```
   ## Epoch <n> — <title> — <YYYY-MM-DD> — <DONE | PARTIAL | BLOCKED>
   ```

   Body, in this order, each a short section:
   - **Shipped**: what exists now, with `file:line` or resource names, and the commit
     range.
   - **Acceptance test**: the command(s) run and the verbatim result line(s).
   - **Deviations from the plan**: every place reality differed, with the reason. If a
     measurement overturned a plan claim, give the numbers.
   - **Left undone / untested**: anything committed but unverified, and why.
   - **Live resources after this epoch**: names and the command that proves teardown
     works, or "none".
   - **What the next epoch needs to know**: traps, one-time human actions still owed,
     anything the plan text does not say. This is the section the next session reads
     first.
3. **Correct `plan.md` in place**:
   - Rewrite the `> ## Status — <date>` block at the top: which epochs are done, what is
     live, and a numbered list of every `[revised]` change with a one-line reason.
   - In the sections the deviations touch (Decisions log, Construct API, Architecture,
     the epoch section itself, later epochs whose assumptions changed), edit the text and
     mark each edit `[revised]` with the reason. Do not leave a claim the code now
     contradicts; do not delete history, correct it.
   - If this epoch's scope changed, update its Deliverables/Acceptance test so they match
     what was actually proven.
4. **Update `CLAUDE.md` and, if the repo has them, `.claude/rules/*.md`**: anything that
   cost a debugging session and is not obvious from the code goes in the matching rule
   (create one, with a `paths` frontmatter, if none fits). Retire claims the code now
   makes obvious. Keep `CLAUDE.md` under 100 lines.
5. **Commit** everything with a message starting `Epoch <n> handoff:` followed by a one-line
   summary. If on an epoch branch, push it and open or update the PR; say in the entry
   whether it is merged. A handoff is not done until it is committed.
6. **Print the next step** as the very last line of your reply, in one of these forms:
   - `Next: start a fresh session and run /epoch <n+1>`
   - `Next: <the one human action owed>, then /epoch <n+1>`
   - `Next: /epoch <n> again — BLOCKED on <reason>` (if `$ARGUMENTS` is `blocked` or the
     acceptance test failed)
