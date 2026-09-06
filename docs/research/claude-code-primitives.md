# Multi-Session Engineering Plans with Claude Code: Official Documentation Research

**Date:** September 6, 2026  
**Sources:** code.claude.com official documentation (latest)  
**Scenario:** Solo developer executing a large plan split into epochs; each epoch runs in a fresh session to avoid context overflow. Sessions hand off via progress logs and updated plan.md files.

---

## 1. Slash Commands vs. Skills: Current Mechanism

### Official Definition (Skills Documentation)

**Skills are the modern pattern.** They replace the earlier `.claude/commands/` approach. All `.claude/commands/*.md` files are now treated as **skills**, not separate command files.

**Storage:**
- Personal: `~/.claude/skills/<skill-name>/SKILL.md` (all projects)
- Project: `.claude/skills/<skill-name>/SKILL.md` (this project only)
- Plugin: `<plugin>/skills/<skill-name>/SKILL.md`

**Frontmatter Fields (YAML):**
```yaml
name: my-skill              # Display name
description: What it does   # When Claude should invoke it; keywords matter
disable-model-invocation: true  # Only user invokes, not Claude
user-invocable: false       # Only Claude can invoke (hidden from /)
allowed-tools: Bash(git *) Read  # Pre-approve tools
disallowed-tools: AskUserQuestion
context: fork               # Run in isolated subagent context
agent: Explore|Plan|general-purpose  # Which subagent type
background: true/false      # Run forked skill in background
model: claude-opus-4-1      # Override session model
effort: high|xhigh|max      # Effort level override
shell: bash|powershell      # Shell for injected commands
arguments: [arg1, arg2]     # Named positional arguments
argument-hint: [filename] [format]
paths: ["*.ts", "src/**/*.py"]  # Glob: activate only when Claude reads these files
```

**Critical Distinction:**
- `disable-model-invocation: true` = user-invocation only (e.g., for side effects like deploying or committing)
- `user-invocable: false` = Claude-only; hidden from `/` menu (background reference)
- Default = both Claude and user can invoke

### String Substitution

```
$ARGUMENTS       # All args as one string
$0, $1, $2       # Positional args
$ARGUMENTS[N]    # Same as above
$name            # Named argument from frontmatter
${CLAUDE_SESSION_ID}
${CLAUDE_EFFORT}
${CLAUDE_SKILL_DIR}
${CLAUDE_PROJECT_DIR}
${CLAUDE_PLUGIN_ROOT}
```

### Dynamic Context Injection

Backtick syntax injects shell output into skill content **before Claude sees it**:

