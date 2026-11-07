import { expect, test } from "bun:test"
import { normalizeOwnedChildEvent, observationRecordSchema } from "./owned-child-observation-types"
const envelope = (type = "session.text.ended") => ({ id: "evt_actual", type, created: 1, durable: { aggregateID: "child", seq: 2, version: 2 }, data: { sessionID: "child", assistantMessageID: "assistant", ordinal: 0, text: "complete text" } })
test("safe projection keeps genuine event identity and complete final text, strips raw secrets", () => {
 const raw={...envelope(),headers:{Authorization:"secret"},data:{...envelope().data,error:{type:"provider.internal",message:"secret",response:{token:"secret"}},input:{password:"secret"},output:"secret",model:{providerID:"actual",id:"observed",headers:{secret:true}}}}
 const value=normalizeOwnedChildEvent(raw,"child")!
 expect(value.id).toBe("evt_actual");expect(value.durable?.version).toBe(2);expect(value.data.text).toBe("complete text");expect(value.data.model).toEqual({providerID:"actual",id:"observed"});expect(value.data.errorType).toBe("provider.internal");expect(JSON.stringify(value)).not.toContain("secret")
})
test("non-owned events are ignored; conflicting aggregate identity is rejected", () => {
 expect(normalizeOwnedChildEvent(envelope(),"other")).toBeUndefined()
 expect(()=>normalizeOwnedChildEvent({...envelope(),durable:{aggregateID:"foreign",seq:2,version:1}},"child")).toThrow("identity")
 expect(()=>normalizeOwnedChildEvent({...envelope(),data:{...envelope().data,sessionID:"foreign"}},"child")).toThrow("identity")
})
test("delta/tool input text is not retained and oversized final text is rejected without truncation", () => {
 expect(normalizeOwnedChildEvent(envelope("session.text.delta"),"child")?.data.text).toBeUndefined()
 expect(normalizeOwnedChildEvent(envelope("session.tool.input.ended"),"child")?.data.text).toBeUndefined()
 expect(()=>normalizeOwnedChildEvent({...envelope(),data:{...envelope().data,text:"x".repeat(1_048_577)}},"child")).toThrow()
})
test("unknown owned durable event types retain their real cursor without unsafe payload", () => {
 const raw={id:"evt_unknown",type:"session.future.event",created:2,durable:{aggregateID:"child",seq:10,version:7},data:{sessionID:"child",credentials:{token:"secret"}}}
 expect(normalizeOwnedChildEvent(raw,"child")).toEqual({id:raw.id,type:raw.type,created:2,sessionID:"child",durable:raw.durable,data:{}})
})
test("persisted records reject extra secret fields and mismatched host IDs", () => {
 const event=normalizeOwnedChildEvent(envelope(),"child")!
 expect(observationRecordSchema.safeParse({kind:"host",id:event.id,event}).success).toBe(true)
 expect(observationRecordSchema.safeParse({kind:"host",id:"fake",event}).success).toBe(false)
 expect(observationRecordSchema.safeParse({kind:"input",id:"local",inboxID:"actual",authorization:"secret"}).success).toBe(false)
})


test("persisted tool input and reasoning bodies cannot masquerade as final text",()=>{
 const event=normalizeOwnedChildEvent(envelope(),"child")!
 for(const type of ["session.tool.input.ended","session.reasoning.ended","session.future.event"]){
  expect(observationRecordSchema.safeParse({kind:"host",id:event.id,event:{...event,type}}).success).toBe(false)
 }
})
