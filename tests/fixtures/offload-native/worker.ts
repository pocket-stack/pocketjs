import { dispatchOffload } from "../../../tools/offload-provider.ts";
declare const self: { onmessage: (event: MessageEvent) => void; postMessage(value: unknown): void };
self.onmessage = async event => {
  if (event.data.init) return;
  self.postMessage(await dispatchOffload({
    "test.image": () => ({ width: 256, height: 256, pixels: Uint8Array.from({ length: 256 * 256 * 2 }, (_, n) => n & 255), format: "r5g6b5" }),
    "test.mesh": () => {
      const bytes=new Uint8Array(36880),v=new DataView(bytes.buffer);bytes.set([80,77,72,49,0,1,0,1]);v.setUint16(8,4096,true);v.setUint16(10,2048,true);
      for(let i=0;i<4096;i++){v.setUint16(16+i*4,i,true);v.setUint16(18+i*4,4096-i,true);}
      for(let i=0;i<2048;i++){const p=16+4096*4+i*10;for(let j=0;j<3;j++)v.setUint16(p+j*2,i+j,true);v.setUint32(p+6,0xff123456,true);}
      return {format:"mesh2d-v1",bytes};
    },
    "test.text": () => "network-ok",
  }, event.data));
};
