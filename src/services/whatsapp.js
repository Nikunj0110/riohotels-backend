import { existsSync, promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import QRCode from "qrcode";
import whatsappWeb from "whatsapp-web.js";
import chromium from "@sparticuz/chromium";
import { createLogger } from "../utils/logger.js";

const { Client, RemoteAuth } = whatsappWeb;
const logger = createLogger("whatsapp");
const require = createRequire(import.meta.url);
const { LoadUtils } = require("whatsapp-web.js/src/util/Injected/Utils.js");
const ClientInfo = require("whatsapp-web.js/src/structures/ClientInfo.js");
const InterfaceController = require("whatsapp-web.js/src/util/InterfaceController.js");

const DEFAULT_STATS = {
  totalToday: 0,
  sentToday: 0,
  failedToday: 0,
  skippedToday: 0,
};

const DEFAULT_QUEUE_STATS = {
  pending: 0,
  processing: 0,
  failed: 0,
};

const JOB_STATUS = {
  PENDING: "pending",
  PROCESSING: "processing",
  SENT: "sent",
  FAILED_PERMANENT: "failed_permanent",
};

const DEFAULT_VIEWPORT = {
  width: 1280,
  height: 720,
  deviceScaleFactor: 1,
};

const CLIENT_STATE_TIMEOUT_MS = 5_000;
const VALIDATE_NUMBER_TIMEOUT_MS = 10_000;
const SEND_MESSAGE_TIMEOUT_MS = 15_000;
const PUPPETEER_PROTOCOL_TIMEOUT_MS = 30_000;

const SYSTEM_BROWSER_PATHS = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
];

let bundledChromiumExecutablePathPromise = null;

const PERMANENT_ERROR_PATTERNS = [
  "invalid wid",
  "not registered on whatsapp",
  "invalid phone number",
  "wid error",
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const randomBetween = (min, max) => {
  const lower = Math.max(0, Number(min) || 0);
  const upper = Math.max(lower, Number(max) || lower);
  if (upper === lower) return lower;
  return Math.floor(Math.random() * (upper - lower + 1)) + lower;
};

const dedupe = (values) => [...new Set(values.filter(Boolean))];

const getErrorMessage = (error, fallback = "Unable to send WhatsApp message") =>
  error instanceof Error ? error.message : fallback;

const isPermanentError = (reason) => {
  const normalized = String(reason || "").toLowerCase();
  return PERMANENT_ERROR_PATTERNS.some((pattern) => normalized.includes(pattern));
};

const formatInr = (value) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(Number(value || 0));

const formatDisplayDate = (value) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return value;

  const [, year, month, day] = match;
  return `${day}/${month}/${year}`;
};

const sanitizePhoneNumber = (raw, defaultCountryCode) => {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `${defaultCountryCode}${digits}`;
  if (digits.startsWith("00") && digits.length > 12) return digits.slice(2);
  if (digits.length >= 11 && digits.length <= 15) return digits;
  return null;
};

const formatDisplayPhoneNumber = (digits) => (digits ? `+${digits}` : null);

const extractWidUser = (wid) => {
  if (!wid) return null;

  if (typeof wid === "string") {
    const normalized = wid.split("@")[0]?.replace(/\D/g, "");
    return normalized || null;
  }

  if (typeof wid.user === "string" && wid.user.trim()) {
    return wid.user.trim();
  }

  if (typeof wid._serialized === "string" && wid._serialized.trim()) {
    const normalized = wid._serialized.split("@")[0]?.replace(/\D/g, "");
    return normalized || null;
  }

  try {
    const rendered = String(wid);
    const normalized = rendered.split("@")[0]?.replace(/\D/g, "");
    return normalized || null;
  } catch {
    return null;
  }
};

const buildBookingMessage = ({ booking, resortName }) => {
  const balance = Math.max(
    0,
    Number(booking.price || 0) - Number(booking.advance || 0),
  );
  const lines = [
    `Hi ${booking.guestName},`,
    `Your booking at ${resortName} is confirmed.`,
    "",
    `Room: ${booking.roomNumber}`,
    `Check-in: ${formatDisplayDate(booking.checkIn)}`,
    `Check-out: ${formatDisplayDate(booking.checkOut)}`,
    `Guests: ${booking.persons || 0}`,
    `Children: ${booking.children || 0}`,
    `Total: ${formatInr(booking.price)}`,
    `Advance: ${formatInr(booking.advance)}`,
    `Due: ${formatInr(balance)}`,
  ];

  if (booking.notes) {
    lines.push("", `Note: ${booking.notes}`);
  }

  lines.push("", `Thank you for choosing ${resortName}.`);
  return lines.join("\n");
};

