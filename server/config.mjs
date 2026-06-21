function numberEnv(env, name, fallback, { min = -Infinity, max = Infinity, integer = false } = {}) {
  const raw = env[name];
  const parsed = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a finite number.`);
  }
  const value = integer ? Math.round(parsed) : parsed;
  if (value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}.`);
  }
  return value;
}

export function loadServerConfig(env = process.env) {
  const profile = env.SERVER_PROFILE ?? "local";
  const production = profile === "production";
  const allowedOrigins = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (production && allowedOrigins.length === 0 && env.REQUIRE_ALLOWED_ORIGINS !== "0") {
    throw new Error("SERVER_PROFILE=production requires ALLOWED_ORIGINS unless REQUIRE_ALLOWED_ORIGINS=0 is set.");
  }
  if (production && !env.SESSION_SECRET && env.REQUIRE_SESSION_SECRET !== "0") {
    throw new Error("SERVER_PROFILE=production requires SESSION_SECRET unless REQUIRE_SESSION_SECRET=0 is set.");
  }

  const config = {
    profile,
    production,
    host: env.HOST ?? (production ? "0.0.0.0" : "127.0.0.1"),
    port: numberEnv(env, "PORT", 8787, { min: 1, max: 65535, integer: true }),
    maxCars: numberEnv(env, "MAX_CARS", 8, { min: 1, max: 16, integer: true }),
    maxRooms: numberEnv(env, "MAX_ROOMS", production ? 4 : 32, { min: 1, max: 512, integer: true }),
    maxClientsPerRoom: numberEnv(env, "MAX_CLIENTS_PER_ROOM", 8, { min: 1, max: 16, integer: true }),
    minRoundTime: numberEnv(env, "MIN_ROUND_TIME", 30, { min: 10, max: 3600, integer: true }),
    maxRoundTime: numberEnv(env, "MAX_ROUND_TIME", 600, { min: 10, max: 7200, integer: true }),
    tickRate: numberEnv(env, "TICK_RATE", 60, { min: 10, max: 120, integer: true }),
    snapshotRate: numberEnv(env, "SNAPSHOT_RATE", 30, { min: 5, max: 60, integer: true }),
    countdownMs: numberEnv(env, "COUNTDOWN_MS", 3000, { min: 0, max: 30000, integer: true }),
    inactiveRoomMs: numberEnv(env, "INACTIVE_ROOM_MS", 10 * 60 * 1000, { min: 5000, max: 24 * 60 * 60 * 1000, integer: true }),
    reconnectGraceMs: numberEnv(env, "RECONNECT_GRACE_MS", 45 * 1000, { min: 0, max: 10 * 60 * 1000, integer: true }),
    allowedOrigins,
    secureHeaders: env.SECURE_HEADERS !== "0",
    sessionSecret: env.SESSION_SECRET ?? "local-development-session-secret",
  };

  if (config.minRoundTime > config.maxRoundTime) {
    throw new Error("MIN_ROUND_TIME must be less than or equal to MAX_ROUND_TIME.");
  }
  if (config.maxClientsPerRoom > config.maxCars) {
    throw new Error("MAX_CLIENTS_PER_ROOM must be less than or equal to MAX_CARS.");
  }
  if (config.snapshotRate > config.tickRate) {
    throw new Error("SNAPSHOT_RATE must be less than or equal to TICK_RATE.");
  }

  return config;
}
