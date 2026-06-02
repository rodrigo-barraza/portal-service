export class DateHelpers {
  public static parseRangeToMilliseconds(rangeString: string): number {
    const matches = rangeString.match(/^(\d+)(m|h|d)$/);
    if (!matches) {
      return 60 * 60 * 1000; // Default to 1 hour in milliseconds
    }

    const numericValue = parseInt(matches[1], 10);
    const unitOfTime = matches[2];

    switch (unitOfTime) {
      case "m":
        return numericValue * 60 * 1000;
      case "h":
        return numericValue * 60 * 60 * 1000;
      case "d":
        return numericValue * 24 * 60 * 60 * 1000;
      default:
        return 60 * 60 * 1000;
    }
  }
}
