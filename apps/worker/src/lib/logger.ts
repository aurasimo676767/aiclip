type LogFields = Record<string, unknown>;

function format(level: string, message: string, fields?: LogFields): string {
  const ts = new Date().toISOString();
  const suffix = fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : "";
  return `[${ts}] [${level}] ${message}${suffix}`;
}

export const logger = {
  info(message: string, fields?: LogFields) {
    console.log(format("INFO", message, fields));
  },
  warn(message: string, fields?: LogFields) {
    console.warn(format("WARN", message, fields));
  },
  error(message: string, fields?: LogFields) {
    console.error(format("ERROR", message, fields));
  },
};
