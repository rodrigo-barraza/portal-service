// ============================================================
// API — Colorized Console Logger
// ============================================================
// Same pattern used across Prism, Tools API, Sessions.
// ============================================================

const COLORS = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

function timestamp() {
  return new Date().toISOString().slice(11, 23);
}

const logger = {
  info: (...args) =>
    console.log(`${COLORS.gray}${timestamp()}${COLORS.reset} ${COLORS.blue}INFO${COLORS.reset}`, ...args),
  success: (...args) =>
    console.log(`${COLORS.gray}${timestamp()}${COLORS.reset} ${COLORS.green}OK${COLORS.reset}  `, ...args),
  warn: (...args) =>
    console.warn(`${COLORS.gray}${timestamp()}${COLORS.reset} ${COLORS.yellow}WARN${COLORS.reset}`, ...args),
  error: (...args) =>
    console.error(`${COLORS.gray}${timestamp()}${COLORS.reset} ${COLORS.red}ERR${COLORS.reset} `, ...args),
  debug: (...args) =>
    console.log(`${COLORS.gray}${timestamp()}${COLORS.reset} ${COLORS.magenta}DBG${COLORS.reset} `, ...args),
};

export default logger;
