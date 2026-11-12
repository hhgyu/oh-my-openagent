// Worker-thread entry of the Native `eval` runtime. Built as its own file (dist/v2/codemode-worker.js, see
// script/build-nodes.ts) and located by name next to the client chunk (codemode-worker-client.ts).
// Nothing imports it: the main thread starts it with `node:worker_threads` `new Worker(...)`.

import { parentPort } from "node:worker_threads"
import { attachCodemodeWorker } from "./codemode-worker-runtime"

const port = parentPort
if (!port) throw Error("codemode-worker must run as a node:worker_threads Worker")

attachCodemodeWorker({
  postMessage: (message) => port.postMessage(message),
  addEventListener: (_type, listener) => {
    port.on("message", (data: unknown) => listener({ data }))
  },
})
