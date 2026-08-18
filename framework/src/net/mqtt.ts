import type {
  NetworkData,
  NetworkLimitOverrides,
  TlsOptions,
  URL,
} from "./index.ts";
import { unsupportedNetworkPromise } from "./internal.ts";

export {
  AbortController,
  AbortSignal,
  NetworkError,
  URL,
} from "./index.ts";
export type {
  NetworkAddress,
  NetworkData,
  NetworkErrorCategory,
  NetworkErrorCode,
  NetworkErrorOptions,
  NetworkLimit,
  NetworkLimitOverrides,
  NetworkLimits,
  NetworkProtocol,
  NetworkRole,
  TlsOptions,
} from "./index.ts";

export type MqttQos = 0 | 1;

export type MqttMessageInfo =
  | {
    readonly qos: 0;
    readonly retain: boolean;
    readonly dup: boolean;
    readonly packetId?: never;
  }
  | {
    readonly qos: 1;
    readonly retain: boolean;
    readonly dup: boolean;
    readonly packetId: number;
  };

export interface PublishOptions {
  readonly qos?: MqttQos;
  readonly retain?: boolean;
}

export interface Subscription {
  readonly filter: string;
  readonly qos?: MqttQos;
}

export interface SubscribeOptions {
  readonly qos?: MqttQos;
}

export type SubscriptionResult =
  | {
    readonly filter: string;
    readonly grantedQos: MqttQos;
  }
  | {
    readonly filter: string;
    readonly grantedQos: null;
    readonly reasonCode: number;
  };

export interface MqttWill {
  readonly topic: string;
  readonly payload: NetworkData;
  readonly qos?: MqttQos;
  readonly retain?: boolean;
}

export interface MqttReconnectOptions {
  readonly enabled: boolean;
  readonly minDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly multiplier?: number;
  readonly jitter?: number;
  readonly maxAttempts?: number;
  readonly resubscribe?: boolean;
}

export interface MqttConnectInfo {
  readonly reconnected: boolean;
  readonly sessionPresent: boolean;
  readonly resubscribed?: boolean;
}

export interface MqttHandlers {
  readonly connect?: (client: MqttClient, info: MqttConnectInfo) => void;
  readonly message?: (
    client: MqttClient,
    topic: string,
    payload: Uint8Array,
    packet: MqttMessageInfo,
  ) => void;
  readonly disconnect?: (
    client: MqttClient,
    reason: import("./index.ts").NetworkError,
  ) => void;
  readonly reconnect?: (client: MqttClient, attempt: number, delayMs: number) => void;
  readonly drain?: (client: MqttClient) => void;
  readonly error?: (
    client: MqttClient,
    error: import("./index.ts").NetworkError,
  ) => void;
}

export interface MqttConnectOptions {
  readonly url: string | URL;
  readonly clientId: string;
  readonly username?: string;
  readonly password?: NetworkData;
  readonly cleanSession?: boolean;
  readonly keepAliveSeconds?: number;
  readonly pingResponseTimeoutMs?: number;
  readonly ackTimeoutMs?: number;
  readonly will?: MqttWill;
  readonly reconnect?: MqttReconnectOptions;
  readonly tls?: TlsOptions;
  readonly limits?: NetworkLimitOverrides;
  readonly ref?: boolean;
  readonly mqtt: MqttHandlers;
}

export interface MqttClient {
  publish(topic: string, payload: NetworkData, options?: PublishOptions): Promise<void>;
  subscribe(
    filter: string | readonly Subscription[],
    options?: SubscribeOptions,
  ): Promise<readonly SubscriptionResult[]>;
  unsubscribe(filter: string | readonly string[]): Promise<void>;
  end(options?: { readonly force?: boolean; readonly timeoutMs?: number }): Promise<void>;
  ref(): this;
  unref(): this;
}

export function connect(_options: MqttConnectOptions): Promise<MqttClient> {
  return unsupportedNetworkPromise("mqtt.connect", "mqtt");
}
