import os from "os";
import { DEVICES } from "../config.ts";

export class DeviceResolver {
  private static localDeviceKey: string | null = null;
  private static hostnameToDeviceMap: Map<string, string> = new Map();
  private static isInitialized = false;

  public static initialize(): void {
    if (this.isInitialized) return;

    this.localDeviceKey = this.detectLocalDevice();
    this.hostnameToDeviceMap = this.buildHostnameToDeviceMap();
    this.isInitialized = true;
  }

  public static getLocalDeviceKey(): string | null {
    this.initialize();
    return this.localDeviceKey;
  }

  public static deriveHost(targetUrl: string | null | undefined, deviceKey: string | null | undefined): string {
    this.initialize();
    const fallbackDeviceName = (deviceKey && DEVICES[deviceKey]?.name) || deviceKey || "Unknown";

    if (!targetUrl) {
      return fallbackDeviceName;
    }

    try {
      const parsedUrl = new URL(targetUrl);
      return this.hostnameToDeviceMap.get(parsedUrl.hostname) || fallbackDeviceName;
    } catch {
      return fallbackDeviceName;
    }
  }

  public static toLocalHealthUrl(targetUrl: string, deviceKey: string | null | undefined): string {
    this.initialize();
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

  private static detectLocalDevice(): string | null {
    const networkInterfaces = os.networkInterfaces();
    const localIpAddresses = new Set<string>();

    for (const interfaceDetails of Object.values(networkInterfaces)) {
      if (!interfaceDetails) continue;
      for (const addressDetails of interfaceDetails) {
        if (!addressDetails.internal) {
          localIpAddresses.add(addressDetails.address);
        }
      }
    }

    for (const [deviceKey, deviceEntry] of Object.entries(DEVICES)) {
      if (deviceEntry.hostname && localIpAddresses.has(deviceEntry.hostname)) {
        return deviceKey;
      }
    }

    return null;
  }

  private static buildHostnameToDeviceMap(): Map<string, string> {
    const mapping = new Map<string, string>();

    for (const deviceEntry of Object.values(DEVICES)) {
      if (deviceEntry.hostname) {
        mapping.set(deviceEntry.hostname, deviceEntry.name);
      }
    }

    if (this.localDeviceKey && DEVICES[this.localDeviceKey]) {
      const localDeviceName = DEVICES[this.localDeviceKey].name;
      mapping.set("localhost", localDeviceName);
      mapping.set("127.0.0.1", localDeviceName);

      const networkInterfaces = os.networkInterfaces();
      for (const interfaceDetails of Object.values(networkInterfaces)) {
        if (!interfaceDetails) continue;
        for (const addressDetails of interfaceDetails) {
          if (!addressDetails.internal) {
            mapping.set(addressDetails.address, localDeviceName);
          }
        }
      }
    }

    return mapping;
  }
}
