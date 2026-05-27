import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";
import { createLogger } from "./utils/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const seedFile = path.join(__dirname, "data", "seed.json");
const port = Number(process.env.PORT || 4000);
const isProduction = process.env.NODE_ENV === "production";
const isRailway = Boolean(
  process.env.RAILWAY_ENVIRONMENT_ID ||
  process.env.RAILWAY_ENVIRONMENT_NAME ||
  process.env.RAILWAY_PROJECT_ID ||
  process.env.RAILWAY_SERVICE_ID ||
  process.env.RAILWAY_DEPLOYMENT_ID ||
  process.env.RAILWAY_STATIC_URL ||
  process.env.RAILWAY_PUBLIC_DOMAIN,
);
const configuredMongoUri = process.env.MONGODB_URI?.trim() || "";
const canUseLocalMongoFallback = !isProduction && !isRailway;
const mongoUri =
  configuredMongoUri ||
  (canUseLocalMongoFallback ? "mongodb://127.0.0.1:27017" : "");
const dbName = process.env.MONGODB_DB || "riohotels";
const adminUsername = process.env.ADMIN_USERNAME || "admin";
const adminPassword = process.env.ADMIN_PASSWORD || "gir@123";
const logger = createLogger("server");

const client = new MongoClient(mongoUri);
let db;
let shuttingDown = false;

const json = (res, status, body) => {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  res.end(JSON.stringify(body));
};

const readBody = async (req) =>
  new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });

const formatDisplayDate = (value) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return value;

  const [, year, month, day] = match;
  return `${day}/${month}/${year}`;
};

const bookingFields = [
  "resortId",
  "guestName",
  "mobile",
  "checkIn",
  "checkOut",
  "persons",
  "children",
  "childPrice",
  "roomNumber",
  "bookingType",
  "price",
  "advance",
  "paymentStatus",
  "notes",
  "deleted",
];

const hallFields = [
  "resortId",
  "hallName",
  "eventName",
  "hostName",
  "mobile",
  "date",
  "checkIn",
  "checkOut",
  "persons",
  "children",
  "childPrice",
  "bookingType",
  "price",
  "advance",
  "paymentStatus",
  "notes",
];

const pick = (source, fields) =>
  Object.fromEntries(fields.map((field) => [field, source[field] ?? ""]));

const normalizeMetricNumber = (value, fallback = 0) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const normalizeOptionalString = (value) => {
  if (value === undefined || value === null) return undefined;
  const normalized = String(value).trim();
  return normalized || undefined;
};

const resortsCollection = () => db.collection("resorts");
const bookingsCollection = () => db.collection("bookings");
const hallBookingsCollection = () => db.collection("hallBookings");
const sessionsCollection = () => db.collection("adminSessions");

const loadSeed = async () => JSON.parse(await fs.readFile(seedFile, "utf8"));

const ensureIndexes = async () => {
  await Promise.all([
    resortsCollection().createIndex({ id: 1 }, { unique: true }),
    bookingsCollection().createIndex({ id: 1 }, { unique: true }),
    bookingsCollection().createIndex({ resortId: 1, checkIn: 1 }),
    hallBookingsCollection().createIndex({ id: 1 }, { unique: true }),
    hallBookingsCollection().createIndex({ resortId: 1, date: 1 }),
    sessionsCollection().createIndex({ token: 1 }, { unique: true }),
    sessionsCollection().createIndex(
      { createdAt: 1 },
      { expireAfterSeconds: 60 * 60 * 24 * 7 },
    ),
  ]);
};

const seedDatabaseIfEmpty = async () => {
  const resortsCount = await resortsCollection().countDocuments();
  if (resortsCount > 0) return;

  const seed = await loadSeed();

  if (seed.resorts?.length) {
    await resortsCollection().insertMany(seed.resorts);
  }

  if (seed.bookings?.length) {
    await bookingsCollection().insertMany(seed.bookings);
  }

  if (seed.hallBookings?.length) {
    await hallBookingsCollection().insertMany(seed.hallBookings);
  }
};

