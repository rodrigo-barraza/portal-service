export class GoogleAnalyticsDateHelper {
  public static periodToDateRange(periodString: string = "30d"): {
    startDate: string;
    endDate: string;
  } {
    const presetMap: Record<string, string> = {
      "7d": "7daysAgo",
      "30d": "30daysAgo",
      "90d": "90daysAgo",
    };

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
      startDate: presetMap[periodString] || "30daysAgo",
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

        const previousEndDate = new Date(startDate.getTime() - 24 * 60 * 60 * 1000);
        const previousStartDate = new Date(
          previousEndDate.getTime() - millisecondsDifference
        );

        const formatDate = (date: Date) => date.toISOString().split("T")[0];
        return {
          startDate: formatDate(previousStartDate),
          endDate: formatDate(previousEndDate),
        };
      }
    }

    const daysCount = parseInt(periodString, 10) || 30;
    return {
      startDate: `${daysCount * 2}daysAgo`,
      endDate: `${daysCount + 1}daysAgo`,
    };
  }
}
