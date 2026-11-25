import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { checkCredentialDirectory, checkCredentialParents, CredentialParentError } from "./credential-parent"
import { temporaryHome } from "./test-support"

describe("credential parent directories", () => {
  test("#given a host that cannot answer ownership #when the parents exist #then they are accepted", async () => {
    const home = await temporaryHome()
    await mkdir(join(home, ".omo"))
    expect(checkCredentialParents(home, undefined)).toBe(true)
  })

  test("#given a host that cannot answer ownership #when .omo is missing #then the parents read as absent", async () => {
    const home = await temporaryHome()
    expect(checkCredentialParents(home, undefined)).toBe(false)
  })

  test("#given a host that cannot answer ownership #when .omo is a file #then it is still refused", async () => {
    const home = await temporaryHome()
    await writeFile(join(home, ".omo"), "synthetic")
    expect(() => checkCredentialParents(home, undefined)).toThrow(CredentialParentError)
    expect(() => checkCredentialParents(home, undefined)).toThrow("not a directory")
  })

  test.skipIf(process.getuid === undefined)(
    "#given a POSIX host #when the home belongs to another uid #then it is refused as a foreign owner",
    async () => {
      const home = await temporaryHome()
      const other = (process.getuid?.() ?? 0) + 1
      expect(() => checkCredentialDirectory(home, other)).toThrow("foreign owner")
    },
  )
})
