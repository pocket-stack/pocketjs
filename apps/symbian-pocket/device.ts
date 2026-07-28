export interface DeviceEvent<T = unknown> {
  id: number;
  type: string;
  ok: boolean;
  data?: T;
  error?: string;
}

export interface SensorSnapshot {
  language: "zh" | "en";
  uptimeMs: number;
  heapInternal: number;
  heapPsram: number;
  lightRaw: number;
  temperatureC: number;
  accel: [number, number, number];
  gyro: [number, number, number];
  pitch: number;
  roll: number;
  imuAvailable: boolean;
  controllerAvailable: boolean;
  wifiConnected: boolean;
  wifiSsid: string;
  wifiRssi: number;
  bluetoothReady: boolean;
  sdMounted: boolean;
  sdBytes: number;
  outputsUnlocked: boolean;
  outputLeaseMs: number;
}

interface NativeDevice {
  command(name: string, json: string): number;
  poll(): string;
  snapshot(): string;
}

const fallbackSnapshot: SensorSnapshot = {
  language: "zh",
  uptimeMs: 0,
  heapInternal: 0,
  heapPsram: 0,
  lightRaw: 0,
  temperatureC: 0,
  accel: [0, 0, 1],
  gyro: [0, 0, 0],
  pitch: 0,
  roll: 0,
  imuAvailable: false,
  controllerAvailable: false,
  wifiConnected: false,
  wifiSsid: "",
  wifiRssi: -127,
  bluetoothReady: false,
  sdMounted: false,
  sdBytes: 0,
  outputsUnlocked: false,
  outputLeaseMs: 0,
};

function native(): NativeDevice | undefined {
  return (globalThis as { device?: NativeDevice }).device;
}

export function command(name: string, payload: unknown = {}): number {
  return native()?.command(name, JSON.stringify(payload)) ?? -1;
}

export function pollEvents(): DeviceEvent[] {
  const line = native()?.poll();
  if (!line) return [];
  try {
    const parsed = JSON.parse(line) as DeviceEvent | DeviceEvent[];
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

export function sensorSnapshot(): SensorSnapshot {
  const json = native()?.snapshot();
  if (!json) return fallbackSnapshot;
  try {
    return { ...fallbackSnapshot, ...(JSON.parse(json) as Partial<SensorSnapshot>) };
  } catch {
    return fallbackSnapshot;
  }
}
