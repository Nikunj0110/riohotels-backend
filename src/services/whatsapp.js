import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import QRCode from "qrcode";
import whatsappWeb from "whatsapp-web.js";
import chromium from "@sparticuz/chromium";
import { createLogger } from "../utils/logger.js";

const { Client, LocalAuth } = whatsappWeb;
const logger = createLogger("whatsapp");

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

let bundledChromiumExecutablePathPromise = null;

const TRANSIENT_RETRY_NOTICE = "Message queued for automatic retry.";
const OFFLINE_QUEUE_NOTICE =
  "WhatsApp client is offline. Message queued for automatic delivery.";
const BUSY_QUEUE_NOTICE =
  "Another WhatsApp message is being processed. Message queued for delivery.";

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

export class WhatsAppService {
  constructor({
    enabled = true,
    resortId,
    resortName = "Rio Hotels",
    clientId = "riohotels",
    sessionsDir,
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
    this.reconnectAttempts = 0;
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
    await this.releaseProcessingMessages();
    await this.destroyClient();
    return this.initializeClient();
  }

  async logout() {
    this.manualLogout = true;
    this.clearReconnectTimer();
    this.clearQueueTimer();
    await this.releaseProcessingMessages();

    if (this.client) {
      try {
        await this.client.logout();
      } catch {
        void 0;
      }
    }

    await this.destroyClient();
    await fs.rm(this.getClientSessionDir(), { recursive: true, force: true });

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
    await this.releaseProcessingMessages();
    await this.destroyClient();
  }

  async getStatus() {
    return {
      enabled: this.enabled,
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
    return this.status === "connected" && Boolean(this.client?.info?.wid?.user);
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

    return this.queueTextMessage({
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

    return this.queueTextMessage({
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

    try {
      await fs.mkdir(this.sessionsDir, { recursive: true });
      await this.releaseProcessingMessages();
      await this.destroyClient();

      const useBundledChromium =
        process.env.NODE_ENV === "production" &&
        !this.puppeteerExecutablePath;
      const executablePath = await this.resolveExecutablePath();

      const nextClient = new Client({
        authStrategy: new LocalAuth({
          clientId: this.clientId,
          dataPath: this.sessionsDir,
          rmMaxRetries: this.sessionRmMaxRetries,
        }),
        takeoverOnConflict: true,
        takeoverTimeoutMs: 0,
        puppeteer: {
          headless: useBundledChromium ? "shell" : true,
          args: buildChromiumArgs(useBundledChromium),
          defaultViewport: DEFAULT_VIEWPORT,
          timeout: 60_000,
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

      this.status = "connected";
      this.connectedAt = new Date().toISOString();
      this.phoneNumber = formatDisplayPhoneNumber(
        nextClient.info?.wid?.user || null,
      );
      this.qrCode = null;
      this.qrDataUrl = null;
      this.lastError = null;
      this.lastEventAt = new Date().toISOString();
      this.reconnectAttempts = 0;
      this.clearReconnectTimer();

      logger.info("WhatsApp client connected", {
        resortId: this.resortId,
        clientId: this.clientId,
        phoneNumber: this.phoneNumber,
      });

      void this.processQueue();
    });

    nextClient.on("authenticated", () => {
      if (this.client !== nextClient) return;

      this.lastError = null;
      this.lastEventAt = new Date().toISOString();
      logger.info("WhatsApp client authenticated", {
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

      if (!this.manualLogout) {
        this.scheduleReconnect();
      }
    });

    nextClient.on("change_state", (state) => {
      if (this.client !== nextClient) return;
      this.lastEventAt = new Date().toISOString();
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

  async resolveExecutablePath() {
    if (this.puppeteerExecutablePath) {
      return this.puppeteerExecutablePath;
    }

    if (process.env.NODE_ENV !== "production") {
      return undefined;
    }

    return resolveBundledChromiumExecutablePath();
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

  scheduleQueuePoll(delayMs = this.queuePollIntervalMs) {
    if (
      !this.enabled ||
      !this.queueCollection ||
      this.manualLogout ||
      this.shutdownRequested
    ) {
      return;
    }

    const delay = Math.max(250, Number(delayMs) || this.queuePollIntervalMs);
    this.clearQueueTimer();
    this.queueTimer = setTimeout(() => {
      this.queueTimer = null;
      void this.processQueue();
    }, delay);
  }

  clearQueueTimer() {
    if (!this.queueTimer) return;
    clearTimeout(this.queueTimer);
    this.queueTimer = null;
  }

  async processQueue({
    maxJobs = Number.POSITIVE_INFINITY,
    preferredQueueId = null,
  } = {}) {
    if (
      !this.enabled ||
      !this.queueCollection ||
      this.queueProcessing ||
      this.shutdownRequested
    ) {
      return;
    }

    if (!this.client || !this.isReady()) {
      if (!this.manualLogout) {
        this.scheduleQueuePoll();
      }
      return;
    }

    this.queueProcessing = true;
    this.clearQueueTimer();

    let processed = 0;
    let preferredId = preferredQueueId;

    try {
      while (
        processed < maxJobs &&
        !this.shutdownRequested &&
        this.client &&
        this.isReady()
      ) {
        const queuedMessage = await this.claimNextMessage(preferredId);
        preferredId = null;

        if (!queuedMessage) {
          break;
        }

        await this.processClaimedMessage(queuedMessage);
        processed += 1;

        if (processed < maxJobs) {
          await sleep(randomBetween(this.sendDelayMinMs, this.sendDelayMaxMs));
        }
      }
    } finally {
      this.queueProcessing = false;

      if (!this.manualLogout && !this.shutdownRequested) {
        this.scheduleQueuePoll(
          processed > 0 ? this.sendDelayMinMs : this.queuePollIntervalMs,
        );
      }
    }
  }

  async claimNextMessage(preferredQueueId = null) {
    if (!this.queueCollection) return null;

    const now = new Date();
    const staleLockAt = new Date(now.getTime() - this.queueLockTtlMs);

    const buildFilter = (extra = {}) => ({
      resortId: this.resortId,
      status: {
        $in: [JOB_STATUS.PENDING, JOB_STATUS.PROCESSING],
      },
      nextAttemptAt: { $lte: now },
      $or: [
        { lockedAt: { $exists: false } },
        { lockedAt: null },
        { lockedAt: { $lt: staleLockAt } },
      ],
      ...extra,
    });

    const claimUpdate = {
      $set: {
        status: JOB_STATUS.PROCESSING,
        lockedAt: now,
        lastAttemptAt: now,
        updatedAt: now,
      },
      $inc: {
        attempts: 1,
      },
    };

    if (preferredQueueId) {
      const preferredMessage = await this.queueCollection().findOneAndUpdate(
        buildFilter({ _id: preferredQueueId }),
        claimUpdate,
        {
          returnDocument: "after",
        },
      );

      if (preferredMessage) {
        return preferredMessage;
      }
    }

    return this.queueCollection().findOneAndUpdate(buildFilter(), claimUpdate, {
      sort: { nextAttemptAt: 1, createdAt: 1 },
      returnDocument: "after",
    });
  }

  async processClaimedMessage(queuedMessage) {
    try {
      const chatId = await this.validateNumber(queuedMessage.targetNumber);

      if (!chatId) {
        const reason = "Number is not registered on WhatsApp";
        await this.markMessagePermanentFailure(queuedMessage, reason);
        await this.logMessage({
          bookingId: queuedMessage.bookingId,
          resortId: queuedMessage.resortId,
          roomNumber: queuedMessage.roomNumber,
          targetNumber: queuedMessage.targetNumber,
          status: "failed",
          error: reason,
        });

        logger.warn("WhatsApp number is not registered", {
          resortId: queuedMessage.resortId,
          bookingId: queuedMessage.bookingId,
          targetNumber: queuedMessage.targetNumber,
        });

        return;
      }

      const response = await this.client.sendMessage(
        chatId,
        queuedMessage.messageText,
      );

      await this.markMessageSent(
        queuedMessage,
        response?.id?._serialized || null,
      );

      await this.logMessage({
        bookingId: queuedMessage.bookingId,
        resortId: queuedMessage.resortId,
        roomNumber: queuedMessage.roomNumber,
        targetNumber: queuedMessage.targetNumber,
        status: "sent",
        whatsappMessageId: response?.id?._serialized || null,
      });

      logger.info("WhatsApp message sent", {
        resortId: queuedMessage.resortId,
        bookingId: queuedMessage.bookingId,
        targetNumber: queuedMessage.targetNumber,
        attempts: queuedMessage.attempts,
      });
    } catch (error) {
      const reason = getErrorMessage(error);

      if (
        isPermanentError(reason) ||
        queuedMessage.attempts >= this.maxQueueAttempts
      ) {
        const finalReason =
          queuedMessage.attempts >= this.maxQueueAttempts
            ? `Max retry attempts reached: ${reason}`
            : reason;

        await this.markMessagePermanentFailure(queuedMessage, finalReason);
        await this.logMessage({
          bookingId: queuedMessage.bookingId,
          resortId: queuedMessage.resortId,
          roomNumber: queuedMessage.roomNumber,
          targetNumber: queuedMessage.targetNumber,
          status: "failed",
          error: finalReason,
        });

        logger.error("WhatsApp message failed permanently", {
          resortId: queuedMessage.resortId,
          bookingId: queuedMessage.bookingId,
          targetNumber: queuedMessage.targetNumber,
          attempts: queuedMessage.attempts,
          error: finalReason,
        });

        return;
      }

      const nextAttemptAt = new Date(
        Date.now() + this.calculateRetryDelay(queuedMessage.attempts),
      );

      await this.rescheduleMessage(queuedMessage, reason, nextAttemptAt);

      logger.warn("WhatsApp message queued for retry", {
        resortId: queuedMessage.resortId,
        bookingId: queuedMessage.bookingId,
        targetNumber: queuedMessage.targetNumber,
        attempts: queuedMessage.attempts,
        error: reason,
        nextAttemptAt: nextAttemptAt.toISOString(),
      });
    }
  }

  calculateRetryDelay(attempts) {
    const exponential = Math.min(
      this.queueRetryMaxMs,
      this.queueRetryBaseMs * 2 ** Math.max(0, attempts - 1),
    );
    return exponential + randomBetween(1_000, 5_000);
  }

  async queueTextMessage({
    bookingId,
    resortId,
    roomNumber,
    targetNumber,
    displayRecipient,
    messageType,
    messageText,
  }) {
    const queuedMessage = await this.enqueueMessage({
      bookingId,
      resortId,
      roomNumber,
      targetNumber,
      messageText,
      messageType,
    });

    if (!queuedMessage) {
      return {
        attempted: false,
        sent: false,
        queued: false,
        recipient: displayRecipient,
        reason: "Unable to queue WhatsApp message",
      };
    }

    if (!this.client || !this.isReady()) {
      this.scheduleQueuePoll();
      return {
        attempted: Boolean(queuedMessage.attempts),
        sent: false,
        queued: true,
        recipient: displayRecipient,
        reason: OFFLINE_QUEUE_NOTICE,
      };
    }

    if (this.queueProcessing) {
      this.scheduleQueuePoll(this.sendDelayMinMs);
      return {
        attempted: Boolean(queuedMessage.attempts),
        sent: false,
        queued: true,
        recipient: displayRecipient,
        reason: BUSY_QUEUE_NOTICE,
      };
    }

    await this.processQueue({
      maxJobs: 1,
      preferredQueueId: queuedMessage._id,
    });

    const latestMessage = await this.getQueueMessage(queuedMessage._id);
    return this.buildDeliveryResult(latestMessage, displayRecipient);
  }

  async enqueueMessage({
    bookingId,
    resortId,
    roomNumber,
    targetNumber,
    messageText,
    messageType = "booking_confirmation",
  }) {
    if (!this.queueCollection) return null;

    const now = new Date();

    const queuedMessage = await this.queueCollection().findOneAndUpdate(
      {
        bookingId,
        messageType,
      },
      {
        $setOnInsert: {
          bookingId,
          messageType,
          status: JOB_STATUS.PENDING,
          attempts: 0,
          lockedAt: null,
          nextAttemptAt: now,
          createdAt: now,
        },
        $set: {
          resortId,
          roomNumber,
          targetNumber,
          messageText,
          updatedAt: now,
        },
      },
      {
        upsert: true,
        returnDocument: "after",
      },
    );

    logger.info("WhatsApp message queued", {
      resortId,
      bookingId,
      targetNumber,
      status: queuedMessage?.status || JOB_STATUS.PENDING,
    });

    return queuedMessage;
  }

  async getQueueMessage(queueId) {
    if (!this.queueCollection) return null;

    return this.queueCollection().findOne({
      _id: queueId,
      resortId: this.resortId,
    });
  }

  buildDeliveryResult(queuedMessage, recipient) {
    if (!queuedMessage) {
      return {
        attempted: false,
        sent: false,
        queued: true,
        recipient,
        reason: TRANSIENT_RETRY_NOTICE,
      };
    }

    if (queuedMessage.status === JOB_STATUS.SENT) {
      return {
        attempted: true,
        sent: true,
        queued: false,
        recipient,
      };
    }

    if (queuedMessage.status === JOB_STATUS.FAILED_PERMANENT) {
      return {
        attempted: Boolean(queuedMessage.attempts),
        sent: false,
        queued: false,
        recipient,
        reason: queuedMessage.lastError || "Unable to send WhatsApp message",
      };
    }

    return {
      attempted: Boolean(queuedMessage.attempts),
      sent: false,
      queued: true,
      recipient,
      reason: queuedMessage.lastError
        ? `Message queued for retry: ${queuedMessage.lastError}`
        : TRANSIENT_RETRY_NOTICE,
    };
  }

  async markMessageSent(queuedMessage, whatsappMessageId) {
    if (!this.queueCollection) return;

    const now = new Date();
    await this.queueCollection().updateOne(
      {
        _id: queuedMessage._id,
      },
      {
        $set: {
          status: JOB_STATUS.SENT,
          lockedAt: null,
          lastError: null,
          whatsappMessageId,
          sentAt: now,
          updatedAt: now,
        },
      },
    );
  }

  async markMessagePermanentFailure(queuedMessage, reason) {
    if (!this.queueCollection) return;

    await this.queueCollection().updateOne(
      {
        _id: queuedMessage._id,
      },
      {
        $set: {
          status: JOB_STATUS.FAILED_PERMANENT,
          lockedAt: null,
          lastError: reason,
          updatedAt: new Date(),
        },
      },
    );
  }

  async rescheduleMessage(queuedMessage, reason, nextAttemptAt) {
    if (!this.queueCollection) return;

    await this.queueCollection().updateOne(
      {
        _id: queuedMessage._id,
      },
      {
        $set: {
          status: JOB_STATUS.PENDING,
          lockedAt: null,
          lastError: reason,
          nextAttemptAt,
          updatedAt: new Date(),
        },
      },
    );
  }

  async releaseProcessingMessages() {
    if (!this.queueCollection) return;

    await this.queueCollection().updateMany(
      {
        resortId: this.resortId,
        status: JOB_STATUS.PROCESSING,
      },
      {
        $set: {
          status: JOB_STATUS.PENDING,
          lockedAt: null,
          updatedAt: new Date(),
        },
      },
    );
  }

  async destroyClient() {
    if (!this.client) return;

    const currentClient = this.client;
    this.client = null;

    try {
      currentClient.removeAllListeners();
      await currentClient.destroy();
    } catch {
      void 0;
    }
  }

  getClientSessionDir() {
    return path.join(
      this.sessionsDir,
      this.clientId ? `session-${this.clientId}` : "session",
    );
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
    if (!this.queueCollection) return DEFAULT_QUEUE_STATS;

    const [pending, processing, failed] = await Promise.all([
      this.queueCollection().countDocuments({
        resortId: this.resortId,
        status: JOB_STATUS.PENDING,
      }),
      this.queueCollection().countDocuments({
        resortId: this.resortId,
        status: JOB_STATUS.PROCESSING,
      }),
      this.queueCollection().countDocuments({
        resortId: this.resortId,
        status: JOB_STATUS.FAILED_PERMANENT,
      }),
    ]);

    return {
      pending,
      processing,
      failed,
    };
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