const buildMultiBookingMessage = ({
  guestName,
  resortName,
  roomNumbers = [],
  hallNames = [],
  checkIn,
  checkOut,
  persons,
  children,
  price,
  advance,
  notes,
}) => {
  const balance = Math.max(0, Number(price || 0) - Number(advance || 0));
  const lines = [
    `Hi ${guestName},`,
    `Your booking at ${resortName} is confirmed.`,
    "",
  ];

  if (roomNumbers.length > 0) {
    lines.push(
      `${roomNumbers.length > 1 ? "Rooms" : "Room"} (${roomNumbers.length}): ${roomNumbers.join(", ")}`,
    );
  }

  if (hallNames.length > 0) {
    lines.push(
      `${hallNames.length > 1 ? "Halls" : "Hall"} (${hallNames.length}): ${hallNames.join(", ")}`,
    );
  }

  lines.push(
    `Check-in: ${formatDisplayDate(checkIn)}`,
    `Check-out: ${formatDisplayDate(checkOut)}`,
    `Guests: ${persons || 0}`,
    `Children: ${children || 0}`,
    `Total: ${formatInr(price)}`,
    `Advance: ${formatInr(advance)}`,
    `Due: ${formatInr(balance)}`,
  );

  if (notes) {
    lines.push("", `Note: ${notes}`);
  }

  lines.push("", `Thank you for choosing ${resortName}.`);
  return lines.join("\n");
};

const buildChromiumArgs = (useBundledChromium) => {
  const extraArgs = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-software-rasterizer",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-breakpad",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter,OptimizationHints",
    "--disable-renderer-backgrounding",
    "--disable-sync",
    "--metrics-recording-only",
    "--mute-audio",
    "--no-default-browser-check",
    "--no-first-run",
    "--password-store=basic",
    "--use-mock-keychain",
  ];

  return dedupe([
    ...(useBundledChromium ? chromium.args : []),
    ...extraArgs,
  ]);
};

const resolveBundledChromiumExecutablePath = async () => {
  if (existsSync("/tmp/chromium")) {
    return "/tmp/chromium";
  }

  // @sparticuz/chromium extracts shared files into /tmp, so concurrent
  // initializations need to await the same extraction work.
  if (!bundledChromiumExecutablePathPromise) {
    bundledChromiumExecutablePathPromise = chromium
      .executablePath()
      .catch((error) => {
        bundledChromiumExecutablePathPromise = null;
        throw error;
      });
  }

  return bundledChromiumExecutablePathPromise;
};

const resolveSystemBrowserExecutablePath = () =>
  SYSTEM_BROWSER_PATHS.find((browserPath) => existsSync(browserPath));

export class WhatsAppService {
  constructor({
    enabled = true,
    resortId,
    resortName = "Rio Hotels",
    clientId = "riohotels",
    sessionsDir,
    authStore = null,
    authBackupSyncIntervalMs = 300_000,
    defaultCountryCode = "91",
    puppeteerExecutablePath = "",
    logsCollection,
    queueCollection,
    sendDelayMinMs = 3_000,
    sendDelayMaxMs = 7_000,
    queuePollIntervalMs = 15_000,
    queueRetryBaseMs = 60_000,
    queueRetryMaxMs = 30 * 60_000,
    queueLockTtlMs = 120_000,
    maxQueueAttempts = 6,
    sessionRmMaxRetries = 4,
  }) {
    this.enabled = enabled;
    this.resortId = resortId;
    this.resortName = resortName;
    this.clientId = clientId;
    this.sessionsDir = sessionsDir;
    this.authStore = authStore;
    this.authBackupSyncIntervalMs = Math.max(
      60_000,
      Number(authBackupSyncIntervalMs) || 300_000,
    );
    this.defaultCountryCode = defaultCountryCode;
    this.puppeteerExecutablePath = puppeteerExecutablePath;
    this.logsCollection = logsCollection;
    this.queueCollection = queueCollection;
    this.sendDelayMinMs = Math.max(0, Number(sendDelayMinMs) || 0);
    this.sendDelayMaxMs = Math.max(
      this.sendDelayMinMs,
      Number(sendDelayMaxMs) || this.sendDelayMinMs,
    );
    this.queuePollIntervalMs = Math.max(
      1_000,
      Number(queuePollIntervalMs) || 15_000,
    );
    this.queueRetryBaseMs = Math.max(
      5_000,
      Number(queueRetryBaseMs) || 60_000,
    );
    this.queueRetryMaxMs = Math.max(
      this.queueRetryBaseMs,
      Number(queueRetryMaxMs) || 30 * 60_000,
    );
    this.queueLockTtlMs = Math.max(
      30_000,
      Number(queueLockTtlMs) || 120_000,
    );
    this.maxQueueAttempts = Math.max(1, Number(maxQueueAttempts) || 6);
    this.sessionRmMaxRetries = Math.max(
      1,
      Number(sessionRmMaxRetries) || 4,
    );

    this.client = null;
    this.initializing = false;
    this.queueProcessing = false;
    this.status = enabled ? "initializing" : "disabled";
    this.qrCode = null;
    this.qrDataUrl = null;
    this.phoneNumber = null;
    this.connectedAt = null;
    this.lastError = enabled ? null : "WhatsApp automation is disabled";
    this.lastEventAt = null;
    this.reconnectTimer = null;
    this.queueTimer = null;
    this.connectionRecoveryTimer = null;
    this.sendLock = Promise.resolve();
    this.reconnectAttempts = 0;
    this.connectionRecoveryAttempts = 0;
    this.manualLogout = false;
    this.shutdownRequested = false;
  }

