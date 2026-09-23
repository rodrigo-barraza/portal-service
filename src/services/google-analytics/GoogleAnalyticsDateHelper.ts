const PRESET_PERIODS = new Set(["7d", "30d", "90d"]);
const DEFAULT_PRESET_DAYS = 30;

/** "7d" → 7; unknown presets read as the 30-day default. */
function presetDays(periodString: string): number {
  return PRESET_PERIODS.has(periodString)
    ? Number.parseInt(periodString, 10)
    : DEFAULT_PRESET_DAYS;
}
const CUSTOM_RANGE_PATTERN = /^(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})$/;

/** A real calendar day — "2026-02-31" parses in JS (as March 3rd) but isn't one. */
function isCalendarDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

/** 7d / 30d / 90d, or YYYY-MM-DD_YYYY-MM-DD of real dates with start ≤ end. */
export function isValidAnalyticsPeriod(period: string): boolean {
  if (PRESET_PERIODS.has(period)) return true;
  const match = CUSTOM_RANGE_PATTERN.exec(period);
  return Boolean(
    match &&
    isCalendarDate(match[1]) &&
    isCalendarDate(match[2]) &&
    match[1] <= match[2],
  );
}

export class GoogleAnalyticsDateHelper {
  /**
   * An N-day preset is N calendar days ending today: `(N-1)daysAgo → today`.
   * (`NdaysAgo → today` spanned N+1 days — an extra day the sessions-service
   * "7d"/"30d" windows don't have, which skewed the GA-vs-first-party
   * comparison.)
   */
  public static periodToDateRange(periodString: string = "30d"): {
    startDate: string;
    endDate: string;
  } {
    if (periodString.includes("_")) {
      const [startDate, endDate] = periodString.split("_");
      if (startDate && endDate) {
        return {
          startDate,
          endDate,
        };
      }
    }

    return {
      startDate: `${presetDays(periodString) - 1}daysAgo`,
      endDate: "today",
    };
  }

  public static previousPeriodRange(periodString: string = "30d"): {
    startDate: string;
    endDate: string;
  } {
    if (periodString.includes("_")) {
      const [startDateString, endDateString] = periodString.split("_");
      if (startDateString && endDateString) {
        const startDate = new Date(startDateString);
        const endDate = new Date(endDateString);
        const millisecondsDifference = endDate.getTime() - startDate.getTime();

        const previousEndDate = new Date(
          startDate.getTime() - 24 * 60 * 60 * 1000,
        );
        const previousStartDate = new Date(
          previousEndDate.getTime() - millisecondsDifference,
        );

        const formatDate = (date: Date) => date.toISOString().split("T")[0];
        return {
          startDate: formatDate(previousStartDate),
          endDate: formatDate(previousEndDate),
        };
      }
    }

    // The N days immediately before the current window `(N-1)daysAgo → today`.
    const daysCount = presetDays(periodString);
    return {
      startDate: `${daysCount * 2 - 1}daysAgo`,
      endDate: `${daysCount}daysAgo`,
    };
  }
}
