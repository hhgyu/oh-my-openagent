import {
  createFormatterStep as createCoreFormatterStep,
  type FormatterDaemonPort,
  type FormatterStepOptions as CoreFormatterStepOptions,
} from "@oh-my-opencode/lsp-core/mutation/formatter"
import { callPackagedDaemonTool } from "../lsp/daemon-tool-client"

export {
  bunFormatter,
  detectFormatter,
  formatOnMutationDefaults,
  resolveFormatMode,
} from "@oh-my-opencode/lsp-core/mutation/formatter"
export type { FormatMode, Formatter, FormatterTool } from "@oh-my-opencode/lsp-core/mutation/formatter"

export interface FormatterStepOptions extends CoreFormatterStepOptions {
  readonly daemonFormat?: FormatterDaemonPort
}

export function createFormatterStep(options: FormatterStepOptions = {}) {
  return createCoreFormatterStep(
    options,
    options.daemonFormat ?? ((filePath) => callPackagedDaemonTool("format", { filePath })),
  )
}