  async init() {
    if (!this.enabled) return this.getStatus();
    return this.initializeClient();
  }

  async restart() {
    this.manualLogout = false;
    this.shutdownRequested = false;
    this.clearReconnectTimer();
    this.clearQueueTimer();
    this.clearConnectionRecoveryTimer();
    await this.destroyClient();
    return this.initializeClient();
  }

  async logout() {
    this.manualLogout = true;
    this.clearReconnectTimer();
    this.clearQueueTimer();
    this.clearConnectionRecoveryTimer();

    if (this.client) {
      try {
        await this.client.logout();
      } catch {
        void 0;
      }
    }

    await this.destroyClient();
    await this.cleanupClientAuthArtifacts();

    this.status = "disconnected";
    this.connectedAt = null;
    this.phoneNumber = null;
    this.qrCode = null;
    this.qrDataUrl = null;
    this.lastError = null;
    this.lastEventAt = new Date().toISOString();

    return this.getStatus();
  }

  async regenerateQr() {
    await this.logout();
    this.manualLogout = false;
    this.shutdownRequested = false;
    return this.initializeClient();
  }

  async shutdown() {
    this.shutdownRequested = true;
    this.clearReconnectTimer();
    this.clearQueueTimer();
    this.clearConnectionRecoveryTimer();
    await this.destroyClient();
  }

  async getStatus() {
    return {
      enabled: this.enabled,
      authMode: "remote-mongodb",
      resortId: this.resortId,
      resortName: this.resortName,
      status: this.status,
      phoneNumber: this.phoneNumber,
      connectedAt: this.connectedAt,
      qrCode: this.qrCode,
      qrDataUrl: this.qrDataUrl,
      lastError: this.lastError,
      lastEventAt: this.lastEventAt,
      stats: await this.getTodayStats(),
      queue: await this.getQueueStats(),
    };
  }

  isReady() {
    return Boolean(
      this.status === "connected" &&
        (this.client?.info?.wid?.user || this.phoneNumber),
    );
  }

  async sendBookingConfirmation(booking, resort) {
    const recipient = sanitizePhoneNumber(
      booking.mobile,
      this.defaultCountryCode,
    );
    const displayRecipient = formatDisplayPhoneNumber(recipient);

    if (!recipient) {
      await this.logMessage({
        bookingId: booking.id,
        resortId: booking.resortId,
        roomNumber: booking.roomNumber,
        targetNumber: booking.mobile,
        status: "skipped",
        error: "Invalid mobile number format",
      });

      logger.warn("Skipped WhatsApp message with invalid number", {
        resortId: booking.resortId,
        bookingId: booking.id,
        targetNumber: booking.mobile,
      });

      return {
        attempted: false,
        sent: false,
        queued: false,
        recipient: booking.mobile || null,
        reason: "Invalid mobile number format",
      };
    }

    return this.sendTextMessageNow({
      bookingId: booking.id,
      resortId: booking.resortId,
      roomNumber: booking.roomNumber,
      targetNumber: recipient,
      displayRecipient,
      messageType: "booking_confirmation",
      messageText: buildBookingMessage({
        booking,
        resortName: resort?.name || this.resortName,
      }),
    });
  }

