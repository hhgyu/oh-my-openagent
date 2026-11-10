import { expect, test } from "bun:test"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
// Test oracle only. Production model text never imports this UI package.
import { truncateToWidth } from "@earendil-works/pi-tui"
import { excerptModelText } from "./model-text"
import { normalizeRendererText, stripTerminalControls } from "./renderer-text"

test("normalized model excerpts equal the pinned Native width implementation", () => {
  const corpus = [
    "", "plain ASCII model name", "한국어 모델 이름과 아주 긴 접미어", "漢字かなカナ界", "e\u0301 cafe\u0301",
    "👩‍💻 👨‍👩‍👧‍👦 🏳️‍🌈 👍🏽", "🇰🇷🇺🇸 🇦 🇧", "✈︎ ✈️", "क्‍षक्षि हिन्दी", "မြန်မာ กำ ຳ",
    "\u065f\u0f7f\u102b\u102c\u1031\u1033", "ｶﾞＡＢＣ", "가나", "a界\u200d\u0301z",
    "界界\u200d\ufe0f\u0301a", "\u0301\u200d界界a", "a界\u200d\ufe0f\u0301tail",
    "  one\t two\n三\r\n四  ", "\x1b[31m색상\x1b[0m and \x1b]8;;https://local.invalid\x07링크\x1b]8;;\x07",
    "safe\x1b]8;;incomplete", "a\u009b31m界\u009b0m\u0007b", "\ud800 a \udc00", "...界...",
  ]
  const atoms = ["a", "界", "가", "e\u0301", "👩‍💻", "🇦", "\u0301", "\u200d", "\u065f", "ि", "ำ", "ｶﾞ"]
  for (const a of atoms) for (const b of atoms) corpus.push(a + b + "界\u0301z")
  const widths = [-Infinity, -1, 0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 7, 10, 48, 120, Infinity, NaN]
  for (const text of corpus) for (const width of widths) {
    const expected = width <= 0 ? "" : stripTerminalControls(truncateToWidth(normalizeRendererText(text), width, "..."))
    expect(excerptModelText(text, width)).toBe(expected)
  }
})

test("fresh poisoned process EXECUTES progress, identity and output model formatting without UI warmup", () => {
  const url = (name: string) => pathToFileURL(resolve(import.meta.dir, name)).href
  const script = `
let poisoned = 0;
Bun.plugin({name:"model-format-execution-boundary",setup(b){b.onResolve({filter:/^(@earendil-works\\/pi-tui|@code-yeongyu\\/senpi|@oh-my-opencode\\/omo-senpi)(\\/|$)/},a=>{poisoned++;throw Error("FORBIDDEN_SDK_UI:"+a.path)})}});
const {createChildProgress}=await import(${JSON.stringify(url("progress.ts"))});
const {taskIdentityLabel}=await import(${JSON.stringify(url("status-line.ts"))});
const {taskOutputModelText}=await import(${JSON.stringify(url("tools/output/model-text.ts"))});
const details=createChildProgress("st_cold",{name:"모델界 ".repeat(20)},Date.now()).details();
const identity=taskIdentityLabel({taskId:"st_cold",name:"👩‍💻界".repeat(40)});
const model=taskOutputModelText({model:"qa/model",resolved_model:{display:"모델界 ".repeat(40)}});
if(poisoned||!details.progress.activity||!identity||!model.includes("model "))throw Error("Cold execution failed");
console.log(JSON.stringify({poisoned,executed:3}));`
  const actual = Bun.spawnSync([process.execPath, "--eval", script], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe", timeout: 5000 })
  expect(new TextDecoder().decode(actual.stderr)).toBe("")
  expect(actual.exitCode).toBe(0)
  expect(JSON.parse(new TextDecoder().decode(actual.stdout))).toEqual({ poisoned: 0, executed: 3 })
})
