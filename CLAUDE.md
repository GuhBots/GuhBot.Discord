# Archivist Working Instructions

Build Archivist according to [the Archivist plan](https://github.com/GuhBots/GuhBot.Archivist/blob/main/docs/proposals/ARCHIVIST-PLAN.md), which lives in `GuhBot.Archivist`. The owner steers the work and reviews behavior. Take responsibility for implementation, verification, documentation, and keeping progress recoverable between sessions.

## Read Before Working

Read these documents at the start of a new session and after relevant instructions change.

* [Repository instructions](AGENTS.md).
* [Contributing](CONTRIBUTING.md).
* [Coding style](docs/coding-style.md).
* [Documentation conventions](docs/documentation.md).
* [Repository overview](README.md), [documentation map](docs/README.md), and the README and additional instructions for each directory being changed.
* The complete [Archivist plan](https://github.com/GuhBots/GuhBot.Archivist/blob/main/docs/proposals/ARCHIVIST-PLAN.md), including the data contracts, permissions, failure behavior, milestones, and acceptance scenarios.
* The local progress file `archivist-roadmap.local.md`, if present.

Inspect the current branch, working tree, recent commits, and existing implementation before editing. Check the actual package scripts and installed tooling before choosing verification commands. Read the relevant source before replacing or extending it.

## Scope And Authority

The canonical specification is `docs/proposals/ARCHIVIST-PLAN.md` in `GuhBot.Archivist`, the sibling checkout at `../GuhBot.Archivist`. It moved there on 2026-11-24. This repository keeps only a link to it with Discord integration notes. Do not use copies under `docs/` or `build/` as competing specifications. Do not silently weaken requirements, remove acceptance scenarios, or mark a missing feature out of scope to finish sooner.

When the owner requests implementation, that request authorizes the normal development work described here. The plan's preparation-stage wording does not require another confirmation for every milestone. A request to edit instructions or refine the plan alone does not start the application build.

Follow the updated plan through service migration stages `S0` to `S6` and application milestones `M0` to `M5`. The standalone viewer in `M6` remains outside this request. The web interface is primary. `GuhBot.Archivist` owns the website, API, databases, media, and rules. `GuhBot.Discord` retains `/archive`, `/a`, and logs-channel commands as authenticated API clients. Preserve per-archive Discord whitelists, mandatory Discord browser sign-in, explicit service owner IDs, archive portability, media preservation, date rules, and deletion behavior.

Resolve ordinary implementation choices using the plan, repository conventions, existing code, and verified upstream documentation. Record material technical decisions and their reasons. Ask a focused clarification only when missing or conflicting information changes product behavior, data meaning, permissions, or scope and cannot be resolved from those sources. Explain the affected behavior and propose a concrete choice. Continue independent work while awaiting the answer.

Do not reopen settled product decisions merely because a different implementation is easier. When a requirement is technically impossible or incompatible with the actual environment, establish the cause, report the affected requirement, and present a workable alternative before changing the contract.

## Branch And Commits

In `GuhBot.Discord`, work exclusively on `feat/archivist`, the existing Archivist branch. This is the branch-specific exception to starting a new branch for each piece of work in Contributing. Read the sibling service repository's own instructions before changing it. Inspect and preserve its uncommitted migration work rather than overwriting it with the older bot copy. Change the plan in `GuhBot.Archivist`, through that repository's pull requests. Do not create another implementation branch or change the default branch. If a session starts on another branch, inspect its changes and switch only when doing so preserves all work. Ask for help if switching would overwrite or misattribute changes.

Local commits on `feat/archivist` are authorized. Commit coherent, verified increments with succinct messages describing the resulting change. Inspect the staged diff and stage explicit paths or hunks. Preserve unrelated and pre-existing work.

Do not force push, rewrite shared history, discard work, merge into the default branch, publish a release, or deploy remotely without a separate request. Permission to commit locally does not imply permission to publish. Keep credentials, archive contents, local databases, logs, and the local roadmap out of commits.

## Work Loop

1. Reconcile the roadmap with the current source, Git history, and verification evidence. Resume the first incomplete dependency rather than starting again.
2. Choose a manageable increment that advances a plan milestone. Identify the required behavior, affected existing behavior, and acceptance evidence before editing.
3. Implement behavior in service-owned application operations and the necessary API adapters. Do not continue extending the bot's local archive implementation as the target architecture. Avoid placeholder success responses, disconnected interface controls, and duplicate business rules.
4. Add meaningful test coverage where the change needs it. Run the relevant checks and inspect the result. Fix failures caused by the change before expanding the scope.
5. Review the diff for regressions, unwanted files, secrets, incomplete behavior, and documentation accuracy. Commit a coherent increment when appropriate.
6. Update the roadmap with the actual result, verification evidence, and next action. Continue with the next increment without asking whether to proceed.

Keep iterating until the requested scope and acceptance checks are complete or a genuine external dependency prevents further useful progress. Do not stop after a scaffold, a single milestone, or a plan when implementation is requested. Do not repeatedly rerun passing checks unless a new change or unresolved concern justifies it.

Keep the owner informed with concise progress updates during sustained work, normally at least once a minute. State what now works, what remains uncertain, and the next check that will resolve it. User corrections steer the current work. Incorporate them without abandoning the remaining scope unless asked to do so.

## Preserve Existing Behavior

Establish the existing build and check results before substantial implementation. Preserve unrelated commands, command registration restrictions, owner guards, configuration behavior, and AFK data. Prefer focused additions and small integration changes over broad rewrites.

Use additive, versioned migrations and the plan's recovery rules. Exercise migrations against temporary copies and fixtures before applying them to real data. Do not reset a real database or delete original media to make development easier. Use isolated test archives and temporary paths for destructive cases.

When changing a shared helper, startup path, dependency, build configuration, or database connection, identify its existing callers and verify affected bot behavior. Add regression coverage where it protects a meaningful contract. If a failure predates the work, record the baseline and cause when known. Do not hide it, weaken a check, or claim the full suite passes.

## Tests And Runtime Verification

Follow the plan's acceptance scenarios and add cases for newly discovered failure modes. Cover valid behavior, invalid input, authorization, archive isolation, date interpretation, duplicates, stale edits, persistence, recovery, and deletion where relevant. Test observable behavior rather than copying implementation details into assertions.

Run relevant project commands in the [dev container](.devcontainer/README.md) when available. If the container cannot run, use suitable local checks and record that limitation. Existing commands include the following.

```sh
npm run check
npm run build
python3 tools/scripts/run_checks.py
```

Introduce the Archivist test commands and continuous integration jobs specified by the plan as part of implementation. Document them when they actually exist. Do not report planned test commands as successful checks. Distinguish automated fixture coverage, browser coverage, live Discord checks, live Drive checks, and performance measurements.

Starting and stopping a local development bot or web app is authorized. Read the [Discord setup guide](docs/guides/discord-setup.md) and runtime instructions first. Use the configured test environment and existing secret-loading mechanism without printing secrets. Check for an existing process before starting a competing bot instance. Track processes started for verification and stop them when the check is finished unless the owner asks to keep them running. Do not stop an unrelated service or send test traffic to an unidentified production environment.

Perform the checks available to you before asking the owner to test. If a check requires the owner's Discord account, browser sign-in, real media, credentials, or visual judgment, provide the exact command or screen, setup, steps, and expected result. State what has already passed. Record the check as awaiting owner verification rather than complete, and continue unrelated work.

## Recoverable Progress

Maintain `archivist-roadmap.local.md` at the repository root. It is a local, ignored Markdown file and must never be staged, committed, or deleted as cleanup. If missing, recreate it from the canonical plan, current implementation, and Git history. Do not make the rest of the documentation depend on this local file.

Update it before beginning a substantial increment, after a checkpoint or commit, before a long operation, and before yielding or stopping. Keep it useful for a fresh session with no conversation history. Include the following.

* The current branch, last checked commit, current milestone, and immediate next action.
* A checklist mapped to plan requirements and milestones, distinguishing implemented, verified, awaiting owner verification, and blocked work.
* In-progress files and behavior, including unfinished work that has not been committed.
* Actual verification commands, results, dates, and environment limitations.
* Relevant owner decisions, unresolved clarifications, external prerequisites, and precise manual test requests.
* Any running process started for the task, its purpose, and how to stop or resume it without exposing secrets.

Before a potentially interruptible operation, record its purpose and how to determine whether it completed. Never rely on a final message or an in-memory task list as the only record. Treat the roadmap as a navigation aid and verify its claims against the repository when resuming.

## Documentation And Writing

Create and update documentation needed to implement and operate Archivist. Follow the documentation placement, naming, directory README, and navigation rules. Keep the accepted specification in the canonical plan and explain implemented behavior in the relevant guides and component READMEs. Record an owner-approved contract change in the plan together with its implementation and acceptance coverage.

Follow the repository's coding and prose guidelines. Write plain, direct text in documentation, comments, commit messages, and user-facing interfaces. Avoid assistant boilerplate, promotional language, invented jargon, and claims unsupported by evidence. Comments should explain a constraint or reason. Documentation must describe tooling and behavior that actually exist.

When reporting progress or handing off, state the resulting behavior, checks run and their results, remaining blockers, and any exact action needed from the owner. Report incomplete work honestly. Do not claim a milestone complete until its acceptance evidence exists.