  async sendMultiBookingConfirmation(summary, resort) {
    const recipient = sanitizePhoneNumber(
      summary.mobile,
      this.defaultCountryCode,
    );
    const displayRecipient = formatDisplayPhoneNumber(recipient);
    const inventoryLabel = [
      summary.roomNumbers?.length
        ? `Rooms: ${summary.roomNumbers.join(", ")}`
        : null,
      summary.hallNames?.length
        ? `Halls: ${summary.hallNames.join(", ")}`
        : null,
    ]
      .filter(Boolean)
      .join(" | ");

    if (!recipient) {
      await this.logMessage({
        bookingId: summary.bookingId,
        resortId: summary.resortId,
        roomNumber: inventoryLabel,
        targetNumber: summary.mobile,
        status: "skipped",
        error: "Invalid mobile number format",
      });

      logger.warn("Skipped multi-booking WhatsApp message with invalid number", {
        resortId: summary.resortId,
        bookingId: summary.bookingId,
        targetNumber: summary.mobile,
      });

      return {
        attempted: false,
        sent: false,
        queued: false,
        recipient: summary.mobile || null,
        reason: "Invalid mobile number format",
      };
    }

    return this.sendTextMessageNow({
      bookingId: summary.bookingId,
      resortId: summary.resortId,
      roomNumber: inventoryLabel,
      targetNumber: recipient,
      displayRecipient,
      messageType: "multi_booking_confirmation",
      messageText: buildMultiBookingMessage({
        guestName: summary.guestName,
        resortName: resort?.name || this.resortName,
        roomNumbers: summary.roomNumbers || [],
        hallNames: summary.hallNames || [],
        checkIn: summary.checkIn,
        checkOut: summary.checkOut,
        persons: summary.persons,
        children: summary.children,
        price: summary.price,
        advance: summary.advance,
        notes: summary.notes,
      }),
    });
  }

  async validateNumber(phoneNumber) {
    if (!this.client || !this.isReady()) return null;
    const result = await this.client.getNumberId(`${phoneNumber}@c.us`);
    return result?._serialized || null;
  }

  async initializeClient() {
    if (!this.enabled) {
      this.status = "disabled";
      this.lastError = "WhatsApp automation is disabled";
      return this.getStatus();
    }

    if (this.initializing) return this.getStatus();

    this.initializing = true;
    this.status = "initializing";
    this.lastError = null;
    this.lastEventAt = new Date().toISOString();
    this.shutdownRequested = false;
    this.connectionRecoveryAttempts = 0;
    this.clearConnectionRecoveryTimer();

    try {
      await fs.mkdir(this.sessionsDir, { recursive: true });
      await this.cleanupLegacyLocalAuthArtifacts();
      await this.clearStoredQueueMessages();
      await this.destroyClient();

      if (!this.authStore) {
        throw new Error("WhatsApp remote auth store is not configured");
      }

      const { executablePath, useBundledChromium, browserSource } =
        await this.resolveBrowserLaunchConfig();

      logger.info("Launching WhatsApp browser", {
        resortId: this.resortId,
        clientId: this.clientId,
        browserSource,
        executablePath: executablePath || null,
      });

      const nextClient = new Client({
        authStrategy: new RemoteAuth({
          clientId: this.clientId,
          dataPath: this.sessionsDir,
          store: this.authStore,
          backupSyncIntervalMs: this.authBackupSyncIntervalMs,
          rmMaxRetries: this.sessionRmMaxRetries,
        }),
        takeoverOnConflict: true,
        takeoverTimeoutMs: 0,
        puppeteer: {
          headless: useBundledChromium ? "shell" : true,
          args: buildChromiumArgs(useBundledChromium),
          defaultViewport: DEFAULT_VIEWPORT,
          timeout: 60_000,
          protocolTimeout: PUPPETEER_PROTOCOL_TIMEOUT_MS,
          ...(executablePath ? { executablePath } : {}),
        },
      });

      this.client = nextClient;
      this.bindEvents(nextClient);
      await nextClient.initialize();
    } catch (error) {
      this.status = "disconnected";
      this.lastError = getErrorMessage(
        error,
        "Unable to initialize WhatsApp client",
      );
      this.connectedAt = null;
      this.phoneNumber = null;
      this.qrCode = null;
      this.qrDataUrl = null;
      logger.error("Failed to initialize WhatsApp client", {
        resortId: this.resortId,
        clientId: this.clientId,
        error: this.lastError,
      });
      this.scheduleReconnect();
    } finally {
      this.initializing = false;
    }

    return this.getStatus();
  }

