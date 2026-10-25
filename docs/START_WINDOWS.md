# Start on Windows + WSL (v0 validation)

## 0. Preconditions

1. WSL2 + a distro (e.g. Ubuntu)
2. Inside WSL: `git`, and at least one of `claude` / `codex` / `codebuddy` (logged in)
3. Node 20+ on **Windows** (harness entry)
4. Put the **project under test** on the Linux filesystem, e.g. `~/work/my-app`  
   Avoid `/mnt/c/...` for agent + git worktree performance.

## 1. Install cliyard

From PowerShell (path via `\\wsl$\...` or clone into WSL):

```powershell
wsl -d Ubuntu --cd ~/cliyard -- bash -lc "npm install"
cd \\wsl$\Ubuntu\home\$env:USERNAME\cliyard
npm install
copy config.example.yaml config.yaml
# edit distro / default_repo / workers
```

## 2. Doctor

```powershell
npm run doctor
```

Expect JSON with `wslOk: true` and at least one worker `ok: true`.

## 3. Dry-run then real run

```powershell
npm run run-task -- --repo ~/work/my-app --prompt "Add a trivial health comment in README" --worker auto --dry-run

npm run run-task -- --repo ~/work/my-app --prompt "Add a trivial health comment in README" --worker auto --permission accept
```

Tune `--permission bypass` only when you accept unattended risk (prefer after CLI sandbox is on).

## 4. What to tune in real use

- Adapter flags in `src/adapters.ts` (each CLI version drifts)
- `workers` order in `config.yaml`
- Whether `-p` / `exec` modes need extra env (API keys, `CODEBUDDY_IS_SANDBOX`)
- Concurrent runs later: multiple worktrees, queue browser/compile jobs

## 5. Cleanup worktrees

Inside WSL repo:

```bash
git worktree list
git worktree remove .cliyard/worktrees/<id>
git branch -D cliyard/<id>
```