```markdown
# Current Status
!`git status`

# Multi-line variant
```!
node --version
npm list --depth=0
git status
```

Failure (exit non-zero) = entire skill invocation aborts. Claude never sees content.

**For the Multi-Session Plan Pattern:**
- Use `disable-model-invocation: true` for skills that manage epoch transitions (write progress logs, update plan.md, commit)
- Use `context: fork` with `background: false` for reading past progress and extracting next-epoch instructions
- Never use `context: fork` + `background: true` in a coordinating skill—the main session must wait for results

---

## 2. Subagents: Definition and Model Control

### Official Definition (Sub-Agents Documentation)

Subagents are independent agents running in **separate context windows** with:
- Custom system prompts
- Restricted tool access (you control)
- Independent permissions
- Optionally different model

**Storage:**
- Project: `.claude/agents/<name>.md` (this project)
- User: `~/.claude/agents/<name>.md` (all projects)
- Managed: Admins' managed settings
- CLI: `--agents <json>` flag

**Frontmatter:**
```yaml
name: code-reviewer              # Unique identifier (lowercase, hyphens)
description: Analyzes code      # When Claude should delegate
tools: Read, Glob, Grep          # Allowlist
disallowedTools: []
model: sonnet|opus|haiku|fable|inherit|<full-id>  # Model choice
permissionMode: default|acceptEdits|auto|dontAsk|bypassPermissions|plan
maxTurns: 10                     # Max agentic turns
skills: [skill-name]             # Preload skills
mcpServers: []                   # MCP servers available
hooks: {}                        # Lifecycle hooks
memory: user|project|local       # Persistent memory
background: true/false           # Keep in background
effort: low|medium|high|xhigh|max
isolation: worktree              # Git worktree isolation
```

### Model Resolution (Strict Order)

1. Per-invocation `model` parameter in prompt
2. Subagent definition's `model` field (use `inherit` for parent's model)
3. `CLAUDE_CODE_SUBAGENT_MODEL` environment variable
4. Main conversation's model
5. Fall back to `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` if set (force all subagents to one model)

**For Multi-Session Pattern:** Model is **not** inherited across sessions; each epoch session must specify it independently. Recommendation: Set Opus for orchestrator (main) sessions, Sonnet for worker subagents via subagent definition.

### Context Sharing: What Subagents Receive vs. Don't

**At startup, subagents receive:**
- System prompt (custom + environment details)
- Task message (delegation prompt from Claude)
- CLAUDE.md files (all hierarchy levels; NOT for Explore/Plan agents)
- Git status (NOT for Explore/Plan agents)
- Preloaded skills (from `skills` field)
- Sibling roster (other named agents, for messaging)

**They DON'T receive:**
- Your conversation history
- Output style settings
- Auto memory from main conversation
- Skills already invoked

**Exception:** Forks inherit entire parent conversation instead of starting fresh.

### Parallelism and Nesting

**Background vs. Foreground:**
- Interactive sessions: subagents run in background by default (fork mode on)
- `-p` sessions: subagents wait in foreground

**Spawning Subagents (Nesting):**
- Subagents can spawn up to depth 3 (default) below main
- Control: `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=2`
- Concurrent limit: 20 default, adjust with `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=50`
- Block spawning: omit `Agent` from `tools` or add to `disallowedTools`

**For Multi-Session Pattern:** Use subagents within each epoch session, not across sessions. Cross-session coordination uses file handoff (progress logs, plan updates, git commits).

---

## 3. CLAUDE.md and Memory System

### CLAUDE.md Loading Hierarchy

**Load order (broadest to most specific):**
1. Managed policy: `/Library/Application Support/ClaudeCode/CLAUDE.md` (macOS) or `/etc/claude-code/CLAUDE.md` (Linux) or `C:\Program Files\ClaudeCode\CLAUDE.md` (Windows)
2. User: `~/.claude/CLAUDE.md`
3. Project root: `./CLAUDE.md` or `./.claude/CLAUDE.md`
4. Local (gitignored): `./CLAUDE.local.md`
5. Subdirectory files (lazy-loaded when Claude reads files in that directory)

**Files in parent directories load before child directories** (root down to working directory, then CLAUDE.local.md appended at each level).

### Import Syntax

Within any CLAUDE.md, use `@path/to/file` to import and expand another file:
```markdown
See @README for overview and @docs/architecture.md for patterns.

# Additional Rules
@.claude/rules/testing.md
```
- Relative paths resolve relative to the file containing the import
- Max recursion depth: 4 hops
- Wrapped in backticks (`` `@README` ``) = literal mention, not import

### Path-Scoped Rules (`.claude/rules/`)

Place `.md` files in `.claude/rules/` to organize instructions by topic:
```
.claude/
├── CLAUDE.md              # Main project instructions
└── rules/
    ├── testing.md         # Loaded always
    ├── api-design.md      # Loaded always
    └── frontend/
        └── react.md       # Lazy-loaded when Claude reads .tsx/.jsx
```

Rules with `paths` frontmatter load on-demand:
```yaml
---
paths:
  - "src/api/**/*.ts"
  - "lib/**/*.ts"
---