const getResorts = async () =>
  resortsCollection()
    .find({}, { projection: { _id: 0 } })
    .toArray();

const getBookings = async () =>
  bookingsCollection()
    .find({ deleted: { $ne: true } }, { projection: { _id: 0 } })
    .sort({ createdAt: -1, checkIn: -1 })
    .toArray();

const getHallBookings = async () =>
  hallBookingsCollection()
    .find({ deleted: { $ne: true } }, { projection: { _id: 0 } })
    .sort({ date: -1 })
    .toArray();

const deleteBookingById = async (id) => {
  const result = await bookingsCollection().findOneAndUpdate(
    { id },
    { $set: { deleted: true, deletedAt: new Date().toISOString() } },
    {
      projection: { _id: 0 },
      returnDocument: "after",
    },
  );
  return result;
};

const deleteHallBookingById = async (id) => {
  const result = await hallBookingsCollection().findOneAndUpdate(
    { id },
    { $set: { deleted: true, deletedAt: new Date().toISOString() } },
    {
      projection: { _id: 0 },
      returnDocument: "after",
    },
  );
  return result;
};

const validateBooking = (payload, resorts) => {
  if (!payload.guestName?.trim()) return "Guest name is required";
  if (!payload.mobile?.trim()) return "Mobile is required";
  if (!payload.checkIn) return "Check-in date is required";
  if (!payload.checkOut) return "Check-out date is required";
  if (payload.checkOut <= payload.checkIn)
    return "Check-out must be after check-in";
  if (!payload.resortId) return "Resort is required";
  const resort = resorts.find((item) => item.id === payload.resortId);
  if (!resort) return "Invalid resort";
  if (!resort.rooms.includes(payload.roomNumber)) return "Invalid room number";
  return null;
};

const validateHallBooking = (payload, resorts) => {
  if (!payload.eventName?.trim()) return "Event name is required";
  if (!payload.hostName?.trim()) return "Host name is required";
  if (!payload.mobile?.trim()) return "Mobile is required";
  if (!payload.date) return "Event date is required";
  if (!payload.resortId) return "Resort is required";
  const resort = resorts.find((item) => item.id === payload.resortId);
  if (!resort) return "Invalid resort";
  if (!resort.halls.includes(payload.hallName)) return "Invalid hall name";
  return null;
};

const describeRoomConflict = (roomNumber, conflict) =>
  `Room ${roomNumber} is already booked from ${formatDisplayDate(conflict.checkIn)} to ${formatDisplayDate(conflict.checkOut)} for ${conflict.guestName}`;

const describeHallConflict = (hallName, conflict) =>
  `Hall ${hallName} is already booked on ${formatDisplayDate(conflict.date)} for ${conflict.eventName} (${conflict.hostName})`;

const createBookingRecord = (payload) => {
  const persons = normalizeMetricNumber(payload.persons, 0);
  const children =
    payload.children !== undefined &&
    payload.children !== null &&
    payload.children !== ""
      ? Number(payload.children)
      : 0;
  const childPrice =
    payload.childPrice !== undefined &&
    payload.childPrice !== null &&
    payload.childPrice !== ""
      ? Number(payload.childPrice)
      : 0;
  const price = normalizeMetricNumber(payload.price, 0);
  const advance = normalizeMetricNumber(payload.advance, 0);
  const metricsGroupId = normalizeOptionalString(payload.metricsGroupId);

  return {
    ...pick(payload, bookingFields),
    id: randomUUID(),
    guestName: String(payload.guestName).trim(),
    mobile: String(payload.mobile).trim(),
    persons,
    children,
    childPrice,
    price,
    advance,
    ...(metricsGroupId ? { metricsGroupId } : {}),
    metricsPersons: normalizeMetricNumber(payload.metricsPersons, persons),
    metricsPrice: normalizeMetricNumber(payload.metricsPrice, price),
    metricsAdvance: normalizeMetricNumber(payload.metricsAdvance, advance),
    deleted: false,
    createdAt: new Date().toISOString().slice(0, 10),
  };
};

