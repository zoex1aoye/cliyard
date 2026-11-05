# Workspace boundary excludes build output v0

> Status: Plan only, not frozen and not dispatched.

## Problem

`npm run build` emits into `dist/`, but the WorkspaceBoundary default
exclusions do not include `dist`. A task whose verify runs `npm run build`
therefore adds `dist/execution/*.js` and `*.d.ts` files that the guard reports
as protected-root changes, blocking the task even though the source changes are
inside write paths. Observed on run
`4809f45a-59ba-4058-9a4f-08b2533606b8`.

## Fix

Add `dist` to `DEFAULT_EXCLUDED_CONTROL_PATHS` so build output is never hashed
or reported as a protected-root change. The write-path audit and the protection
of source, design, evidence and Git state are unchanged; `dist` is regenerable
build output and is not a truth source.

## Non-goals

- No change to the write-path audit.
- No weakening of source/design/evidence protection.
- No additional exclusions beyond the build output directory.