# API Development Rules
- All endpoints must include validation
```

Glob patterns: `**/*.ts`, `src/**/*`, `*.md`, `{src,lib}/**/*.{ts,tsx}`

### Auto Memory

Claude automatically writes four types to `~/.claude/projects/<project>/memory/MEMORY.md`:
- `user`: your role and preferences
- `feedback`: corrections and confirmed approaches
- `project`: ongoing decisions, deadlines
- `reference`: external resources

**Size limits:** First 200 lines or 25 KB of `MEMORY.md` load at session start. Topic files (`user_role.md`, etc.) load on-demand only.

**Auto memory is per-project-repo:** All worktrees and subdirectories share one memory directory.

**Disable:** `autoMemoryEnabled: false` in settings or `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`

### For Multi-Session Pattern

Create `.claude/CLAUDE.md` with:
1. How to read the epoch plan and progress log:
   ```markdown
   ## Epoch Execution Pattern
   Each session executes one epoch from PLAN.md.
   - Before starting work, read PROGRESS.md for context from prior epochs
   - At epoch end, write PROGRESS.md entry (what happened, deviations)
   - Update PLAN.md if reality diverged from the plan
   ```

2. Location of orchestration/handoff files:
   ```markdown
   ## Handoff Files
   - PLAN.md: Master plan split into epochs
   - PROGRESS.md: Log of what each epoch accomplished
   - Committed at each epoch boundary
   ```

Auto memory will capture which parts of the plan were completed, so resumed sessions pick up context naturally.

---

## 4. Hooks: Events, Blocking, and Context Injection

### Complete Hook Events List

**Session Lifecycle:**
- `SessionStart`: Session begins or resumes → can inject context
- `SessionEnd`: Session terminates
- `Setup`: One-time init with `--init-only`, `--init`, or `--maintenance`

**Per-Turn:**
- `UserPromptSubmit`: Before Claude processes prompt
- `UserPromptExpansion`: When slash command expands (can block)
- `Stop`: When Claude finishes responding → **can block continuation**
- `StopFailure`: Turn ends on API error

**Tool Execution:**
- `PreToolUse`: Before tool call runs (can block)
- `PostToolUse`: After tool succeeds
- `PostToolUseFailure`: After tool fails
- `PostToolBatch`: After parallel tool calls resolve
- `PermissionRequest`: Tool needs permission
- `PermissionDenied`: Auto mode denied tool

**Other:**
- `Notification`, `MessageDisplay`, `ConfigChange`, `FileChanged`, `CwdChanged`
- `InstructionsLoaded`: CLAUDE.md loaded
- `WorktreeCreate`, `WorktreeRemove`
- `PreCompact`, `PostCompact`
- `PreModelSwitch`, `PostModelSwitch`
- `SubagentStart`, `SubagentStop`
- `TeammateIdle`, `TaskCreated`, `TaskCompleted`
- `Elicitation`, `ElicitationResult`

### Hook Input/Output Schema

**Common Input (All Events):**
```json
{
  "session_id": "string",
  "prompt_id": "UUID",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/current/working/directory",
  "permission_mode": "default|plan|acceptEdits|auto|dontAsk|bypassPermissions",
  "effort": { "level": "low|medium|high|xhigh|max" },
  "hook_event_name": "EventName",
  "agent_id": "string (subagent only)",
  "agent_type": "string (subagent only)"
}
```

**Tool Event Input (PreToolUse, PostToolUse, etc.):**
```json
{
  "tool_name": "Bash",
  "tool_input": {
    "command": "npm test",
    "timeout": 120000
  },
  "tool_use_id": "toolu_...",
  // ... plus common fields
}
```

**Hook Output:**
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse|Stop|SessionStart|...",
    "permissionDecision": "allow|deny|block",
    "permissionDecisionReason": "string",
    "additionalContext": "string (SessionStart) or context for Claude",
    "updatedInput": { /* modified tool input */ },
    "systemMessage": "string shown to Claude",
    "terminalSequence": "escape sequences"
  }
}
```

### Stop Hook: Blocking Stopping

Exit with **code 2** to **block** the stop and force another turn:

```bash
#!/bin/bash
# Check if tests pass before allowing stop
if ! npm test > /dev/null 2>&1; then
  jq -n '{
    hookSpecificOutput: {
      hookEventName: "Stop",
      permissionDecision: "block",
      permissionDecisionReason: "Tests failed. Fix failures before stopping."
    }
  }'
  exit 2
fi
exit 0
```

**Configuration:**
```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/validate-before-stop.sh"
          }
        ]
      }
    ]
  }
}
```

Claude Code will **not allow stopping** until the hook exits 0.

### SessionStart: Context Injection

The `SessionStart` hook fires when a session begins or resumes and can inject additional context:

```json
{
  "session_id": "abc123",
  "hook_event_name": "SessionStart",
  "cwd": "/project",
  "startup_type": "startup|resume|clear|compact|fork",
  "model": "claude-opus-5"
}
```

**Hook Output:**
```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "Project status: Build passing, 42 tests passing, no open blockers",
    "systemMessage": "Loaded context from CI"
  }
}
```

The `additionalContext` is added to Claude's initial understanding; `systemMessage` is shown in UI.

### Exit Code Behavior