const createHallBookingRecord = (payload) => {
  const persons = normalizeMetricNumber(payload.persons, 0);
  const children =
    payload.children !== undefined &&
    payload.children !== null &&
    payload.children !== ""
      ? Number(payload.children)
      : 0;
  const childPrice =
    payload.childPrice !== undefined &&
    payload.childPrice !== null &&
    payload.childPrice !== ""
      ? Number(payload.childPrice)
      : 0;
  const price = normalizeMetricNumber(payload.price, 0);
  const advance = normalizeMetricNumber(payload.advance, 0);
  const metricsGroupId = normalizeOptionalString(payload.metricsGroupId);

  return {
    ...pick(payload, hallFields),
    id: randomUUID(),
    createdAt: new Date().toISOString().slice(0, 10),
    eventName: String(payload.eventName).trim(),
    hostName: String(payload.hostName).trim(),
    mobile: String(payload.mobile).trim(),
    persons,
    children,
    childPrice,
    price,
    advance,
    ...(metricsGroupId ? { metricsGroupId } : {}),
    metricsPersons: normalizeMetricNumber(payload.metricsPersons, persons),
    metricsPrice: normalizeMetricNumber(payload.metricsPrice, price),
    metricsAdvance: normalizeMetricNumber(payload.metricsAdvance, advance),
    deleted: false,
  };
};

const buildLegacyBookingMetricsKey = (booking) =>
  [
    booking.resortId,
    String(booking.guestName || "")
      .trim()
      .toLowerCase(),
    String(booking.mobile || "").trim(),
    booking.checkIn || "",
    booking.checkOut || "",
    booking.createdAt || "",
    normalizeMetricNumber(booking.persons, 0),
    normalizeMetricNumber(booking.children, 0),
    normalizeMetricNumber(booking.childPrice, 0),
    booking.bookingType || "",
    normalizeMetricNumber(booking.price, 0),
    normalizeMetricNumber(booking.advance, 0),
    booking.paymentStatus || "",
    String(booking.notes || "").trim(),
  ].join("::");

const buildLegacyHallMetricsKey = (hall) =>
  [
    hall.resortId,
    String(hall.eventName || "")
      .trim()
      .toLowerCase(),
    String(hall.hostName || "")
      .trim()
      .toLowerCase(),
    String(hall.mobile || "").trim(),
    hall.date || "",
    hall.checkIn || "",
    hall.checkOut || "",
    hall.createdAt || "",
    normalizeMetricNumber(hall.persons, 0),
    normalizeMetricNumber(hall.children, 0),
    normalizeMetricNumber(hall.childPrice, 0),
    hall.bookingType || "",
    normalizeMetricNumber(hall.price, 0),
    normalizeMetricNumber(hall.advance, 0),
    hall.paymentStatus || "",
    String(hall.notes || "").trim(),
  ].join("::");

const buildMetricsMigrationOps = (records, buildKey, sortKey) => {
  const groups = new Map();

  for (const record of records) {
    const key = buildKey(record);
    const existing = groups.get(key);
    if (existing) {
      existing.push(record);
    } else {
      groups.set(key, [record]);
    }
  }

  const ops = [];

  for (const group of groups.values()) {
    const ordered = [...group].sort((left, right) => {
      const bySortKey = String(sortKey(left) || "").localeCompare(
        String(sortKey(right) || ""),
      );
      if (bySortKey !== 0) return bySortKey;
      return String(left.id || left._id).localeCompare(
        String(right.id || right._id),
      );
    });
    const metricsGroupId = ordered.length > 1 ? randomUUID() : undefined;

    ordered.forEach((record, index) => {
      const primary = index === 0;
      const set = {
        metricsPersons: primary ? normalizeMetricNumber(record.persons, 0) : 0,
        metricsPrice: primary ? normalizeMetricNumber(record.price, 0) : 0,
        metricsAdvance: primary ? normalizeMetricNumber(record.advance, 0) : 0,
      };

      if (metricsGroupId) {
        set.metricsGroupId = metricsGroupId;
      }

      ops.push({
        updateOne: {
          filter: { _id: record._id },
          update: {
            $set: set,
          },
        },
      });
    });
  }

  return ops;
};

