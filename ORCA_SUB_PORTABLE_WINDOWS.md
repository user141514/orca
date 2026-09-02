# Portable `orca-sub` Setup and Recovery

This document describes how to use the `feat/orca-sub-portable-win` source checkout as a portable Orca subagent distribution on Windows.

The intended contract is:

```text
fresh Windows machine
  -> clone the repository
  -> install dependencies
  -> build the source distribution
  -> register `orca-sub`
  -> open a new ordinary CMD
  -> run `orca-sub "<mission>"`
```

The registered command must delegate back into the checkout that registered it. It must not depend on another machine's build directory, profile, wrapper, or runtime metadata.

## 1. Prerequisites

Install these before cloning:

- Git for Windows
- Node.js supported by the Orca repository
- Corepack / pnpm as required by the repository

Verify from **CMD or PowerShell**:

```bat
git --version
node --version
pnpm --version
```

Do not use WSL as a substitute for the Windows setup described here. Windows Orca process ownership, user-data paths, terminal daemons, and command registration are Windows-host state.

## 2. Clone and select the branch

```bat
git clone <ORCA_REPOSITORY_URL>
cd orca
git checkout feat/orca-sub-portable-win
```

Before changing anything, record the checkout identity:

```bat
git status --short --branch
git rev-parse HEAD
git remote -v
```

If this is an existing checkout with user changes, do **not** run `git reset --hard` or `git clean -fdx` just to match this guide.

## 3. Install dependencies and build

```bat
pnpm install
pnpm run build
```

Use the full build for a fresh clone that must cold-start its own Orca runtime. `pnpm run build:cli` is sufficient for CLI-only checks such as `orca-sub --help`, but it does not by itself prove that the Electron/runtime side needed for a cold mission is built.

On Windows, build and registration are deliberately separate. `build:cli` invokes the installer only with `--build-hook`, which is a no-op for global registration. Building this checkout must not replace an existing `%APPDATA%\npm\orca-sub.cmd`.

## 4. Register the command

Run the explicit registration command:

```bat
pnpm run orca-sub:install
```

On Windows the installer creates a thin `orca-sub.cmd` in the user's npm command directory, normally:

```text
%APPDATA%\npm\orca-sub.cmd
```

The wrapper contains no Orca runtime lifecycle logic. Its job is only to pin this checkout's command and profile identity:

```text
orca-sub.cmd
  -> clone-scoped user-data/profile
  -> node <THIS_CHECKOUT>\config\scripts\orca-sub.mjs
```

Each checkout receives a stable 12-hex profile ID derived from its normalized source path, under the registering machine's application-data root:

```text
%APPDATA%\orca-sub\profiles\<checkout-id>
```

Therefore clone A and clone B do not silently reuse the same default `%APPDATA%\orca-dev` runtime identity.

`orca-sub.mjs` then uses the existing source-checkout path:

```text
orca-sub.mjs
  -> orca-dev.mjs
  -> out/cli/index.js
  -> shared RuntimeClient / mission implementation
```

If another unrelated `orca-sub.cmd` already exists, the installer reports a conflict and leaves it unchanged. Resolve the conflict deliberately; do not silently overwrite a command whose ownership is unknown.

For non-destructive verification, redirect registration to a disposable command directory instead of the real user npm directory:

```bat
set ORCA_SUB_INSTALL_DIR=E:\temp\orca-sub-verify\bin
set APPDATA=E:\temp\orca-sub-verify\appdata
node config\scripts\install-sub-cli.mjs
```

This is the preferred local acceptance path when a known-good global `orca` / `orca-sub` installation must remain untouched.

## 5. Verify from a new ordinary CMD

Close the installation shell and open a new CMD so PATH state is not inherited from a special developer shell.

Run:

```bat
where orca-sub
orca-sub --help
```

The first `where orca-sub` result should be the wrapper you intentionally registered.

Then run a small mission:

```bat
orca-sub "Inspect this checkout and report the current branch and HEAD only."
```

A successful warm run is not enough to prove portability. On a disposable host, also test a cold start with no compatible Orca runtime already running.

---

# Runtime identity model

Do not diagnose Orca from one path or one PID alone. The relevant identity chain is:

```text
command resolution
  -> registered wrapper
  -> CLI checkout/build
  -> app executable
  -> user-data/profile
  -> runtime metadata/runtimeId
  -> terminal daemon / surviving terminals
```

A match at one layer does not prove the whole chain matches.

Useful distinction:

```text
GUI process exit != terminal daemon exit != terminal exit
```

A compatible daemon may intentionally survive a same-target GUI restart. A daemon belonging to an incompatible build/profile must not be treated as proof that the requested runtime is ready.

---

# Authoritative inspection checklist

When `orca-sub` fails on a new machine, gather facts before repairing anything.

## A. Command identity

From ordinary CMD:

```bat
where orca-sub
where orca
```

Read the first resolved wrapper instead of assuming the command points at the checkout you intended.

Questions:

1. Which checkout does `orca-sub.cmd` invoke?
2. Does that checkout still exist?
3. Was `pnpm run build:cli` run in that checkout?
4. Is another stale wrapper earlier on PATH?

## B. Source checkout identity

Inside the checkout:

```bat
git status --short --branch
git rev-parse HEAD
git remote -v
```

Do not destroy dirty work to make diagnosis easier.

## C. Runtime status

If the CLI is available:

