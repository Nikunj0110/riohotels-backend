import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";
import { WhatsAppService } from "./services/whatsapp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const seedFile = path.join(__dirname, "data", "seed.json");
const port = Number(process.env.PORT || 4000);
const mongoUri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017";
const dbName = process.env.MONGODB_DB || "riohotels";
const adminUsername = process.env.ADMIN_USERNAME || "riohotel";
const adminPassword = process.env.ADMIN_PASSWORD || "riohotel@123";
const whatsappEnabled = process.env.WHATSAPP_ENABLED !== "false";
const whatsappClientId = process.env.WHATSAPP_CLIENT_ID || "riohotels";
const whatsappDefaultCountryCode = process.env.WHATSAPP_DEFAULT_COUNTRY_CODE || "91";
const whatsappSessionsDir =
  process.env.WHATSAPP_SESSIONS_DIR || path.join(__dirname, "..", ".wwebjs_auth");
const whatsappPuppeteerExecutablePath = process.env.WHATSAPP_PUPPETEER_EXECUTABLE_PATH || "";

const client = new MongoClient(mongoUri);
let db;
let whatsappService;

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
  "roomNumber",
  "bookingType",
  "price",
  "advance",
  "paymentStatus",
  "notes",
];

const hallFields = [
  "resortId",
  "hallName",
  "eventName",
  "hostName",
  "mobile",
  "date",
  "price",
  "advance",
  "paymentStatus",
  "notes",
];

const pick = (source, fields) =>
  Object.fromEntries(fields.map((field) => [field, source[field] ?? ""]));

const resortsCollection = () => db.collection("resorts");
const bookingsCollection = () => db.collection("bookings");
const hallBookingsCollection = () => db.collection("hallBookings");
const sessionsCollection = () => db.collection("adminSessions");
const whatsappLogsCollection = () => db.collection("whatsappLogs");

const loadSeed = async () => JSON.parse(await fs.readFile(seedFile, "utf8"));

const ensureIndexes = async () => {
  await Promise.all([
    resortsCollection().createIndex({ id: 1 }, { unique: true }),
    bookingsCollection().createIndex({ id: 1 }, { unique: true }),
    bookingsCollection().createIndex({ resortId: 1, checkIn: 1 }),
    hallBookingsCollection().createIndex({ id: 1 }, { unique: true }),
    hallBookingsCollection().createIndex({ resortId: 1, date: 1 }),
    sessionsCollection().createIndex({ token: 1 }, { unique: true }),
    sessionsCollection().createIndex({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 7 }),
    whatsappLogsCollection().createIndex({ createdAt: 1 }),
    whatsappLogsCollection().createIndex({ bookingId: 1 }),
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

const getResorts = async () => resortsCollection().find({}, { projection: { _id: 0 } }).toArray();

const getBookings = async () =>
  bookingsCollection()
    .find({}, { projection: { _id: 0 } })
    .sort({ createdAt: -1, checkIn: -1 })
    .toArray();

const getHallBookings = async () =>
  hallBookingsCollection()
    .find({}, { projection: { _id: 0 } })
    .sort({ date: -1 })
    .toArray();

const deleteBookingById = async (id) =>
  bookingsCollection().findOneAndDelete(
    { id },
    {
      projection: { _id: 0 },
    },
  );

const deleteHallBookingById = async (id) =>
  hallBookingsCollection().findOneAndDelete(
    { id },
    {
      projection: { _id: 0 },
    },
  );

const validateBooking = (payload, resorts) => {
  if (!payload.guestName?.trim()) return "Guest name is required";
  if (!payload.mobile?.trim()) return "Mobile is required";
  if (!payload.checkIn) return "Check-in date is required";
  if (!payload.checkOut) return "Check-out date is required";
  if (payload.checkOut <= payload.checkIn) return "Check-out must be after check-in";
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

const createBookingRecord = (payload) => ({
  ...pick(payload, bookingFields),
  id: randomUUID(),
  guestName: String(payload.guestName).trim(),
  mobile: String(payload.mobile).trim(),
  persons: Number(payload.persons || 0),
  price: Number(payload.price || 0),
  advance: Number(payload.advance || 0),
  createdAt: new Date().toISOString().slice(0, 10),
});

const createHallBookingRecord = (payload) => ({
  ...pick(payload, hallFields),
  id: randomUUID(),
  eventName: String(payload.eventName).trim(),
  hostName: String(payload.hostName).trim(),
  mobile: String(payload.mobile).trim(),
  price: Number(payload.price || 0),
  advance: Number(payload.advance || 0),
});

const findBookingConflict = (payload) =>
  bookingsCollection().findOne(
    {
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
  await client.connect();
  db = client.db(dbName);
  await ensureIndexes();
  await seedDatabaseIfEmpty();

  whatsappService = new WhatsAppService({
    enabled: whatsappEnabled,
    clientId: whatsappClientId,
    sessionsDir: whatsappSessionsDir,
    defaultCountryCode: whatsappDefaultCountryCode,
    puppeteerExecutablePath: whatsappPuppeteerExecutablePath,
    logsCollection: whatsappLogsCollection,
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
      json(res, 200, {
        ok: true,
        db: dbName,
        mongoUri: mongoUri.replace(/\/\/.*@/, "//***@"),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/auth/login") {
      const payload = await readBody(req);

      if (payload.username !== adminUsername || payload.password !== adminPassword) {
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

    if (req.method === "GET" && url.pathname === "/api/whatsapp/status") {
      json(res, 200, await whatsappService.getStatus());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/whatsapp/restart") {
      json(res, 200, await whatsappService.restart());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/whatsapp/logout") {
      json(res, 200, await whatsappService.logout());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/whatsapp/regenerate-qr") {
      json(res, 200, await whatsappService.regenerateQr());
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
      const resort = resorts.find((item) => item.id === booking.resortId) || null;
      const whatsapp = await whatsappService.sendBookingConfirmation(booking, resort);
      json(res, 201, { booking, whatsapp });
      return;
    }

    const bookingMatch = /^\/api\/bookings\/([^/]+)$/.exec(url.pathname);
    if (req.method === "DELETE" && bookingMatch) {
      const deleted = await deleteBookingById(decodeURIComponent(bookingMatch[1]));
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

      const hallBooking = createHallBookingRecord(payload);
      await hallBookingsCollection().insertOne(hallBooking);
      json(res, 201, hallBooking);
      return;
    }

    const hallMatch = /^\/api\/halls\/([^/]+)$/.exec(url.pathname);
    if (req.method === "DELETE" && hallMatch) {
      const deleted = await deleteHallBookingById(decodeURIComponent(hallMatch[1]));
      if (!deleted) {
        json(res, 404, { error: "Hall booking not found" });
        return;
      }

      json(res, 200, { ok: true, hall: deleted });
      return;
    }

    json(res, 404, { error: "Not found" });
  } catch (error) {
    json(res, 500, { error: error instanceof Error ? error.message : "Internal server error" });
  }
});

await bootstrap();

server.listen(port, "127.0.0.1", () => {
  console.log(`Rio backend listening on http://127.0.0.1:${port}`);
  console.log(`MongoDB connected at ${mongoUri}, database ${dbName}`);
  console.log(
    `WhatsApp automation ${whatsappEnabled ? "enabled" : "disabled"} using session path ${whatsappSessionsDir}`,
  );
  void whatsappService.init();
});
