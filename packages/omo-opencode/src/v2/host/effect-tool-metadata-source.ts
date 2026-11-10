import { Effect, type Scope } from "effect"
import type { ToolDomain } from "@opencode/plugin/effect/tool"
import { safeToolMetadataSchema, type SafeToolMetadata } from "./owned-child-observation-types"

const provenance = Symbol("owned-effect-tool-metadata-source")
/** Composition capability issued only after scoped public Effect hook acquisition. */
export interface OwnedToolMetadataSource { readonly [provenance]: true }
export interface ToolMetadataBatch { readonly records: readonly SafeToolMetadata[]; readonly closed: boolean; readonly issue?: string }
export interface OwnedToolMetadataSubscription {
  drain(): ToolMetadataBatch
  wait(signal?: AbortSignal): Promise<void>
  close(): void
}
interface Mailbox { readonly sessionID: string; offer(raw: unknown): void; retire(): void }
interface Source { closed: boolean; readonly subscriptions: Set<Mailbox>; readonly maxEntries: number; readonly maxBytes: number; readonly maxSubscriptions: number }
const sources = new WeakMap<object, Source>()
export interface ToolMetadataSourceOptions { readonly maxEntries?: number; readonly maxBytes?: number; readonly maxSubscriptions?: number }

/** Hook work is synchronous projection + bounded enqueue. No subscriber callback or
 * Promise hook adapter is accepted. Acquire before observers so their later scope
 * cleanup joins their pumps before this earlier source finalizer retires the hook. */
export function acquireEffectToolMetadataSource(tool: ToolDomain, options: ToolMetadataSourceOptions = {}): Effect.Effect<OwnedToolMetadataSource, never, Scope.Scope> {
  return Effect.gen(function* () {
    const maxEntries=options.maxEntries??256, maxBytes=options.maxBytes??262_144, maxSubscriptions=options.maxSubscriptions??128
    if (![maxEntries,maxBytes,maxSubscriptions].every(value=>Number.isSafeInteger(value)&&value>0)) throw Error("Invalid tool metadata source limits")
    const state:Source={closed:false,subscriptions:new Set(),maxEntries,maxBytes,maxSubscriptions}
    // Installed first: even an interrupted acquisition retires all local resources.
    yield* Effect.addFinalizer(()=>Effect.sync(()=>{
      state.closed=true
      for(const subscription of [...state.subscriptions])subscription.retire()
    }))
    yield* tool.hook("execute.after",raw=>Effect.sync(()=>{
      if(state.closed)return
      for(const subscription of state.subscriptions)subscription.offer(raw)
    }))
    const source:OwnedToolMetadataSource=Object.freeze({[provenance]:true as const})
    sources.set(source,state)
    return source
  })
}

/** Pull-only boundary. Its notification promises never execute caller work. The
 * consumer owns and joins its pump; close/abort removes every notification waiter. */
export function openOwnedToolMetadataSubscription(source: OwnedToolMetadataSource, sessionID: string): OwnedToolMetadataSubscription {
  const state=source&&sources.get(source)
  if(!state)throw Error("Unrecognized tool metadata source")
  if(state.closed)throw Error("Tool metadata source closed")
  // Use the same strict identity codec as the retained metadata, without inventing a host ID.
  if(!safeToolMetadataSchema.shape.sessionID.safeParse(sessionID).success)throw Error("Invalid tool metadata session")
  if(state.subscriptions.size>=state.maxSubscriptions)throw Error("Tool metadata subscription limit exceeded")
  let records:SafeToolMetadata[]=[],bytes=0,closed=false,issue:string|undefined
  const waiters=new Set<()=>void>()
  const wake=()=>{for(const done of [...waiters])done()}
  const mailbox:Mailbox={sessionID,offer(raw){
    if(closed||issue)return
    // Foreign payloads are never projected or retained.
    if(!raw||typeof raw!=="object"||(raw as {sessionID?:unknown}).sessionID!==sessionID)return
    const value=raw as Record<string,unknown>
    const parsed=safeToolMetadataSchema.safeParse({sessionID:value.sessionID,messageID:value.messageID,callID:value.id,tool:value.tool,status:value.status})
    if(!parsed.success){issue="malformed-tool-metadata";wake();return}
    const size=Buffer.byteLength(JSON.stringify(parsed.data))
    if(records.length>=state.maxEntries||size>state.maxBytes-bytes){issue="tool-metadata-overflow";wake();return}
    records.push(Object.freeze(parsed.data));bytes+=size;wake()
  },retire(){if(closed)return;closed=true;issue??="tool-metadata-source-closed";state.subscriptions.delete(mailbox);wake()}}
  state.subscriptions.add(mailbox)
  return Object.freeze({
    drain(){const batch={records:Object.freeze(records),closed,...(issue?{issue}:{})};records=[];bytes=0;return Object.freeze(batch)},
    wait(signal?:AbortSignal){
      if(signal?.aborted)return Promise.reject(signal.reason)
      if(closed||issue||records.length)return Promise.resolve()
      if(waiters.size)return Promise.reject(Error("Tool metadata pull already pending"))
      return new Promise<void>((resolve,reject)=>{
        const done=()=>{waiters.delete(done);signal?.removeEventListener("abort",abort);resolve()}
        const abort=()=>{waiters.delete(done);signal?.removeEventListener("abort",abort);reject(signal?.reason)}
        waiters.add(done);signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)abort()
      })
    },
    close(){closed=true;records=[];bytes=0;state.subscriptions.delete(mailbox);wake()},
  })
}
