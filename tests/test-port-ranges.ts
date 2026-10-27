/**
 * Static, disjoint port pools for the runtime test files that start real
 * services.
 *
 * Node's test runner executes files in parallel processes. Selecting a free
 * ephemeral port and closing it before allocating a range lets two files pick
 * overlapping ranges. Each file therefore draws non-overlapping sub-ranges
 * from its own pool, and the shared cursor advances across all tests in that
 * file.
 *
 * Keep these pools disjoint from the runtime-verifier ranges:
 *
 *   21400-21499  tests/runtime-verifier.test.ts (shell verifier)
 *   21500-21599  tests/runtime-verifier.test.ts (codex-batch)
 *
 * The failure-drill pool needs 90 ports because the drill assigns three
 * disjoint 30-port subranges to three independent child processes.
 */

export const TEST_PORT_POOLS = {
  "runtime-ports": { start: 22000, end: 22099 },
  "runtime-manager": { start: 22100, end: 22199 },
  "runtime-manager-identity": { start: 22200, end: 22299 },
  "runtime-reaper-plan": { start: 22300, end: 22399 },
  "runtime-reaper": { start: 22400, end: 22499 },
  "supervisor-runtime-reaper": { start: 22500, end: 22599 },
  "runtime-failure-drills": { start: 22600, end: 22699 },
} as const;

/** Ranges owned by tests/runtime-verifier.test.ts; never overlap them. */
const RESERVED_PORT_RANGES = [
  { name: "runtime-verifier", start: 21400, end: 21499 },
  { name: "runtime-verifier codex-batch", start: 21500, end: 21599 },
] as const;

/** Fail at import time if a pool edit would reintroduce cross-file overlap. */
function assertPoolsDisjoint(): void {
  const pools = Object.entries(TEST_PORT_POOLS);
  for (const [name, pool] of pools) {
    if (pool.start > pool.end) {
      throw new Error(`test port pool ${name} is inverted (${pool.start}-${pool.end})`);
    }
    for (const reserved of RESERVED_PORT_RANGES) {
      if (pool.start <= reserved.end && reserved.start <= pool.end) {
        throw new Error(
          `test port pool ${name} (${pool.start}-${pool.end}) overlaps ` +
            `the reserved ${reserved.name} range (${reserved.start}-${reserved.end})`,
        );
      }
    }
    for (const [otherName, other] of pools) {
      if (name >= otherName) continue;
      if (pool.start <= other.end && other.start <= pool.end) {
        throw new Error(
          `test port pools ${name} (${pool.start}-${pool.end}) and ` +
            `${otherName} (${other.start}-${other.end}) overlap`,
        );
      }
    }
  }
}

assertPoolsDisjoint();

export type TestPortPoolName = keyof typeof TEST_PORT_POOLS;

export interface TestPortRange {
  readonly pool: TestPortPoolName;
  readonly range: string;
  readonly start: number;
  readonly end: number;
}

const nextPort = new Map<TestPortPoolName, number>();

/**
 * Reserve the next `size` ports from one file's static pool.
 *
 * Sub-ranges are handed out in order and are never reused within a process.
 * The allocator still probes every port, so an unrelated listener inside the
 * window is skipped through the normal PortAllocator path.
 */
export function takeTestPortRange(
  pool: TestPortPoolName,
  size: number,
): TestPortRange {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`test port range size must be a positive integer, got ${size}`);
  }

  const window = TEST_PORT_POOLS[pool];
  const start = nextPort.get(pool) ?? window.start;
  const end = start + size - 1;
  if (end > window.end) {
    throw new Error(
      `test port pool ${pool} (${window.start}-${window.end}) exhausted: ` +
        `requested ${size} port(s) at ${start}`,
    );
  }

  nextPort.set(pool, end + 1);
  return { pool, range: `${start}-${end}`, start, end };
}
