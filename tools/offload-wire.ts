import {
  OFFLOAD,
  OFFLOAD_IMAGE,
  OFFLOAD_MESH,
  type OffloadMesh,
  type OffloadImage,
} from "../contracts/spec/offload.ts";

export function encodeOffloadImage(id: number, image: OffloadImage): Buffer {
  const valid = (n: number) => Number.isInteger(n) && n >= 16 && n <= OFFLOAD_IMAGE.maxSide && (n & (n - 1)) === 0;
  if (
    !Number.isSafeInteger(id) ||
    id < 1 ||
    id > 0xffffffff ||
    !valid(image.width) ||
    !valid(image.height) ||
    image.format !== "r5g6b5" ||
    !(image.pixels instanceof Uint8Array) ||
    image.pixels.byteLength !== image.width * image.height * 2
  )
    throw new Error("Invalid offload image envelope");
  const bytes = Buffer.allocUnsafe(4 + OFFLOAD_IMAGE.headerBytes + image.pixels.byteLength);
  bytes.writeUInt32BE((OFFLOAD_IMAGE.flag + bytes.length - 4) >>> 0);
  bytes.write("PIMG", 4);
  bytes.writeUInt32LE(id, 8);
  bytes.writeUInt16LE(image.width, 12);
  bytes.writeUInt16LE(image.height, 14);
  bytes.writeUInt32LE(0, 16);
  bytes.set(image.pixels, 20);
  return bytes;
}

export function encodeOffloadRecord(record: string): Buffer {
  const payload = Buffer.from(record);
  if (!payload.length || payload.length > OFFLOAD.recordBytes) throw new Error("Offload record budget exceeded");
  const out = Buffer.allocUnsafe(payload.length + 4);
  out.writeUInt32BE(payload.length);
  payload.copy(out, 4);
  return out;
}
/** Fixed allocation, including partial headers and arbitrarily split UTF-8. */
export class OffloadDecoder {
  private bytes = Buffer.alloc(OFFLOAD.recordBytes + 4);
  private have = 0;
  private want = 4;
  /** A false continueReading pauses after a complete record. The caller retains
   * the unconsumed suffix and resumes it when downstream credit returns. */
  push(chunk: Uint8Array, deliver: (record: string) => void, continueReading?: () => boolean): number {
    let offset = 0;
    while (offset < chunk.length) {
      const n = Math.min(chunk.length - offset, this.want - this.have);
      this.bytes.set(chunk.subarray(offset, offset + n), this.have);
      this.have += n;
      offset += n;
      if (this.have !== this.want) continue;
      if (this.want === 4) {
        const size = this.bytes.readUInt32BE();
        if (!size || size > OFFLOAD.recordBytes) throw new Error("Invalid offload frame length");
        this.want = size + 4;
      } else {
        const record = this.bytes.toString("utf8", 4, this.want);
        this.have = 0;
        this.want = 4;
        deliver(record);
        if (continueReading && !continueReading()) break;
      }
    }
    return offset;
  }
}

export function validateMesh(bytes: Uint8Array) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 16 || bytes.length > OFFLOAD_MESH.maxBytes)
    throw new Error("Invalid mesh size");
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = v.getUint16(4, true),
    height = v.getUint16(6, true),
    nv = v.getUint16(8, true),
    nt = v.getUint16(10, true);
  if (
    v.getUint32(0, true) !== 0x31484d50 ||
    v.getUint32(12, true) ||
    !width ||
    !height ||
    width > 4095 ||
    height > 4095 ||
    nv > OFFLOAD_MESH.maxVertices ||
    nt > OFFLOAD_MESH.maxTriangles ||
    bytes.length !== 16 + nv * 4 + nt * 10
  )
    throw new Error("Invalid mesh envelope");
  for (let i = 0; i < nv; i++)
    if (v.getUint16(16 + i * 4, true) > width * 16 || v.getUint16(18 + i * 4, true) > height * 16)
      throw new Error("Invalid mesh coordinate");
  for (let i = 0; i < nt; i++)
    for (let j = 0; j < 3; j++)
      if (v.getUint16(16 + nv * 4 + i * 10 + j * 2, true) >= nv) throw new Error("Invalid mesh index");
  return { width, height, bytes: bytes.length };
}
export function encodeOffloadMesh(id: number, mesh: OffloadMesh): Buffer {
  if (!Number.isSafeInteger(id) || id < 1 || id > 0xffffffff || mesh.format !== "mesh2d-v1")
    throw new Error("Invalid mesh response");
  validateMesh(mesh.bytes);
  const bytes = Buffer.allocUnsafe(12 + mesh.bytes.length);
  bytes.writeUInt32BE((OFFLOAD_IMAGE.flag + bytes.length - 4) >>> 0);
  bytes.write("PMSH", 4);
  bytes.writeUInt32LE(id, 8);
  bytes.set(mesh.bytes, 12);
  return bytes;
}

/** Host-only packing of already clipped/tessellated geometry in logical units.
 * Topology and style stay with the capability; the wire layout stays here. */
export function prepareMesh(input: {
  width: number;
  height: number;
  vertices: readonly (readonly [number, number])[];
  triangles: readonly (readonly [number, number, number, number])[];
}): OffloadMesh {
  const { width, height, vertices, triangles } = input;
  if (![width, height].every(n => Number.isInteger(n) && n > 0 && n <= 4095) ||
      vertices.length > OFFLOAD_MESH.maxVertices || triangles.length > OFFLOAD_MESH.maxTriangles)
    throw new Error("Invalid prepared mesh dimensions or counts");
  const bytes = new Uint8Array(16 + vertices.length * 4 + triangles.length * 10);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x31484d50, true);
  for (const [at, n] of [[4, width], [6, height], [8, vertices.length], [10, triangles.length]]) view.setUint16(at, n, true);
  for (let i = 0; i < vertices.length; i++) {
    const [x,y] = vertices[i];
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > width || y > height) throw new Error("Invalid prepared mesh coordinate");
    view.setUint16(16 + i * 4, Math.round(x * 16), true); view.setUint16(18 + i * 4, Math.round(y * 16), true);
  }
  for (let i = 0; i < triangles.length; i++) {
    const triangle = triangles[i], at = 16 + vertices.length * 4 + i * 10;
    if (!Number.isInteger(triangle[3]) || triangle[3] < 0 || triangle[3] > 0xffffffff) throw new Error("Invalid prepared mesh color");
    for (let j = 0; j < 3; j++) {
      const index = triangle[j];
      if (!Number.isInteger(index) || index < 0 || index >= vertices.length) throw new Error("Invalid prepared mesh index");
      view.setUint16(at + j * 2, index, true);
    }
    view.setUint32(at + 6, triangle[3], true);
  }
  return { format: "mesh2d-v1", bytes };
}