  bindEvents(nextClient) {
    nextClient.on("qr", async (qr) => {
      if (this.client !== nextClient) return;

      this.clearConnectionRecoveryTimer();
      this.connectionRecoveryAttempts = 0;

      try {
        this.qrDataUrl = await QRCode.toDataURL(qr);
      } catch (error) {
        this.qrDataUrl = null;
        this.lastError = getErrorMessage(error, "Unable to render QR");
      }

      this.status = "qr_waiting";
      this.qrCode = qr;
      this.phoneNumber = null;
      this.connectedAt = null;
      this.lastEventAt = new Date().toISOString();

      logger.info("WhatsApp QR generated", {
        resortId: this.resortId,
        clientId: this.clientId,
      });
    });

    nextClient.on("ready", () => {
      if (this.client !== nextClient) return;

      void this.markConnected(nextClient, { source: "ready" });
    });

    nextClient.on("authenticated", () => {
      if (this.client !== nextClient) return;

      this.status = "initializing";
      this.qrCode = null;
      this.qrDataUrl = null;
      this.lastError = null;
      this.lastEventAt = new Date().toISOString();
      logger.info("WhatsApp client authenticated", {
        resortId: this.resortId,
        clientId: this.clientId,
      });

      this.scheduleConnectionRecovery(nextClient, {
        delayMs: 500,
        source: "authenticated",
      });
    });

    nextClient.on("remote_session_saved", () => {
      if (this.client !== nextClient) return;

      logger.info("WhatsApp remote session saved", {
        resortId: this.resortId,
        clientId: this.clientId,
      });
    });

    nextClient.on("auth_failure", (message) => {
      if (this.client !== nextClient) return;

      this.status = "disconnected";
      this.connectedAt = null;
      this.phoneNumber = null;
      this.qrCode = null;
      this.qrDataUrl = null;
      this.lastError = message || "Authentication failure";
      this.lastEventAt = new Date().toISOString();

      logger.error("WhatsApp authentication failure", {
        resortId: this.resortId,
        clientId: this.clientId,
        error: this.lastError,
      });

      this.clearConnectionRecoveryTimer();

      if (!this.manualLogout) {
        this.scheduleReconnect();
      }
    });

    nextClient.on("loading_screen", (percent, message) => {
      if (this.client !== nextClient) return;

      if (this.status !== "connected") {
        this.status = "initializing";
        this.qrCode = null;
        this.qrDataUrl = null;
      }

      this.lastError = null;
      this.lastEventAt = new Date().toISOString();

      logger.info("WhatsApp client loading", {
        resortId: this.resortId,
        clientId: this.clientId,
        percent,
        message: message || null,
      });

      this.scheduleConnectionRecovery(nextClient, {
        delayMs: 750,
        source: "loading_screen",
      });
    });

    nextClient.on("change_state", (state) => {
      if (this.client !== nextClient) return;
      this.lastEventAt = new Date().toISOString();

      const normalizedState = String(state || "").toUpperCase();
      if (
        this.status !== "connected" &&
        ["OPENING", "CONNECTED", "TIMEOUT"].includes(normalizedState)
      ) {
        this.status = "initializing";
        this.qrCode = null;
        this.qrDataUrl = null;
        this.scheduleConnectionRecovery(nextClient, {
          delayMs: normalizedState === "CONNECTED" ? 500 : 1_000,
          source: `state:${normalizedState}`,
        });
      }

      logger.info("WhatsApp client state changed", {
        resortId: this.resortId,
        clientId: this.clientId,
        state,
      });
    });

    nextClient.on("disconnected", (reason) => {
      if (this.client !== nextClient) return;

      this.status = "disconnected";
      this.connectedAt = null;
      this.phoneNumber = null;
      this.lastError = String(reason || "Disconnected");
      this.lastEventAt = new Date().toISOString();
      this.clearConnectionRecoveryTimer();
      this.connectionRecoveryAttempts = 0;

      logger.warn("WhatsApp client disconnected", {
        resortId: this.resortId,
        clientId: this.clientId,
        reason: this.lastError,
      });

      if (!this.manualLogout) {
        this.scheduleReconnect();
      }
    });
  }

  async markConnected(nextClient, { source = "unknown", phoneNumber } = {}) {
    if (this.client !== nextClient) return false;

    const runtime = nextClient.info
      ? null
      : await this.inspectClientRuntime(nextClient).catch(() => null);

    if (!nextClient.info && runtime) {
      this.hydrateClientInfo(nextClient, runtime);
    }

    const resolvedPhoneNumber =
      phoneNumber ||
      extractWidUser(nextClient.info?.wid) ||
      runtime?.widUser ||
      (await this.resolveCurrentWidUser(nextClient));

    this.status = "connected";
    this.connectedAt = this.connectedAt || new Date().toISOString();
    this.phoneNumber = formatDisplayPhoneNumber(resolvedPhoneNumber);
    this.qrCode = null;
    this.qrDataUrl = null;
    this.lastError = null;
    this.lastEventAt = new Date().toISOString();
    this.reconnectAttempts = 0;
    this.connectionRecoveryAttempts = 0;
    this.clearReconnectTimer();
    this.clearConnectionRecoveryTimer();

    logger.info("WhatsApp client connected", {
      resortId: this.resortId,
      clientId: this.clientId,
      phoneNumber: this.phoneNumber,
      source,
    });
    return true;
  }

  scheduleConnectionRecovery(
    nextClient,
    { delayMs = 1_000, source = "probe" } = {},
  ) {
    if (
      this.client !== nextClient ||
      !this.enabled ||
      this.manualLogout ||
      this.shutdownRequested ||
      this.status === "connected" ||
      this.connectionRecoveryTimer
    ) {
      return;
    }

    const delay = Math.max(250, Number(delayMs) || 1_000);
    this.connectionRecoveryTimer = setTimeout(() => {
      this.connectionRecoveryTimer = null;
      void this.promoteClientIfOperational(nextClient, { source });
    }, delay);
  }