| Exit Code | Behavior |
|-----------|----------|
| **0** | Success; JSON parsed if present; stdout added as context for some events |
| **2** | Blocking error; prevents action (PreToolUse, UserPromptSubmit, Stop, etc.) |
| **Other** | Non-blocking error; action proceeds unless JSON output provides decision |

### For Multi-Session Pattern

**Use Stop hook to enforce epoch checkpoint:**
```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash -c 'if [ -f EPOCH_CHECKPOINT_REQUIRED ]; then echo \"Epoch checkpoint required before stopping\"; exit 2; fi; exit 0'"
          }
        ]
      }
    ]
  }
}
```

A skill can create the `EPOCH_CHECKPOINT_REQUIRED` file, the Stop hook blocks stopping, Claude is forced to complete the checkpoint (write progress log, commit), then deletes the file and next stop succeeds.

---

## 5. Headless Mode (claude -p) and Epoch Orchestration

### CLI Flags for -p

```bash
claude -p "your prompt" \
  --continue                        # Continue most recent session
  --resume <session-id|name>        # Continue specific session
  --output-format text|json|stream-json
  --max-turns 10                    # Stop after N turns
  --allowedTools "Bash,Read,Edit"   # Pre-approve tools
  --permission-mode auto|dontAsk|plan|bypassPermissions
  --dangerously-skip-permissions    # Skip all permission prompts
  --model claude-opus-5             # Override model
  --append-system-prompt "..."      # Add to system prompt
  --session-id <id>                 # Create with specific ID
  --agents <json>                   # Define custom agents
  --bare                            # Skip hooks, skills, MCP discovery
  --mcp-config <file|json>          # MCP servers
  --output-format json | jq '.result'  # Parse structured output
```

### Example: Multi-Turn Orchestration Loop

```bash
#!/bin/bash
# Pseudo-code for running epochs sequentially

PLAN_FILE="PLAN.md"
PROGRESS_FILE="PROGRESS.md"

# Read which epochs are complete
COMPLETED=$(grep "✓ Epoch" "$PROGRESS_FILE" | wc -l)
NEXT_EPOCH=$((COMPLETED + 1))

# Extract epoch N prompt from plan
EPOCH_PROMPT=$(sed -n "/^## Epoch $NEXT_EPOCH/,/^## Epoch/p" "$PLAN_FILE" | head -n -1)

# Run epoch in headless mode, fresh session
claude -p "Execute Epoch $NEXT_EPOCH:

$EPOCH_PROMPT

At the end, write PROGRESS.md entry, update PLAN.md if reality diverged, and commit." \
  --output-format json \
  --permission-mode auto \
  --max-turns 50 \
  --model claude-opus-5 \
  | jq '.result'

# Track completion in script (parse .result, check for success)
```

### Key Patterns

1. **Fresh session per epoch:** Don't use `--continue` between epochs; let context reset
2. **Pass epoch context in prompt:** Include relevant section of PLAN.md in the prompt
3. **Instruct checkpoint at end:** "Before stopping, write progress log, update PLAN.md, commit"
4. **Structured output:** `--output-format json` for parsing success/failure
5. **Dry run first:** Run on a subset of PLAN.md to validate orchestration
6. **No bare mode for orchestration:** You want hooks (Stop hook enforces checkpoints), skills, and CLAUDE.md context

---

## 6. Plan Mode

### What Plan Mode Is

**Plan mode** (`--permission-mode plan`) puts Claude in **read-only exploration** before edits:

- Claude reads files and writes a plan
- No file writes, no commands execute
- You review and approve the plan (edit with Ctrl+G)
- Only then does Claude switch to implementation and edit/execute

### Usage

```bash
claude --permission-mode plan
```

**In interactive mode:** Press `Shift+Tab` repeatedly until status bar shows `⏸ plan mode on`.

**Flow:**
1. Claude explores and proposes a plan
2. You press Ctrl+G to edit it in $EDITOR
3. You save and close
4. Claude implements according to the approved plan

### Relation to Hand-Written Plan.md

Plan mode is **not** a replacement for a hand-written plan.md.

- **Plan mode:** Claude's per-session planning within one conversation
- **PLAN.md:** Your master multi-epoch plan that orchestrates many sessions

In a multi-session workflow, you write PLAN.md (epochs, milestones), and Claude optionally uses plan mode within each session to verify its approach before executing that epoch.

---

## 7. Context Management: CompactPreCompact Hook, and Long-Task Guidance

