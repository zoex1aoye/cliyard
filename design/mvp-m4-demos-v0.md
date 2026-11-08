# MVP M4 — dual-scene demos (code + novel)

> After M3 lands (`e4f2f86` / PR #30).
> Gate from [dsh-plugin-mvp-roadmap-v0.md](./dsh-plugin-mvp-roadmap-v0.md).

## Goal

Prove the **same TaskContract schema** can drive two scenes end-to-end
(compile → freeze → spawn → verify → status), without auto-merge:

1. **code / local-cli** — registry target `codex` (one of claude|codex|opencode).
   When the `codex` binary is absent, argv uses a deterministic stand-in that
   still writes under `writeRoots` and records `standin` in status (evidence
   must not claim a live model session).
2. **novel** — `scene=novel`, `workspace.kind=assets`, local-cli writes
   `episodes/ep1.md` (second story on the same schema; not a live DSH LLM).
3. **`cliyard mvp-demo`** — runs both demos against a git fixture repo, writes
   `.cliyard/mvp-demo/status.json` for monitor-readable status.
4. Extend idle-spin to support `workspace.kind=assets` (mkdir cage, cwd lock).

## Non-goals

- Do not auto-merge to main.
- Do not claim live Codex/Claude/OpenCode sessions when binary/auth missing.
- Do not implement a novel multimodal runtime or real `dsh-llm` chat loop.
- Do not deepen Landlock / SQLite / process-tree ownership.

## Acceptance

- `mvp-demo` exits 0 with both scenes `ok` (or code scene `ok` with
  `codexMode=standin` explicitly recorded).
- Both contracts share schema v1; freeze sidecars present for demo outputs.
- Status JSON lists planId, contractId, scene, spawnExit, trunkClean/disposed.