  clearConnectionRecoveryTimer() {
    if (!this.connectionRecoveryTimer) return;
    clearTimeout(this.connectionRecoveryTimer);
    this.connectionRecoveryTimer = null;
  }

  async promoteClientIfOperational(
    nextClient,
    { source = "probe" } = {},
  ) {
    if (
      this.client !== nextClient ||
      this.manualLogout ||
      this.shutdownRequested ||
      this.status === "connected"
    ) {
      return false;
    }

    try {
      const runtime = await this.inspectClientRuntime(nextClient);
      const runtimeState = String(runtime?.socketState || "").toUpperCase();
      const canPromote =
        Boolean(runtime?.widUser) &&
        runtimeState === "CONNECTED";

      if (!canPromote) {
        this.connectionRecoveryAttempts += 1;
        if (!this.manualLogout && this.connectionRecoveryAttempts <= 60) {
          this.scheduleConnectionRecovery(nextClient, {
            delayMs: Math.min(5_000, 750 + this.connectionRecoveryAttempts * 250),
            source,
          });
        }
        return false;
      }

      await this.ensureClientInjected(nextClient, runtime);
      this.hydrateClientInfo(nextClient, runtime);
      return this.markConnected(nextClient, {
        source: `${source}:recovered`,
        phoneNumber: runtime.widUser,
      });
    } catch (error) {
      this.connectionRecoveryAttempts += 1;
      this.lastError = getErrorMessage(
        error,
        "Unable to finalize WhatsApp connection",
      );
      this.lastEventAt = new Date().toISOString();

      logger.warn("WhatsApp connection recovery is waiting", {
        resortId: this.resortId,
        clientId: this.clientId,
        source,
        attempt: this.connectionRecoveryAttempts,
        error: this.lastError,
      });

      if (!this.manualLogout && this.connectionRecoveryAttempts <= 60) {
        this.scheduleConnectionRecovery(nextClient, {
          delayMs: Math.min(5_000, 1_000 + this.connectionRecoveryAttempts * 250),
          source,
        });
      }

      return false;
    }
  }

  async inspectClientRuntime(nextClient) {
    if (!nextClient?.pupPage) return null;

    return nextClient.pupPage.evaluate(() => {
      const runtime = {
        hasWWebJS: typeof window.WWebJS !== "undefined",
        socketState: null,
        widUser: null,
        clientInfo: null,
      };

      try {
        runtime.socketState =
          window.require("WAWebSocketModel").Socket.state || null;
      } catch {
        runtime.socketState = null;
      }

      try {
        const userModule = window.require("WAWebUserPrefsMeUser");
        const wid =
          userModule.getMaybeMePnUser?.() || userModule.getMaybeMeLidUser?.();

        const extractedUser =
          (typeof wid?.user === "string" && wid.user) ||
          (typeof wid?._serialized === "string"
            ? wid._serialized.split("@")[0]
            : null) ||
          null;

        const serializedConn =
          window.require("WAWebConnModel").Conn.serialize?.() || {};

        runtime.widUser = extractedUser;
        runtime.clientInfo = wid
          ? {
              ...serializedConn,
              wid: {
                user: extractedUser,
                _serialized:
                  typeof wid?._serialized === "string"
                    ? wid._serialized
                    : extractedUser
                      ? `${extractedUser}@c.us`
                      : null,
                server:
                  typeof wid?.server === "string" ? wid.server : "c.us",
              },
            }
          : null;
      } catch {
        runtime.clientInfo = null;
      }

      return runtime;
    });
  }

  async ensureClientInjected(nextClient, runtime = null) {
    if (!nextClient?.pupPage) {
      throw new Error("WhatsApp browser page is not available");
    }

    const alreadyInjected = Boolean(runtime?.hasWWebJS);
    if (!alreadyInjected) {
      await nextClient.pupPage.evaluate(LoadUtils);
    }

    let isInjected = alreadyInjected;
    for (let attempt = 0; attempt < 20 && !isInjected; attempt += 1) {
      await sleep(200);
      isInjected = await nextClient.pupPage.evaluate(
        () => typeof window.WWebJS !== "undefined",
      );
    }

    if (!isInjected) {
      throw new Error("WhatsApp Web helpers were not injected");
    }

    if (!nextClient.interface) {
      nextClient.interface = new InterfaceController(nextClient);
    }
  }

