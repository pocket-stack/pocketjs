// Public support types shared by every network module.
// Values cross the boundary as
// JSON; the types keep one object identity across `@pocketjs/framework/net`
// and its protocol subpaths.

import type { HttpdLimits } from "../../../contracts/spec/httpd.ts";
import type { NetLimits } from "../../../contracts/spec/net.ts";
import type { WsLimits } from "../../../contracts/spec/ws.ts";

export type NetworkData = string | ArrayBuffer | ArrayBufferView;

export type NetworkAddress = {
  family: "ipv4" | "ipv6";
  address: string;
  port: number;
};

export type TlsOptions = {
  serverName?: string;
  minVersion?: "1.2" | "1.3";
  maxVersion?: "1.2" | "1.3";
  alpn?: readonly string[];
  ca?: Uint8Array;
  credential?: string;
  clientCertificate?: "none" | "optional" | "required";
  verification?: "full" | "development-insecure";
  revocation?: "host-default" | "required";
};

/** The frozen `getNetworkLimits()` snapshot: one entry per mounted module,
 * null where the host did not mount the namespace. */
export type NetworkLimits = Readonly<{
  httpClient: Readonly<NetLimits> | null;
  httpServer: Readonly<HttpdLimits> | null;
  websocketClient: Readonly<WsLimits> | null;
}>;
