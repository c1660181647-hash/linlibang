const path = require("node:path");

function loadConfig(env = process.env) {
  const port = parseInt(env.PORT || "3001", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  return {
    host: env.HOST || "127.0.0.1",
    port,
    dataFile: path.resolve(env.DATA_FILE || path.join("server", "data", "neighborhood.json")),
    staticRoot: path.resolve(env.STATIC_ROOT || "."),
    corsOrigin: env.CORS_ORIGIN || `http://localhost:${port}`,
    logRequests: env.LOG_REQUESTS !== "false",
  };
}

module.exports = { loadConfig };
