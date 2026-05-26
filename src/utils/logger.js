const LOG_LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const resolveLogLevel = () => {
  const raw = String(process.env.LOG_LEVEL || "info").toLowerCase();
  return LOG_LEVELS[raw] || LOG_LEVELS.info;
};

const currentLogLevel = resolveLogLevel();

const emit = (level, scope, message, fields = {}) => {
  if ((LOG_LEVELS[level] || LOG_LEVELS.info) < currentLogLevel) return;

  const payload = {
    level,
    scope,
    message,
    timestamp: new Date().toISOString(),
    ...fields,
  };

  const line = JSON.stringify(payload);

  if (level === "error") {
    console.error(line);
    return;
  }

  if (level === "warn") {
    console.warn(line);
    return;
  }

  console.log(line);
};

export const createLogger = (scope) => ({
  debug: (message, fields) => emit("debug", scope, message, fields),
  info: (message, fields) => emit("info", scope, message, fields),
  warn: (message, fields) => emit("warn", scope, message, fields),
  error: (message, fields) => emit("error", scope, message, fields),
});
