// ─── External API Usage Periods ─────────────────────────────

import { MILLISECONDS_PER_DAY } from "@rodrigo-barraza/utilities-library";

const USAGE_PERIODS = ["7d", "14d", "30d", "90d"];
const DEFAULT_USAGE_PERIOD = "30d";

/** Any query value → one of USAGE_PERIODS (junk falls back to 30d, so cache keys stay bounded). */
export function sanitizeUsagePeriod(period: unknown): string {
  return typeof period === "string" && USAGE_PERIODS.includes(period)
    ? period
    : DEFAULT_USAGE_PERIOD;
}

export function usagePeriodDays(period: string): number {
  const match = /^(\d+)d$/.exec(period);
  return match ? Number.parseInt(match[1], 10) : 30;
}

/** Start of the usage window as an ISO timestamp. */
export function usagePeriodStart(
  period: string,
  nowMs: number = Date.now(),
): Date {
  return new Date(nowMs - usagePeriodDays(period) * MILLISECONDS_PER_DAY);
}