```bat
orca status --json
```

Treat runtime metadata as a claim that must be checked against live process state. A stale PID in metadata is not a live runtime.

## D. Windows process identity

Use PowerShell, not process-name counting alone:

```powershell
Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -in @('Orca.exe', 'electron.exe', 'orca-terminal-daemon.exe')
  } |
  Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine
```

Inspect:

- executable path;
- `--user-data-dir`;
- parent/child relationships;
- daemon ownership.

`Orca.exe` count alone is not a sufficient runtime identity check.

---

# Known failure shapes

## 1. Wrapper/profile split

Symptom:

```text
orca open      -> works
orca-sub ...   -> "Orca is not running"
```

Likely cause:

```text
orca     -> checkout/profile A
orca-sub -> checkout/profile B
```

Check `where` results, wrapper contents, profile/user-data selection, then runtime metadata for each target.

Do not repair this by making both wrappers contain more duplicated lifecycle logic. Both commands should eventually enter the shared CLI/runtime primitives.

## 2. Correct executable, wrong profile

Seeing the expected executable path is not enough. Electron single-instance ownership is scoped by user-data/profile state. Check the running process command line for the intended `--user-data-dir` when a packaged target is involved.

## 3. Stale runtime metadata

Metadata may name a PID that no longer exists.

Interpretation:

```text
recorded PID != proof of a live runtime
```

Reacquire live process state before deciding whether to launch or reuse anything.

## 4. Warm-path false positive

A mission that succeeds while a compatible runtime is already running does not prove:

- cold-start capability;
- correct executable launch;
- correct profile propagation;
- replacement of a wrong target.

Run cold-path acceptance on a disposable Windows host before claiming the distribution is portable.

## 5. Cold-start timeout

Cold Electron startup may take substantially longer than a warm RPC reconnect. A timeout should be compared with actual process/runtime readiness timestamps before changing launch logic.

Do not infer "launch failed" solely from an early timeout if the exact requested runtime becomes ready shortly afterwards.

## 6. `agent_prompt_stalled`

`agent_prompt_stalled` is an ambiguous delivery observation, not proof that the worker rejected or never received the prompt.

Required interpretation:

```text
unobserved acknowledgement != negative acknowledgement
```

Before replaying a prompt, inspect the same Run / Task / Dispatch lifecycle. If that same dispatch progressed or completed, do not resend the prompt and create duplicate effects.

## 7. GUI closed but terminals remain

A GUI exit does not imply daemon-backed terminals exited.

For a same-build/same-profile GUI restart, preserving a compatible daemon may be correct. For a build/profile replacement, incompatible daemon ownership must be considered separately.

## 8. PATH conflicts

`where orca-sub` may show more than one result.

Common sources:

- `%APPDATA%\npm` wrapper;
- profile-local `cli\bin` wrapper;
- another checkout's registration;
- historical manual wrapper.

The first result is what ordinary CMD actually executes. Diagnose that file first.

---

# AI repair procedure

If another AI is asked to repair a broken installation, give it this procedure verbatim.

## Phase 1: declare the boundary

Write down:

```text
KNOWN
INFERRED
UNKNOWN
ACTIVE UNKNOWN FRONTIER
PROTECTED STATE
```

Protected state includes dirty user checkouts and any known-good Orca build/profile that the user has explicitly asked to preserve.

## Phase 2: inspect before mutation

Collect:

```bat
where orca-sub
where orca
git status --short --branch
git rev-parse HEAD
orca status --json
```

and PowerShell process command lines for Orca GUI/daemon owners.

Do not convert an inference into a fact because it explains the symptom well.

## Phase 3: reconstruct identity

Build the actual chain:

```text
wrapper
-> checkout CLI
-> executable
-> profile
-> runtimeId
-> daemon
```

Compare the chain the user intended with the chain the machine actually executed.

## Phase 4: minimal repair

Prefer fixing the earliest shared identity/lifecycle primitive that is wrong.

Do not create a new wrapper protocol just because editing a `.cmd` file is convenient.

## Phase 5: user-equivalent acceptance

The final test must start from the user's ordinary CMD, not a privileged developer shell or an already-running Orca terminal.

Test at least:

```text
cold target
wrong existing target
same exact target
concurrent callers
```

on a disposable host before declaring full runtime portability.

---

# Explicitly forbidden recovery shortcuts

Unless the user explicitly authorizes destructive recovery, do not:

```text
git reset --hard
git clean -fdx
copy an entire known-good profile from another machine
overwrite an unknown existing global wrapper
kill unrelated Electron applications
replay an ambiguous worker prompt automatically
```

These operations can make the symptom disappear while destroying the evidence or the user's working state.

---

# Moving or recloning the checkout

The Windows wrapper intentionally targets the checkout that registered it. If the repository is moved or deleted, rerun registration from the new checkout:

```bat
pnpm run orca-sub:install
```

If an old managed or unrelated wrapper conflicts, inspect it first. Do not assume ownership based only on the filename.

---

# Portability acceptance status

Local deterministic tests and temporary-directory registration can prove launcher portability without disturbing a running Orca installation.

Full runtime portability additionally requires a disposable Windows host for:

- OrcaZero cold start;
- incompatible build/profile replacement;
- exact-target warm reuse;
- concurrent two-CMD startup;
- scratch mission outside a managed worktree.

Do not use a user's protected known-good runtime as the disposable acceptance target.