const migrateLegacyMetricAttribution = async () => {
  const missingMetricsQuery = {
    $or: [
      { metricsPersons: { $exists: false } },
      { metricsPrice: { $exists: false } },
      { metricsAdvance: { $exists: false } },
    ],
  };

  const [legacyBookings, legacyHalls] = await Promise.all([
    bookingsCollection().find(missingMetricsQuery).toArray(),
    hallBookingsCollection().find(missingMetricsQuery).toArray(),
  ]);

  const bookingOps = buildMetricsMigrationOps(
    legacyBookings,
    buildLegacyBookingMetricsKey,
    (booking) => booking.roomNumber,
  );
  const hallOps = buildMetricsMigrationOps(
    legacyHalls,
    buildLegacyHallMetricsKey,
    (hall) => hall.hallName,
  );

  if (bookingOps.length > 0) {
    await bookingsCollection().bulkWrite(bookingOps, { ordered: false });
  }

  if (hallOps.length > 0) {
    await hallBookingsCollection().bulkWrite(hallOps, { ordered: false });
  }
};

const findBookingConflict = (payload) =>
  bookingsCollection().findOne(
    {
      deleted: { $ne: true },
      resortId: payload.resortId,
      roomNumber: payload.roomNumber,
      checkIn: { $lt: payload.checkOut },
      checkOut: { $gt: payload.checkIn },
    },
    {
      projection: {
        _id: 0,
        guestName: 1,
        checkIn: 1,
        checkOut: 1,
      },
    },
  );

const findHallConflict = (payload) =>
  hallBookingsCollection().findOne(
    {
      deleted: { $ne: true },
      resortId: payload.resortId,
      hallName: payload.hallName,
      date: payload.date,
    },
    {
      projection: {
        _id: 0,
        eventName: 1,
        hostName: 1,
        date: 1,
      },
    },
  );

const createSession = async () => {
  const token = randomUUID();
  const session = {
    token,
    username: adminUsername,
    createdAt: new Date(),
  };

  await sessionsCollection().insertOne(session);
  return {
    token,
    user: {
      username: session.username,
      role: "admin",
    },
  };
};

const getTokenFromRequest = (req) => {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim();
};

const getSessionFromRequest = async (req) => {
  const token = getTokenFromRequest(req);
  if (!token) return null;

  return sessionsCollection().findOne(
    { token },
    { projection: { _id: 0, token: 1, username: 1, createdAt: 1 } },
  );
};

const requireAuth = async (req, res) => {
  const session = await getSessionFromRequest(req);
  if (!session) {
    json(res, 401, { error: "Unauthorized" });
    return null;
  }
  return session;
};