  hydrateClientInfo(nextClient, runtime = null) {
    if (nextClient.info) return;

    const fallbackWidUser = runtime?.widUser || null;
    const clientInfo =
      runtime?.clientInfo ||
      (fallbackWidUser
        ? {
            wid: {
              user: fallbackWidUser,
              _serialized: `${fallbackWidUser}@c.us`,
              server: "c.us",
            },
          }
        : null);

    if (!clientInfo?.wid) return;
    nextClient.info = new ClientInfo(nextClient, clientInfo);
  }

  async resolveCurrentWidUser(nextClient) {
    try {
      const runtime = await this.inspectClientRuntime(nextClient);
      return runtime?.widUser || null;
    } catch {
      return null;
    }
  }

  async sendTextMessageNow({
    bookingId,
    resortId,
    roomNumber,
    targetNumber,
    displayRecipient,
    messageType,
    messageText,
  }) {
    if (!this.enabled) {
      return {
        attempted: false,
        sent: false,
        queued: false,
        recipient: displayRecipient,
        reason: "WhatsApp automation is disabled",
      };
    }

    if (!this.client || !this.isReady()) {
      const reason = "WhatsApp is not connected right now";
      await this.logMessage({
        bookingId,
        resortId,
        roomNumber,
        targetNumber,
        status: "skipped",
        error: reason,
      });

      logger.info("Skipped WhatsApp message because client is offline", {
        resortId,
        bookingId,
        targetNumber,
        messageType,
      });

      return {
        attempted: false,
        sent: false,
        queued: false,
        recipient: displayRecipient,
        reason,
      };
    }

    return this.runSendExclusively(async () => {
      if (!this.client || !this.isReady()) {
        const reason = "WhatsApp is not connected right now";
        await this.logMessage({
          bookingId,
          resortId,
          roomNumber,
          targetNumber,
          status: "skipped",
          error: reason,
        });

        return {
          attempted: false,
          sent: false,
          queued: false,
          recipient: displayRecipient,
          reason,
        };
      }

      try {
        const clientState = await this.runOperationWithTimeout(
          () => this.client.getState(),
          CLIENT_STATE_TIMEOUT_MS,
          "check WhatsApp connection state",
        );

        if (String(clientState || "").toUpperCase() !== "CONNECTED") {
          const reason = "WhatsApp is still syncing. Try again in a few seconds";
          await this.logMessage({
            bookingId,
            resortId,
            roomNumber,
            targetNumber,
            status: "skipped",
            error: reason,
          });

          logger.warn("Skipped WhatsApp message because client is not fully ready", {
            resortId,
            bookingId,
            targetNumber,
            messageType,
            clientState: clientState || null,
          });

          return {
            attempted: false,
            sent: false,
            queued: false,
            recipient: displayRecipient,
            reason,
          };
        }

        const chatId = await this.runOperationWithTimeout(
          () => this.validateNumber(targetNumber),
          VALIDATE_NUMBER_TIMEOUT_MS,
          "validate WhatsApp number",
        );

        if (!chatId) {
          const reason = "Number is not registered on WhatsApp";
          await this.logMessage({
            bookingId,
            resortId,
            roomNumber,
            targetNumber,
            status: "failed",
            error: reason,
          });

          logger.warn("WhatsApp number is not registered", {
            resortId,
            bookingId,
            targetNumber,
            messageType,
          });

          return {
            attempted: true,
            sent: false,
            queued: false,
            recipient: displayRecipient,
            reason,
          };
        }

        const response = await this.runOperationWithTimeout(
          () => this.client.sendMessage(chatId, messageText),
          SEND_MESSAGE_TIMEOUT_MS,
          "send WhatsApp message",
        );

        await this.logMessage({
          bookingId,
          resortId,
          roomNumber,
          targetNumber,
          status: "sent",
          whatsappMessageId: response?.id?._serialized || null,
        });

        logger.info("WhatsApp message sent", {
          resortId,
          bookingId,
          targetNumber,
          messageType,
        });

        return {
          attempted: true,
          sent: true,
          queued: false,
          recipient: displayRecipient,
        };
      } catch (error) {
        const reason = getErrorMessage(error);
        await this.logMessage({
          bookingId,
          resortId,
          roomNumber,
          targetNumber,
          status: "failed",
          error: reason,
        });

        logger.error("WhatsApp message failed", {
          resortId,
          bookingId,
          targetNumber,
          messageType,
          error: reason,
        });

        return {
          attempted: true,
          sent: false,
          queued: false,
          recipient: displayRecipient,
          reason,
        };
      }
    });
  }

  async runSendExclusively(task) {
    const pendingLock = this.sendLock;
    let releaseLock = () => {};
    this.sendLock = new Promise((resolve) => {
      releaseLock = resolve;
    });

    await pendingLock;

    try {
      return await task();
    } finally {
      releaseLock();
    }
  }

