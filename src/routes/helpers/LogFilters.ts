// ─── Log Stream Helpers ─────────────────────────────────────
// Pure pieces of the /logs SSE route: line reassembly, level detection
// for the fleet's logger format, and query → Docker parameter parsing.

import { StringDecoder } from "node:string_decoder";

// Higher numeric value = higher severity. Used for cascade filtering:
// requesting "warn" returns WARN + ERROR (anything >= WARN).
type LogLevel = "DEBUG" | "INFO" | "OK" | "WARN" | "ERROR";

const LOG_LEVEL_SEVERITY: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  OK: 1,
  WARN: 2,
  ERROR: 3,
};

const LEVEL_FILTER_MINIMUM_SEVERITY: Record<string, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// Matches the logger format: [HH:MM:SS] LEVEL  or ANSI-wrapped equivalent.
// After ANSI stripping, the level token appears after "] " as a padded 5-char word.
const LOG_LEVEL_PATTERN = /\]\s+(ERROR|WARN |INFO |OK {3}|DEBUG)\s/;

// oxlint-disable-next-line no-control-regex
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*m/g;

const RELATIVE_TIME_UNIT_SECONDS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
};

export function stripAnsiCodes(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, "");
}

export function extractLogLevel(strippedLine: string): LogLevel | null {
  const match = strippedLine.match(LOG_LEVEL_PATTERN);
  return match ? (match[1].trim() as LogLevel) : null;
}

/** "warn" → 2; anything that isn't a known level → null (no level filter). */
export function minimumSeverityFor(levelFilter: string | null): number | null {
  if (
    !levelFilter ||
    !Object.hasOwn(LEVEL_FILTER_MINIMUM_SEVERITY, levelFilter)
  )
    return null;
  return LEVEL_FILTER_MINIMUM_SEVERITY[levelFilter];
}

/** "5m" / "1 h" / "2d" → the Docker `since` unix timestamp; junk → null. */
export function parseRelativeTimeToUnixSeconds(
  relativeTime: string,
  nowMs: number = Date.now(),
): number | null {
  const match = relativeTime.match(/^(\d+)\s*(s|m|h|d)$/);
  if (!match) return null;
  const offsetSeconds =
    Number.parseInt(match[1], 10) * RELATIVE_TIME_UNIT_SECONDS[match[2]];
  return Math.floor(nowMs / 1000) - offsetSeconds;
}

/**
 * Level + search filter. Lines without a detectable level (stack traces,
 * multiline output) always pass the level filter — they typically belong
 * to the preceding log entry. `searchTerm` must already be lowercased.
 */
export function shouldIncludeLine(
  rawLine: string,
  minimumSeverity: number | null,
  searchTerm: string | null,
): boolean {
  const strippedLine = stripAnsiCodes(rawLine);

  if (minimumSeverity !== null) {
    const detectedLevel = extractLogLevel(strippedLine);
    if (detectedLevel && LOG_LEVEL_SEVERITY[detectedLevel] < minimumSeverity)
      return false;
  }

  return searchTerm === null || strippedLine.toLowerCase().includes(searchTerm);
}

/**
 * Reassembles whole lines per stream. A log line can be split across mux
 * frames and network chunks — and a multi-byte UTF-8 character across
 * either — so bytes are decoded with a streaming decoder and the partial
 * tail is held back until its newline arrives.
 */
export function createLineSplitter() {
  const decoders = new Map<string, StringDecoder>();
  const remainders = new Map<string, string>();

  const decoderFor = (streamSource: string) => {
    let decoder = decoders.get(streamSource);
    if (!decoder) {
      decoder = new StringDecoder("utf8");
      decoders.set(streamSource, decoder);
    }
    return decoder;
  };

  const trimCarriageReturn = (line: string) =>
    line.endsWith("\r") ? line.slice(0, -1) : line;

  return {
    /** Complete lines (CRLF-normalized, empty lines dropped) from one chunk. */
    push(streamSource: string, chunk: Buffer): string[] {
      const text =
        (remainders.get(streamSource) ?? "") +
        decoderFor(streamSource).write(chunk);
      const lines = text.split("\n");
      remainders.set(streamSource, lines.pop() ?? "");
      return lines.map(trimCarriageReturn).filter((line) => line.length > 0);
    },

    /** Whatever partial lines remain once the stream has ended. */
    flush(): Array<{ streamSource: string; line: string }> {
      const flushed: Array<{ streamSource: string; line: string }> = [];
      for (const [streamSource, decoder] of decoders) {
        const line = trimCarriageReturn(
          (remainders.get(streamSource) ?? "") + decoder.end(),
        );
        if (line.length > 0) flushed.push({ streamSource, line });
      }
      remainders.clear();
      decoders.clear();
      return flushed;
    },
  };
}
