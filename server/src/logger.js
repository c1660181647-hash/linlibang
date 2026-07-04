function write(level, event, fields = {}) {
  const record = {
    level,
    event,
    time: new Date().toISOString(),
    ...fields,
  };
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

const logger = {
  info: (event, fields) => write("info", event, fields),
  warn: (event, fields) => write("warn", event, fields),
  error: (event, fields) => write("error", event, fields),
};

module.exports = { logger };
