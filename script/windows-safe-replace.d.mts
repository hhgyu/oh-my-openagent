export interface LockRetryOptions {
  readonly platform?: NodeJS.Platform
  readonly retryDelaysMs?: readonly number[]
  readonly sleep?: (ms: number) => Promise<void>
  readonly describeLockers?: (path: string) => Promise<readonly string[] | undefined>
  readonly rename?: (from: string, to: string) => Promise<void>
  readonly remove?: (path: string, options: { recursive: true; force: true }) => Promise<void>
}

export interface ReplaceFileOptions extends LockRetryOptions {
  readonly mode?: number
}

export class LockedOutputError extends Error {
  readonly path: string
  readonly lockers: readonly string[] | undefined
}

export function isTransientWindowsLockError(error: unknown, platform?: NodeJS.Platform): boolean
export function replaceFileContents(
  target: string,
  contents: string | Uint8Array,
  options?: ReplaceFileOptions,
): Promise<boolean>
export function removePath(target: string, options?: LockRetryOptions): Promise<void>
