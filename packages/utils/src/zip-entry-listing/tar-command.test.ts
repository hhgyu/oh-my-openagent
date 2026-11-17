import { describe, expect, test } from "bun:test"
import { win32 } from "node:path"
import { resolveTarCommand } from "./tar-command"

describe("resolveTarCommand", () => {
  test("#given Windows with the bundled bsdtar #when resolved #then System32 tar is used whatever PATH lists first", () => {
    // given
    const expected = win32.join("D:\\Win", "System32", "tar.exe")

    // when
    const command = resolveTarCommand("win32", { SystemRoot: "D:\\Win" }, (path) => path === expected)

    // then
    expect(command).toBe(expected)
  })

  test("#given Windows with only windir set #when resolved #then System32 under windir is used", () => {
    // given
    const expected = win32.join("E:\\Windows", "System32", "tar.exe")

    // when
    const command = resolveTarCommand("win32", { windir: "E:\\Windows" }, (path) => path === expected)

    // then
    expect(command).toBe(expected)
  })

  test("#given Windows without a System32 tar #when resolved #then PATH lookup is kept", () => {
    // given
    const exists = () => false

    // when
    const command = resolveTarCommand("win32", { SystemRoot: "C:\\Windows" }, exists)

    // then
    expect(command).toBe("tar")
  })

  test("#given a POSIX platform #when resolved #then PATH lookup is used without probing the disk", () => {
    // given
    const probes: string[] = []

    // when
    const command = resolveTarCommand("linux", {}, (path) => {
      probes.push(path)
      return true
    })

    // then
    expect(command).toBe("tar")
    expect(probes).toEqual([])
  })
})
