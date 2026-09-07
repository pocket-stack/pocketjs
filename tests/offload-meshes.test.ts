import { expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { createOffloadClient } from "../framework/src/offload.ts";
import { createOffloadMeshCollection } from "../framework/src/resource-offload.ts";
import { createResourceRuntime, createResourceView } from "../framework/src/resource-view.ts";
import { encodeOffloadMesh, validateMesh, prepareMesh } from "../tools/offload-wire.ts";
import { dispatchOffload } from "../tools/offload-provider.ts";
const mesh = () => {
  const bytes = new Uint8Array(16);
  bytes.set([80, 77, 72, 49, 0, 1, 0, 1]);
  return { format: "mesh2d-v1" as const, bytes };
};
test("prepared mesh protocol requires explicit kind and validates every truncated entry", async () => {
  const m = mesh(),
    wire = encodeOffloadMesh(3, m);
  expect(wire.readUInt32BE()).toBe(0x80000018);
  expect(wire.toString("ascii", 4, 8)).toBe("PMSH");
  expect(validateMesh(m.bytes)).toEqual({ width: 256, height: 256, bytes: 16 });
  for (let n = 0; n < 16; n++) expect(() => validateMesh(m.bytes.slice(0, n))).toThrow();
  for (const at of [0, 9, 10, 12]) {
    const b = m.bytes.slice();
    b[at] = 255;
    expect(() => validateMesh(b)).toThrow();
  }
  const request = { v: 1 as const, id: 1, method: "map.mesh", payload: "{}" };
  expect(await dispatchOffload({ "map.mesh": () => m }, request)).toHaveProperty("error");
  expect(await dispatchOffload({ "map.mesh": () => m }, { ...request, response: "image" })).toHaveProperty("error");
  expect(await dispatchOffload({ "map.mesh": () => m }, { ...request, response: "mesh" })).toHaveProperty("mesh", m);
});
test("mesh cancellation, stale sessions, mismatched kinds and duplicate binary tickets release staging", () => {
  let session = 1;
  const replies: string[] = [],
    released: number[] = [];
  let deliveries = 0;
  const client = createOffloadClient({
    session: () => session,
    submit: () => true,
    take: () => replies.shift(),
    uploadMesh: () => 1,
    releaseMesh: (t) => released.push(t),
    uploadImage: () => 2,
    releaseImage: (t) => released.push(t),
  });
  const ticket = (token: number) => ({ token, width: 256, height: 256, bytes: 16 });
  const id = client.requestMesh("tile", "{}", () => deliveries++);
  client.step();
  client.cancel(id);
  replies.push(JSON.stringify({ id, mesh: ticket(8) }));
  client.step();
  expect(deliveries).toBe(0);
  const wrong = client.requestImage("tile", "{}", (r) => {
    expect(r.ok).toBe(false);
    deliveries++;
  });
  client.step();
  replies.push(JSON.stringify({ id: wrong, mesh: ticket(16) }));
  client.step();
  const stale = client.requestMesh("tile", "{}", () => deliveries++);
  client.step();
  session = 2;
  replies.push(JSON.stringify({ id: stale, mesh: ticket(24) }));
  client.step();
  const both = client.requestMesh("tile", "{}", (r) => expect(r.ok).toBe(false));
  client.step();
  replies.push(JSON.stringify({ id: both, mesh: ticket(32), image: ticket(40) }));
  client.step();
  expect(released).toEqual([8, 16, 24, 40, 32]);
  expect(client.pending()).toBe(0);
  expect(deliveries).toBe(2);
});
test("mesh collection owns staging through failed materialization and withdrawn demand", () =>
  createRoot((dispose) => {
    const replies: string[] = [],
      sent: string[] = [],
      released: number[] = [];
    let uploads = 0,
      wanted = true;
    const client = createOffloadClient({
      session: () => 1,
      submit: (r) => {
        sent.push(r);
        return true;
      },
      take: () => replies.shift(),
      uploadMesh: () => {
        uploads++;
        return -1;
      },
      releaseMesh: (t) => released.push(t),
    });
    const runtime = createResourceRuntime({
      maxCollections: 1,
      maxConcurrent: 1,
      startsPerFrame: 1,
      completionsPerFrame: 1,
    });
    const collection = createOffloadMeshCollection(runtime, client, {
      key: (s: string) => s,
      method: "mesh",
      payload: (s) => s,
      maxEntries: 2,
      maxViews: 1,
      retry: { attempts: 1, delayFrames: 1, maxDelayFrames: 1 },
    });
    createResourceView(collection, { demand: () => (wanted ? [{ input: "a", priority: 0 }] : []) });
    runtime.step();
    client.step();
    replies.push(
      JSON.stringify({ id: JSON.parse(sent[0]).id, mesh: { token: 8, width: 256, height: 256, bytes: 16 } }),
    );
    client.step();
    runtime.step();
    expect(uploads).toBe(1);
    expect(released).toEqual([8]);
    collection.invalidate();
    runtime.step();
    client.step();
    replies.push(
      JSON.stringify({ id: JSON.parse(sent[1]).id, mesh: { token: 16, width: 256, height: 256, bytes: 16 } }),
    );
    client.step();
    wanted = false;
    runtime.step();
    expect(uploads).toBe(1);
    expect(released).toEqual([8, 16]);
    dispose();
    client.dispose();
  }));

test("throwing response callbacks cannot strand native mesh staging", () => {
  const replies: string[] = [], released: number[] = [];
  const client = createOffloadClient({ session: () => 1, submit: () => true, take: () => replies.shift(), uploadMesh: () => 1, releaseMesh: token => released.push(token) });
  const id = client.requestMesh("mesh", "{}", () => { throw new Error("consumer failed"); });
  client.step(); replies.push(JSON.stringify({ id, mesh: { token: 8, width: 256, height: 256, bytes: 16 } })); client.step();
  expect(released).toEqual([8]); expect(client.pending()).toBe(0);
});

test("provider mesh packing quantizes logical units and rejects narrowing overflow", () => {
  const input={width:256,height:256,vertices:[[0,0],[256,0],[.1,256]] as const,triangles:[[0,1,2,0xff123456]] as const};
  const bytes=prepareMesh(input).bytes;expect(validateMesh(bytes).bytes).toBe(38);expect(new DataView(bytes.buffer).getUint16(24,true)).toBe(2);
  for(const index of [-1,.5,3,65536,NaN])expect(()=>prepareMesh({...input,triangles:[[0,1,index,0xff123456]]})).toThrow();
  for(const color of [-1,.5,0x100000000,Infinity])expect(()=>prepareMesh({...input,triangles:[[0,1,2,color]]})).toThrow();
  for(const x of [-1,257,Infinity,NaN])expect(()=>prepareMesh({...input,vertices:[[x,0]]})).toThrow();
});