  async runOperationWithTimeout(executor, timeoutMs, label) {
    return Promise.race([
      Promise.resolve().then(executor),
      new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  }

  async resolveBrowserLaunchConfig() {
    if (this.puppeteerExecutablePath) {
      return {
        executablePath: this.puppeteerExecutablePath,
        useBundledChromium: false,
        browserSource: "env",
      };
    }

    const systemBrowserExecutablePath = resolveSystemBrowserExecutablePath();
    if (systemBrowserExecutablePath) {
      return {
        executablePath: systemBrowserExecutablePath,
        useBundledChromium: false,
        browserSource: "system",
      };
    }

    if (process.env.NODE_ENV !== "production") {
      return {
        executablePath: undefined,
        useBundledChromium: false,
        browserSource: "default",
      };
    }

    return {
      executablePath: await resolveBundledChromiumExecutablePath(),
      useBundledChromium: true,
      browserSource: "bundled",
    };
  }

  scheduleReconnect() {
    if (
      !this.enabled ||
      this.manualLogout ||
      this.shutdownRequested ||
      this.reconnectTimer
    ) {
      return;
    }

    const delay = Math.min(300_000, 5_000 * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.initializeClient();
    }, delay);

    logger.warn("Scheduled WhatsApp reconnect", {
      resortId: this.resortId,
      clientId: this.clientId,
      delayMs: delay,
      attempt: this.reconnectAttempts,
    });
  }

  clearReconnectTimer() {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  clearQueueTimer() {
    if (!this.queueTimer) return;
    clearTimeout(this.queueTimer);
    this.queueTimer = null;
  }

  async destroyClient() {
    if (!this.client) return;

    const currentClient = this.client;
    this.client = null;
    this.clearConnectionRecoveryTimer();

    try {
      currentClient.removeAllListeners();
      await currentClient.destroy();
    } catch {
      void 0;
    }
  }

  getClientSessionDir() {
    return path.join(this.sessionsDir, this.getRemoteAuthSessionName());
  }

  getRemoteAuthSessionName() {
    return this.clientId ? `RemoteAuth-${this.clientId}` : "RemoteAuth";
  }

  getClientTempSessionDir() {
    return path.join(this.sessionsDir, `wwebjs_temp_session_${this.clientId}`);
  }

  getClientSessionArchivePath() {
    return path.join(
      this.sessionsDir,
      `${this.getRemoteAuthSessionName()}.zip`,
    );
  }

  getLegacyLocalAuthSessionDir() {
    return path.join(
      this.sessionsDir,
      this.clientId ? `session-${this.clientId}` : "session",
    );
  }

  async cleanupClientAuthArtifacts() {
    const paths = [
      this.getClientSessionDir(),
      this.getClientTempSessionDir(),
      this.getClientSessionArchivePath(),
      this.getLegacyLocalAuthSessionDir(),
    ];

    await Promise.allSettled(
      [...new Set(paths)].map((artifactPath) =>
        fs.rm(artifactPath, { recursive: true, force: true }),
      ),
    );
  }

  async cleanupLegacyLocalAuthArtifacts() {
    await fs.rm(this.getLegacyLocalAuthSessionDir(), {
      recursive: true,
      force: true,
    });
  }

  async getTodayStats() {
    if (!this.logsCollection) return DEFAULT_STATS;

    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);

    const rows = await this.logsCollection()
      .aggregate([
        {
          $match: {
            ...(this.resortId ? { resortId: this.resortId } : {}),
            createdAt: {
              $gte: start,
              $lt: end,
            },
          },
        },
        {
          $group: {
            _id: "$status",
            count: { $sum: 1 },
          },
        },
      ])
      .toArray();

    const stats = { ...DEFAULT_STATS };

    for (const row of rows) {
      if (row._id === "sent") stats.sentToday = row.count;
      if (row._id === "failed") stats.failedToday = row.count;
      if (row._id === "skipped") stats.skippedToday = row.count;
    }

    stats.totalToday = stats.sentToday + stats.failedToday + stats.skippedToday;
    return stats;
  }

  async getQueueStats() {
    return { ...DEFAULT_QUEUE_STATS };
  }

  async clearStoredQueueMessages() {
    if (!this.queueCollection) return;

    const result = await this.queueCollection().deleteMany({
      resortId: this.resortId,
    });

    if (result.deletedCount > 0) {
      logger.info("Removed stored WhatsApp queue messages", {
        resortId: this.resortId,
        clientId: this.clientId,
        deletedCount: result.deletedCount,
      });
    }
  }

  async logMessage({
    bookingId,
    resortId,
    roomNumber,
    targetNumber,
    status,
    error = null,
    whatsappMessageId = null,
  }) {
    if (!this.logsCollection) return;

    await this.logsCollection().insertOne({
      bookingId,
      resortId,
      roomNumber,
      targetNumber,
      status,
      error,
      whatsappMessageId,
      createdAt: new Date(),
    });
  }
}