const bootstrap = async () => {
  if (!mongoUri) {
    throw new Error(
      "MONGODB_URI is required when running on Railway or in production",
    );
  }

  await client.connect();
  db = client.db(dbName);
  await ensureIndexes();
  await seedDatabaseIfEmpty();
  await migrateLegacyMetricAttribution();

  logger.info("Bootstrap complete", {
    dbName,
    resortCount: await resortsCollection().countDocuments(),
  });
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (req.method === "OPTIONS") {
      json(res, 204, {});
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      json(res, shuttingDown ? 503 : 200, {
        ok: !shuttingDown,
        db: dbName,
        shuttingDown,
        mongoUri: mongoUri.replace(/\/\/.*@/, "//***@"),
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/ping") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Server alive");
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/auth/login") {
      const payload = await readBody(req);

      if (
        payload.username !== adminUsername ||
        payload.password !== adminPassword
      ) {
        json(res, 401, { error: "Invalid username or password" });
        return;
      }

      json(res, 200, await createSession());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/auth/session") {
      const session = await requireAuth(req, res);
      if (!session) return;

      json(res, 200, {
        user: {
          username: session.username,
          role: "admin",
        },
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/auth/logout") {
      const session = await requireAuth(req, res);
      if (!session) return;

      await sessionsCollection().deleteOne({ token: session.token });
      json(res, 200, { ok: true });
      return;
    }

    const session = await requireAuth(req, res);
    if (!session) return;

    if (req.method === "GET" && url.pathname === "/api/bootstrap") {
      const [resorts, bookings, halls] = await Promise.all([
        getResorts(),
        getBookings(),
        getHallBookings(),
      ]);

      json(res, 200, { resorts, bookings, halls });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/resorts") {
      json(res, 200, await getResorts());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/bookings") {
      json(res, 200, await getBookings());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/metrics/bookings") {
      // Return all bookings including deleted ones for metrics
      const allBookings = await bookingsCollection()
        .find({}, { projection: { _id: 0 } })
        .sort({ createdAt: -1, checkIn: -1 })
        .toArray();
      json(res, 200, allBookings);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/metrics/halls") {
      // Return all hall bookings including deleted ones for metrics
      const allHalls = await hallBookingsCollection()
        .find({}, { projection: { _id: 0 } })
        .sort({ date: -1 })
        .toArray();
      json(res, 200, allHalls);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/bookings/batch") {
      const payload = await readBody(req);
      const roomPayloads = Array.isArray(payload.roomBookings)
        ? payload.roomBookings
        : [];
      const hallPayloads = Array.isArray(payload.hallBookings)
        ? payload.hallBookings
        : [];

      if (roomPayloads.length === 0 && hallPayloads.length === 0) {
        json(res, 400, {
          error: "Select at least one room or hall for batch booking",
        });
        return;
      }

      const resorts = await getResorts();
      const resortIds = [
        ...new Set(
          [...roomPayloads, ...hallPayloads]
            .map((item) => String(item.resortId || "").trim())
            .filter(Boolean),
        ),
      ];

      if (resortIds.length !== 1) {
        json(res, 400, {
          error: "Batch booking must belong to a single resort",
        });
        return;
      }

      const mobileNumbers = [
        ...new Set(
          [...roomPayloads, ...hallPayloads]
            .map((item) => String(item.mobile || "").trim())
            .filter(Boolean),
        ),
      ];

      if (mobileNumbers.length !== 1) {
        json(res, 400, {
          error: "All selected rooms and halls must use the same mobile number",
        });
        return;
      }

      const seenRooms = new Set();
      for (const roomPayload of roomPayloads) {
        const validationError = validateBooking(roomPayload, resorts);
        if (validationError) {
          json(res, 400, {
            error: `Room ${roomPayload.roomNumber}: ${validationError}`,
          });
          return;
        }

        const roomKey = `${roomPayload.resortId}::${roomPayload.roomNumber}`;
        if (seenRooms.has(roomKey)) {
          json(res, 400, {
            error: `Room ${roomPayload.roomNumber} is selected more than once`,
          });
          return;
        }
        seenRooms.add(roomKey);

        const conflict = await findBookingConflict(roomPayload);
        if (conflict) {
          json(res, 409, {
            error: describeRoomConflict(roomPayload.roomNumber, conflict),
          });
          return;
        }
      }

      const seenHalls = new Set();
      for (const hallPayload of hallPayloads) {
        const validationError = validateHallBooking(hallPayload, resorts);
        if (validationError) {
          json(res, 400, {
            error: `Hall ${hallPayload.hallName}: ${validationError}`,
          });
          return;
        }

        const hallKey = `${hallPayload.resortId}::${hallPayload.hallName}::${hallPayload.date}`;
        if (seenHalls.has(hallKey)) {
          json(res, 400, {
            error: `Hall ${hallPayload.hallName} is selected more than once`,
          });
          return;
        }
        seenHalls.add(hallKey);

        const conflict = await findHallConflict(hallPayload);
        if (conflict) {
          json(res, 409, {
            error: describeHallConflict(hallPayload.hallName, conflict),
          });
          return;
        }
      }

      const createdRoomBookings = roomPayloads.map(createBookingRecord);
      const createdHallBookings = hallPayloads.map(createHallBookingRecord);

      if (createdRoomBookings.length > 0) {
        await bookingsCollection().insertMany(createdRoomBookings);
      }

      if (createdHallBookings.length > 0) {
        await hallBookingsCollection().insertMany(createdHallBookings);
      }

      json(res, 201, {
        roomBookings: createdRoomBookings,
        hallBookings: createdHallBookings,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/bookings") {
      const payload = await readBody(req);
      const resorts = await getResorts();
      const error = validateBooking(payload, resorts);

      if (error) {
        json(res, 400, { error });
        return;
      }

      const conflict = await findBookingConflict(payload);
      if (conflict) {
        json(res, 409, {
          error: `Room already booked from ${formatDisplayDate(conflict.checkIn)} to ${formatDisplayDate(conflict.checkOut)} for ${conflict.guestName}`,
        });
        return;
      }

      const booking = createBookingRecord(payload);
      await bookingsCollection().insertOne(booking);
      json(res, 201, { booking });
      return;
    }

    const bookingMatch = /^\/api\/bookings\/([^/]+)$/.exec(url.pathname);
    if (req.method === "DELETE" && bookingMatch) {
      const deleted = await deleteBookingById(
        decodeURIComponent(bookingMatch[1]),
      );
      if (!deleted) {
        json(res, 404, { error: "Booking not found" });
        return;
      }

      json(res, 200, { ok: true, booking: deleted });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/halls") {
      json(res, 200, await getHallBookings());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/halls") {
      const payload = await readBody(req);
      const resorts = await getResorts();
      const error = validateHallBooking(payload, resorts);

      if (error) {
        json(res, 400, { error });
        return;
      }

      // Check for hall conflict
      const conflict = await findHallConflict(payload);
      if (conflict) {
        json(res, 409, {
          error: `Hall already booked on ${formatDisplayDate(conflict.date)} for ${conflict.eventName} (${conflict.hostName})`,
        });
        return;
      }

      const hallBooking = createHallBookingRecord(payload);
      await hallBookingsCollection().insertOne(hallBooking);
      json(res, 201, { hallBooking });
      return;
    }

    const hallMatch = /^\/api\/halls\/([^/]+)$/.exec(url.pathname);
    if (req.method === "DELETE" && hallMatch) {
      const deleted = await deleteHallBookingById(
        decodeURIComponent(hallMatch[1]),
      );
      if (!deleted) {
        json(res, 404, { error: "Hall booking not found" });
        return;
      }

      json(res, 200, { ok: true, hall: deleted });
      return;
    }

    json(res, 404, { error: "Not found" });
  } catch (error) {
    logger.error("Request handling failed", {
      method: req.method,
      url: req.url || "/",
      error: error instanceof Error ? error.message : "Internal server error",
    });
    json(res, 500, {
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
});

logger.info("Startup config", {
  port,
  dbName,
  isProduction,
  isRailway,
  mongoConfigured: Boolean(configuredMongoUri),
  mongoSource: configuredMongoUri
    ? "env"
    : canUseLocalMongoFallback
      ? "local-fallback"
      : "missing",
});

await bootstrap();

server.listen(port, "0.0.0.0", () => {
  logger.info("Rio backend listening", {
    host: "0.0.0.0",
    port,
    dbName,
  });
});

const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.warn("Shutdown requested", { signal });

  const forceExitTimer = setTimeout(() => {
    logger.error("Forcing shutdown after timeout", { signal });
    process.exit(1);
  }, 25_000);

  forceExitTimer.unref?.();

  try {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    await client.close();
    clearTimeout(forceExitTimer);
    logger.info("Shutdown complete", { signal });
    process.exit(0);
  } catch (error) {
    clearTimeout(forceExitTimer);
    logger.error("Shutdown failed", {
      signal,
      error: error instanceof Error ? error.message : "Unknown shutdown error",
    });
    process.exit(1);
  }
};

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("unhandledRejection", (error) => {
  logger.error("Unhandled promise rejection", {
    error: error instanceof Error ? error.message : String(error),
  });
});

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", {
    error: error instanceof Error ? error.message : String(error),
  });
});
