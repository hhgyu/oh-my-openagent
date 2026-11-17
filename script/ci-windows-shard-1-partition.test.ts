import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import {
  discoverTestFiles,
  MEMORY_CORE_HEAVY_TEST_SECONDS,
  MEMORY_CORE_PARTITIONS,
  memoryCoreWeight,
  partitionByWeight,
} from "./ci-windows-shard-1-partition"

const memoryCore = fileURLToPath(new URL("../packages/memory-core", import.meta.url))

describe("Windows shard 1 memory-core partition", () => {
  test("#given the repository memory-core suite #when it is split #then every heavy weight names a live file and each set balances", () => {
    // given
    const files = discoverTestFiles(memoryCore)
    // when
    const sets = partitionByWeight(files, memoryCoreWeight, MEMORY_CORE_PARTITIONS)
    // then: a renamed or deleted heavy file would silently fall back to the default weight.
    expect(Object.keys(MEMORY_CORE_HEAVY_TEST_SECONDS).filter((file) => !files.includes(file))).toEqual([])
    expect(sets).toHaveLength(MEMORY_CORE_PARTITIONS)
    expect(sets.flat().sort()).toEqual(files)
    const totals = sets.map((set) => set.reduce((sum, file) => sum + memoryCoreWeight(file), 0))
    expect(Math.min(...totals) / Math.max(...totals)).toBeGreaterThan(0.9)
  })

  test("#given the repository memory-core sets #when each becomes one Windows command line #then it stays under CreateProcess's 32767-character limit", () => {
    // given
    const sets = partitionByWeight(discoverTestFiles(memoryCore), memoryCoreWeight, MEMORY_CORE_PARTITIONS)
    // when
    const lengths = sets.map(
      (set) =>
        ["bun.exe", "test", "--timeout", "30000", ...set.map((file) => `./packages/memory-core/${file}`)].join(" ")
          .length,
    )
    // then: leaves room for the runner's absolute bun.exe path.
    expect(Math.max(...lengths)).toBeLessThan(24000)
  })
})
