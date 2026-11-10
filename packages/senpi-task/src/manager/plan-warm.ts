import { loadSenpiBarrel } from "../lazy/senpi-barrel"

// An explicit pin resolves through senpi's resolver, read synchronously from the lazy barrel (#9722),
// so a cold process's first spawn must load it before planning.
export async function prepareNativeTaskPlanning(): Promise<void> {
  await loadSenpiBarrel()
}
