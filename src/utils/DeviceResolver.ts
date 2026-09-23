import os from "node:os";
import { DEVICES } from "../config.ts";
import type { DeviceEntry } from "../types.ts";

// Host network addresses can change under a running process (DHCP lease,
// Docker network recreate), so the mapping is rebuilt on this cadence
// even when the registry itself hasn't changed.
const REFRESH_INTERVAL_MS = 5 * 60_000;

/** Non-internal IP addresses of the machine this process runs on. */
function localIpAddresses(): Set<string> {
  const addresses = new Set<string>();
  for (const interfaceDetails of Object.values(os.networkInterfaces())) {
    for (const addressDetails of interfaceDetails ?? []) {
      if (!addressDetails.internal) addresses.add(addressDetails.address);
    }
  }
  return addresses;
}

/**
 * Maps registry URLs onto device names and rewrites health probes for
 * services on this same device to go through localhost. Rebuilt whenever
 * the registry hot-reloads (initializeRegistry swaps the DEVICES object)
 * and at least every REFRESH_INTERVAL_MS.
 */
export class DeviceResolver {
  private static localDeviceKey: string | null = null;
  private static hostnameToDeviceMap = new Map<string, string>();
  private static builtFromDevices: Record<string, DeviceEntry> | null = null;
  private static builtAtMs = 0;

  private static refreshIfStale(nowMs: number = Date.now()): void {
    if (
      this.builtFromDevices === DEVICES &&
      nowMs - this.builtAtMs < REFRESH_INTERVAL_MS
    )
      return;

    const addresses = localIpAddresses();
    this.localDeviceKey = this.detectLocalDevice(addresses);
    this.hostnameToDeviceMap = this.buildHostnameToDeviceMap(addresses);
    this.builtFromDevices = DEVICES;
    this.builtAtMs = nowMs;
  }

  /** Test hook — forces the next lookup to rebuild. */
  public static _resetForTests(): void {
    this.builtFromDevices = null;
    this.builtAtMs = 0;
  }

  public static getLocalDeviceKey(): string | null {
    this.refreshIfStale();
    return this.localDeviceKey;
  }

  public static deriveHost(
    targetUrl: string | null | undefined,
    deviceKey: string | null | undefined,
  ): string {
    this.refreshIfStale();
    const fallbackDeviceName =
      (deviceKey && DEVICES[deviceKey]?.name) || deviceKey || "Unknown";

    if (!targetUrl) {
      return fallbackDeviceName;
    }

    try {
      return (
        this.hostnameToDeviceMap.get(new URL(targetUrl).hostname) ||
        fallbackDeviceName
      );
    } catch {
      return fallbackDeviceName;
    }
  }

  public static toLocalHealthUrl(
    targetUrl: string,
    deviceKey: string | null | undefined,
  ): string {
    this.refreshIfStale();
    if (!this.localDeviceKey || deviceKey !== this.localDeviceKey) {
      return targetUrl;
    }

    try {
      const parsedUrl = new URL(targetUrl);
      parsedUrl.hostname = "localhost";
      return parsedUrl.toString().replace(/\/$/, "");
    } catch {
      return targetUrl;
    }
  }

  private static detectLocalDevice(addresses: Set<string>): string | null {
    for (const [deviceKey, deviceEntry] of Object.entries(DEVICES)) {
      if (deviceEntry.hostname && addresses.has(deviceEntry.hostname)) {
        return deviceKey;
      }
    }
    return null;
  }

  private static buildHostnameToDeviceMap(
    addresses: Set<string>,
  ): Map<string, string> {
    const mapping = new Map<string, string>();

    for (const deviceEntry of Object.values(DEVICES)) {
      if (deviceEntry.hostname) {
        mapping.set(deviceEntry.hostname, deviceEntry.name);
      }
    }

    const localDevice = this.localDeviceKey
      ? DEVICES[this.localDeviceKey]
      : undefined;
    if (localDevice) {
      mapping.set("localhost", localDevice.name);
      mapping.set("127.0.0.1", localDevice.name);
      for (const address of addresses) {
        mapping.set(address, localDevice.name);
      }
    }

    return mapping;
  }
}