### Commands

```bash
/compact [instructions]         # Replace history with summary
/clear                          # Start fresh; saves old conversation
/context                        # Show what's consuming context
/btw "question"                 # Ask without adding to context
```

### Auto-Compaction

Claude Code automatically compacts when approaching context limits (default ~80% full). The `PreCompact` hook fires before compaction and can modify what gets kept:

```json
{
  "hooks": {
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "echo 'Preserve file edits and test results, drop exploratory reads'"
          }
        ]
      }
    ]
  }
}
```

### What Survives Compaction

**Kept:**
- Project-root CLAUDE.md (re-read from disk)
- Preloaded skills (from `skills` field)
- Recent code edits and command outputs
- Key decisions and summary
- Up to 5 recently read files

**Lost (unless pinned):**
- Full conversation history (replaced with summary)
- Nested CLAUDE.md files (unless in active directory)
- Path-scoped rules (unless matching current file)

### Official Guidance: Long-Running Tasks

From **Best Practices** documentation:

**Recommended patterns:**
1. **Provide verification criteria** ("run tests after each change, report pass/fail")
2. **Explore first, plan, then code** (use plan mode to separate phases)
3. **Provide specific context** (reference exact files, patterns)
4. **Use `@` file references** to include context without parsing
5. **Use subagents for investigation** (keep research out of main context)
6. **Course-correct early** (press Esc to stop mid-action, rewind with `/rewind`)
7. **/clear between unrelated tasks** (don't mix unrelated work in one session)
8. **Use `/goal` for continuous work** (set condition, Claude loops until met)
9. **Use hooks for deterministic rules** (e.g., "run linter before every commit")

**From the documentation:**
> "Claude Code automatically compacts conversation history when you approach context limits, which preserves important code and decisions while freeing space... During long sessions, Claude's context window can fill with irrelevant conversation, file contents, and commands. This can reduce performance and sometimes distract Claude. Use `/clear` frequently between tasks to reset the context window entirely."

---

## 8. Worktrees and Parallel Sessions

### Basic Pattern

```bash
claude --worktree feature-auth          # Session 1
claude --worktree bug-fix               # Session 2 (different terminal)
```

Each gets:
- Isolated git worktree under `.claude/worktrees/<name>/`
- Own branch: `worktree-<name>`
- Separate transcript
- File isolation enforced (can't edit main checkout)

### Configuration

**Base branch selection:**
```json
{
  "worktree": {
    "baseRef": "fresh"  # Branch from default (main)
    // OR
    "baseRef": "head"   # Branch from current HEAD
  }
}
```

**Copy gitignored files into worktrees:**
```
# .worktreeinclude
.env
.env.local
config/secrets.json
```

### Cleanup

- **Interactive sessions:** Claude prompts on exit; clean sessions auto-remove
- **Non-interactive (-p):** Worktrees stay on disk; manually `git worktree remove`

### For Multi-Session Pattern

**Worktrees don't directly solve the epoch problem** (context per session), but they do enable **parallel epoch sessions** if you need two developers or two independent experiments running simultaneously. Subagents within a session are the better fit for epoch coordination.

---

## 9. Scheduled Tasks and Autonomous Loops

### `/loop` Command

**Three modes:**

1. **Fixed interval + prompt:**
   ```
   /loop 5m check if the deployment finished
   ```

2. **Dynamic interval (Claude chooses):**
   ```
   /loop check if the deployment finished
   ```
   Claude picks 1m–1h based on observation.

3. **Built-in maintenance (no prompt):**
   ```
   /loop
   ```
   Claude tends to unfinished work, PR comments, CI failures.

**Key:** `/loop` is **session-scoped**; dies when session ends. Resuming with `--resume` restores unexpired tasks (7-day TTL).

### Cloud Routines

For work that should run independent of your machine, use:
```bash
claude /schedule <cron> <prompt>
```

Stored in cloud, runs with Anthropic-managed sandbox. No local files access.

### Comparison Table

| Feature | Cloud Routine | Desktop Task | `/loop` |
|---------|---|---|---|
| Runs on | Cloud | Your machine | Your machine |
| Requires session | No | No | Yes (session-scoped) |
| Access to local files | No (fresh clone) | Yes | Yes |
| Persistent across restart | Yes | Yes | No (7 day TTL) |
| Minimum interval | 1 hour | 1 minute | 1 minute |

**For multi-session orchestration:** `/loop` is **not** the right tool. Use shell script wrapping `claude -p` calls, or use the `/schedule` cloud routine to trigger orchestrator sessions at regular intervals.

---

## 10. Established Community Patterns

### Official Documented Patterns

#### Pattern 1: Writer/Reviewer (Two Sessions with Cross-Session Messaging)

From **Best Practices** documentation:

```
Session A (Writer):
  "Implement a rate limiter for our API endpoints"

Session B (Reviewer):
  "Review the rate limiter implementation in @src/middleware/rateLimiter.ts.
   Look for edge cases, race conditions, and consistency with our existing patterns."

Back to Session A:
  "Here's the review feedback: [Session B output]. Address these issues."
```

**Mechanism:** Use `SendMessage` tool (requires cross-session messaging enabled, v2.1.224+). Reviewer runs in fresh context, avoids biasing toward code it just wrote.

#### Pattern 2: Dynamic Workflows (Multi-Subagent Orchestration)

From **Workflows** documentation:

Workflows are for tasks **too big to coordinate in one turn**:
- Codebase-wide audits (fan out one agent per directory)
- Large migrations (50+ files, each in own context)
- Cross-checked research (multiple investigators debate findings)

```
ultracode: audit every API endpoint under src/routes/ for missing auth checks
```

Or explicitly:
```
use a workflow to migrate every component from JavaScript to TypeScript
```

Scripts run in background; report at end. Cost scales linearly with agent count.

#### Pattern 3: Batching Across Files

From **Best Practices:**

For large fan-outs over many files:
```bash
for file in $(cat files.txt); do
  claude -p "Migrate $file from Python 2 to Python 3" \
    --allowedTools "Edit,Bash(git commit *)"
done
```

Each invocation is a fresh session. No context accumulation. Parallelizable with GNU parallel or xargs -P.

#### Pattern 4: Goal-Driven Loops (No Human Between Turns)

From **Goal** documentation:

```
/goal all tests in test/auth pass and lint step is clean
```

Claude automatically loops, running checks after each turn. Stops when condition met or judged impossible.

**Use for:** Single-session continuous work toward a measurable end state (not multi-session orchestration).

### What the Docs Don't Show

**No official pattern for multi-session hand-off orchestration.** The documentation assumes either:
1. Single session working to completion
2. Multiple sessions run in **parallel** (worktrees, agent teams, workflows) with **no handoff**
3. Cloud routines on a schedule (no context between runs)

**The multi-session **sequential** handoff pattern (Epoch A → Progress log → Epoch B) is a custom composition.**

---

## Recommended Minimal Mechanism: Built-In Primitives Only

Based on the documentation, here is a mechanism for multi-session epoch orchestration using only Claude Code built-ins:

### Architecture

**Files:**
- `PLAN.md`: Hand-written master plan split into epochs (e.g., "## Epoch 1: Setup", "## Epoch 2: Auth")
- `PROGRESS.md`: Append-only log (gitignored or committed)
- `.claude/CLAUDE.md`: Instructions on epoch pattern
- Shell script or CI job: Loop runner

**Skills in `.claude/skills/`:**
1. `run-epoch.md` (`disable-model-invocation: true`): Reads next epoch from PLAN.md, passes to Claude
2. `record-progress.md` (`disable-model-invocation: true`): Appends to PROGRESS.md, updates PLAN.md, commits
3. `epoch-handoff.md` (`disable-model-invocation: false`): Runs at SessionStart via hook; reads PROGRESS.md and next epoch from PLAN.md, injects context

**Hooks in `.claude/settings.json`:**
- `SessionStart`: Runs `epoch-handoff` skill to inject progress and next epoch context
- `Stop`: Blocks stopping if epoch checkpoint not written; message instructs Claude to run `/record-progress` skill

**Orchestration:**
```bash
#!/bin/bash
# Multi-epoch orchestrator
for epoch in $(seq 1 5); do
  claude -p "/run-epoch $epoch" \
    --model claude-opus-5 \
    --permission-mode auto \
    --max-turns 100
done
```

### How It Works

1. **Session starts (new or resumed):** `SessionStart` hook runs `epoch-handoff` skill
   - Skill reads PROGRESS.md and extracts status
   - Injects last session's summary and current epoch objectives into Claude's context
   
2. **Claude works on epoch:** Reads PLAN.md section, implements, tests, etc.

3. **Claude tries to stop:** `Stop` hook fires
   - Hook checks if `PROGRESS.md` was updated and files committed
   - If not, blocks with exit code 2
   - Claude is forced to continue, receives error message instructing it to run `/record-progress`
   
4. **Claude runs `/record-progress` skill:**
   - Appends to PROGRESS.md: what happened, deviations from plan
   - Updates PLAN.md if reality diverged
   - Commits with message including epoch number and summary
   - Deletes `EPOCH_CHECKPOINT_REQUIRED` file
   
5. **Stop succeeds:** Session ends, progress persisted in git

6. **Next session starts:** Loop reruns `claude -p`, SessionStart hook reads PROGRESS.md, context is restored

### Key Built-Ins Used

| Feature | Used For | Reason |
|---------|----------|--------|
| **Skills** (`disable-model-invocation: true`) | Orchestration steps (read plan, write progress) | Deterministic, user-controlled, no Claude ambiguity |
| **Hooks** (`SessionStart`, `Stop`) | Context injection and enforcement | Runs before/after every turn; Stop hook blocks stopping |
| **CLAUDE.md** | Document the pattern for Claude and teams | Persistent across sessions |
| **`claude -p` (headless)** | Loop from shell script | Fresh session per epoch, structured control |
| **Git commits** | Persistence and rollback | Standard checkpoint mechanism |
| **Subagents** (optional) | Work within each epoch | Use if one epoch needs parallel investigation |

### What Can't Be Done with Built-Ins Alone

1. **Automated hand-off between independently running long processes**
   - Each session must be invoked explicitly (shell loop, CI job, or cron)
   - No automatic "when Session A finishes, start Session B" without external orchestrator

2. **Two-way bidirectional communication between running sessions**
   - Cross-session messaging requires Manual configuration and Setup
   - Works best for **parallel** sessions (worktrees), not **sequential** handoffs
   - Would need background sessions + channel + event system

3. **Resuming partial epochs**
   - If a session dies mid-epoch, re-running the same `claude -p` command starts a fresh session (not resume)
   - You must decide when to `--resume` (pick up mid-epoch) vs. restart (fresh epoch)
   - The Stop hook can't distinguish "intentional stop" from "crash"

### When to Build a Custom Harness

Build custom orchestration (harness, daemon, or service) if you need:
- **Real-time bidirectional feedback** between active epoch sessions (not just file handoff)
- **Automatic session spawning** (e.g., "when one finishes, start next, detect progress without human loop invocation")
- **State machine / workflow engine** with rollback, error recovery, human approval gates
- **Multi-developer coordination** (agents spawned by different developers need to see each other's state in real time)
- **Adaptive pacing** (epochs that take longer get more tokens/time; dynamic rerouting if blocked)

None of these are needed for a **solo developer with a static plan**. The built-in primitives (skills, hooks, CLAUDE.md, git, shell loop) are sufficient.

---

## Conclusion: Recommended Pattern for Solo Developer

For a solo developer executing a large hand-written multi-epoch plan without context degradation:

### Setup (One Time)

1. **Write `PLAN.md`:**
   ```markdown
   # Development Plan
   
   ## Epoch 1: Foundation
   - [ ] Set up auth module
   - [ ] Create test harness
   
   ## Epoch 2: Core Features
   - [ ] Implement rate limiter
   - [ ] Add monitoring
   ```

2. **Create `.claude/CLAUDE.md`:**
   ```markdown
   ## Epoch Execution
   Each session handles one epoch.
   Read PROGRESS.md before starting.
   At epoch end: write PROGRESS.md, update PLAN.md, commit.
   
   ## Handoff Files
   - PLAN.md: Master plan
   - PROGRESS.md: Session logs
   ```

3. **Create `.claude/skills/record-progress.md`:**
   ```markdown
   ---
   name: record-progress
   description: Record what this epoch accomplished
   disable-model-invocation: true
   ---
   
   ## Record Progress
   
   1. Append to PROGRESS.md:
      - What was planned
      - What actually happened
      - Blockers or deviations
   
   2. Update PLAN.md:
      - Check off completed items
      - Note changes to future epochs
   
   3. Commit:
      \`\`\`bash
      git add PLAN.md PROGRESS.md
      git commit -m "Epoch N complete: [summary]"
      \`\`\`
   ```

4. **Add Stop hook to `.claude/settings.json`:**
   ```json
   {
     "hooks": {
       "Stop": [
         {
           "hooks": [
             {
               "type": "command",
               "command": "bash -c 'if git status PROGRESS.md --short | grep -q M; then exit 0; else echo \"Write progress log before stopping\"; exit 2; fi'"
             }
           ]
         }
       ]
     }
   }
   ```

5. **Create orchestration shell script `run-epochs.sh`:**
   ```bash
   #!/bin/bash
   PLAN="PLAN.md"
   EPOCHS=$(grep -c "^## Epoch" "$PLAN")
   
   for i in $(seq 1 $EPOCHS); do
     SECTION=$(sed -n "/^## Epoch $i/,/^## Epoch/p" "$PLAN" | head -n -1)
     
     echo "=== Epoch $i ==="
     claude -p "Execute Epoch $i:
   
   $SECTION
   
   When done, run /record-progress." \
       --model claude-opus-5 \
       --permission-mode auto \
       --max-turns 100 || exit 1
     
     echo "✓ Epoch $i complete"
   done
   ```

### Per-Epoch Workflow

```bash
./run-epochs.sh   # Orchestrator shell loop
# Or manually:
claude -p "Execute Epoch 1: [content from PLAN.md]" --model claude-opus-5
# Claude works, then must run /record-progress before stopping
```

### What You Get

- ✓ **No context degradation:** Fresh session per epoch
- ✓ **Progress tracking:** PROGRESS.md shows what worked, what didn't
- ✓ **Resumability:** If a session crashes, `--resume <session-id>` continues mid-epoch
- ✓ **Auditability:** Git commit per epoch, PLAN.md tracks actual vs. planned
- ✓ **Adaptive:** If an epoch takes longer, adjust PLAN.md for next one
- ✓ **Built-ins only:** No custom harness, no external services

---

## Summary: Official Documentation vs. Practice

**Official Claude Code documentation (v2.1+):**
- Emphasizes **single-session continuous work** (`/goal`, `/loop`, auto-compaction)
- Supports **parallel sessions** (worktrees, subagents, agent teams, workflows)
- Provides **cross-session messaging** for coordinating parallel work
- Describes **plan mode** for per-session validation
- Does **not** document **sequential multi-session hand-off** as a built-in pattern

**This research shows the mechanism is **composable from primitives:**
- Skills + hooks + CLAUDE.md + git commit + shell loop = sufficient for multi-epoch orchestration
- No custom harness needed for solo developer with static plan
- Custom harness (daemon, event system, bidirectional state sharing) only needed if:
  - Real-time coordination between running sessions
  - Automatic spawning on completion (not shell-triggered)
  - Multi-developer adaptive routing

**Recommendation for the scenario:** Use the **built-in minimal mechanism** (skills + Stop hook + file handoff). It's simple, auditable, and scales to ~10 epochs without friction. If orchestrating 50+ epochs or coordinating multiple developers, consider a custom harness or use the experimental **agent teams** feature (currently disabled by default, requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`).

---

## References

All documentation fetched from code.claude.com on September 6, 2026:
- [Skills](https://code.claude.com/docs/en/skills.md)
- [Subagents](https://code.claude.com/docs/en/sub-agents.md)
- [Memory (CLAUDE.md)](https://code.claude.com/docs/en/memory.md)
- [Hooks Reference](https://code.claude.com/docs/en/hooks.md)
- [Hooks Guide](https://code.claude.com/docs/en/hooks-guide.md)
- [Headless / Non-Interactive Mode](https://code.claude.com/docs/en/headless.md)
- [Scheduled Tasks & /loop](https://code.claude.com/docs/en/scheduled-tasks.md)
- [Dynamic Workflows](https://code.claude.com/docs/en/workflows.md)
- [Cross-Session Messaging](https://code.claude.com/docs/en/cross-session-messaging.md)
- [Goal Command](https://code.claude.com/docs/en/goal.md)
- [Worktrees](https://code.claude.com/docs/en/worktrees.md)
- [Best Practices](https://code.claude.com/docs/en/best-practices.md)
- [Common Workflows](https://code.claude.com/docs/en/common-workflows.md)
- [Agent Teams](https://code.claude.com/docs/en/agent-teams.md)
- [Sessions Management](https://code.claude.com/docs/en/sessions.md)

