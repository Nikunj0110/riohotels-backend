import { existsSync, promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import QRCode from "qrcode";
import { createLogger } from "../utils/logger.js";

const require = createRequire(import.meta.url);
const { create, ev, STATE } = require("@open-wa/wa-automate");

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

const SEND_MESSAGE_TIMEOUT_MS = 12_000;
const PHONE_LOOKUP_TIMEOUT_MS = 5_000;

const SYSTEM_BROWSER_PATHS = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const randomBetween = (min, max) => {
  const lower = Math.max(0, Number(min) || 0);
  const upper = Math.max(lower, Number(max) || lower);
  if (upper === lower) return lower;
  return Math.floor(Math.random() * (upper - lower + 1)) + lower;
};

const getErrorMessage = (error, fallback = "Unable to send WhatsApp message") =>
  error instanceof Error ? error.message : fallback;

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

const normalizePhoneNumber = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  return digits || null;
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

const resolveSystemBrowserExecutablePath = () =>
  SYSTEM_BROWSER_PATHS.find((browserPath) => existsSync(browserPath));

let launchTurn = Promise.resolve();

export class WhatsAppService {
  constructor({
    enabled = true,
    resortId,
    resortName = "Rio Hotels",
    clientId = "riohotels",
    sessionsDir,
    authStore = null,
    defaultCountryCode = "91",
    puppeteerExecutablePath = "",
    logsCollection,
    sendDelayMinMs = 0,
    sendDelayMaxMs = 0,
  }) {
    this.enabled = enabled;
    this.resortId = resortId;
    this.resortName = resortName;
    this.clientId = clientId;
    this.sessionsDir = sessionsDir;
    this.authStore = authStore;
    this.defaultCountryCode = defaultCountryCode;
    this.puppeteerExecutablePath = puppeteerExecutablePath;
    this.logsCollection = logsCollection;
    this.sendDelayMinMs = Math.max(0, Number(sendDelayMinMs) || 0);
    this.sendDelayMaxMs = Math.max(
      this.sendDelayMinMs,
      Number(sendDelayMaxMs) || this.sendDelayMinMs,
    );

    this.client = null;
    this.initializing = false;
    this.createPromise = null;
    this.pendingLaunchId = null;
    this.activeLaunchId = null;
    this.launchCounter = 0;
    this.status = enabled ? "initializing" : "disabled";
    this.qrCode = null;
    this.qrDataUrl = null;
    this.phoneNumber = null;
    this.connectedAt = null;
    this.lastError = enabled ? null : "WhatsApp automation is disabled";
    this.lastEventAt = null;
    this.reconnectTimer = null;
    this.sendLock = Promise.resolve();
    this.reconnectAttempts = 0;
    this.manualLogout = false;
    this.shutdownRequested = false;
    this.emitterSubscriptions = [];
    this.releaseLaunchTurn = null;
  }

  async init() {
    if (!this.enabled) return this.getStatus();
    await this.initializeClient();
    return this.getStatus();
  }

  async restart() {
    this.manualLogout = false;
    this.shutdownRequested = false;
    this.clearReconnectTimer();
    await this.resetRuntime({ clearStoredSession: false });
    await this.initializeClient();
    return this.getStatus();
  }

  async logout() {
    this.manualLogout = true;
    this.shutdownRequested = false;
    this.clearReconnectTimer();

    if (this.client) {
      try {
        await this.runOperationWithTimeout(
          () => this.client.logout(false),
          SEND_MESSAGE_TIMEOUT_MS,
          "logout WhatsApp session",
        );
      } catch {
        void 0;
      }
    }

    await this.resetRuntime({ clearStoredSession: true });

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
    this.manualLogout = false;
    this.shutdownRequested = false;
    this.clearReconnectTimer();

    if (this.client) {
      try {
        await this.runOperationWithTimeout(
          () => this.client.logout(false),
          SEND_MESSAGE_TIMEOUT_MS,
          "logout WhatsApp session",
        );
      } catch {
        void 0;
      }
    }

    await this.resetRuntime({ clearStoredSession: true });
    await this.initializeClient();
    return this.getStatus();
  }

  async shutdown() {
    this.shutdownRequested = true;
    this.clearReconnectTimer();
    await this.resetRuntime({ clearStoredSession: false });
  }

  async getStatus() {
    return {
      enabled: this.enabled,
      authMode: "openwa-mongodb",
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
      queue: { ...DEFAULT_QUEUE_STATS },
    };
  }

  isReady() {
    return Boolean(this.status === "connected" && this.client);
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

  async initializeClient() {
    if (!this.enabled) {
      this.status = "disabled";
      this.lastError = "WhatsApp automation is disabled";
      this.lastEventAt = new Date().toISOString();
      return this.getStatus();
    }

    if (this.initializing || this.createPromise) {
      return this.getStatus();
    }

    this.initializing = true;
    this.status = this.qrCode ? "qr_waiting" : "initializing";
    this.lastError = null;
    this.lastEventAt = new Date().toISOString();

    try {
      await fs.mkdir(this.sessionsDir, { recursive: true });
      await this.cleanupLocalSessionArtifacts();

      const launchId = ++this.launchCounter;
      this.activeLaunchId = launchId;
      this.pendingLaunchId = launchId;
      const storedSessionData = await this.authStore?.load({
        session: this.clientId,
      });
      const browserConfig = await this.resolveBrowserLaunchConfig();

      this.bindEmitterEvents(launchId);
      await this.acquireLaunchTurn();

      logger.info("Launching WhatsApp browser", {
        resortId: this.resortId,
        clientId: this.clientId,
        browserSource: browserConfig.browserSource,
        executablePath: browserConfig.executablePath || null,
      });

      const pendingLaunch = this.startLaunch({
        launchId,
        storedSessionData,
        browserConfig,
      });

      this.createPromise = pendingLaunch;

      pendingLaunch
        .catch((error) => {
          if (this.activeLaunchId !== launchId) return;
          this.handleLaunchFailure(error);
        })
        .finally(() => {
          if (this.pendingLaunchId !== launchId) return;
          this.pendingLaunchId = null;
          this.createPromise = null;
          this.initializing = false;
        });
    } catch (error) {
      this.initializing = false;
      this.handleLaunchFailure(error);
    }

    return this.getStatus();
  }

  async startLaunch({ launchId, storedSessionData, browserConfig }) {
    const nextClient = await create({
      sessionId: this.clientId,
      multiDevice: true,
      qrTimeout: 0,
      authTimeout: 0,
      waitForRipeSession: true,
      waitForRipeSessionTimeout: 0,
      useChrome: true,
      executablePath: browserConfig.executablePath || undefined,
      sessionDataPath: this.sessionsDir,
      sessionData: storedSessionData || undefined,
      disableSpins: true,
      logConsoleErrors: false,
    });

    if (this.activeLaunchId !== launchId || this.shutdownRequested) {
      try {
        await nextClient.kill("STALE_LAUNCH");
      } catch {
        void 0;
      }
      return;
    }

    this.client = nextClient;
    this.reconnectAttempts = 0;
    await this.bindClientEvents(nextClient, launchId);
    await this.promoteConnected(nextClient, { source: "create" });
  }

  bindEmitterEvents(launchId) {
    this.unbindEmitterEvents();

    const bind = (eventName, handler) => {
      ev.on(eventName, handler);
      this.emitterSubscriptions.push({ eventName, handler });
    };

    bind(`qrData.${this.clientId}`, async (qrData) => {
      if (this.activeLaunchId !== launchId) return;

      this.status = "qr_waiting";
      this.qrCode = String(qrData || "");
      this.connectedAt = null;
      this.phoneNumber = null;
      this.lastError = null;
      this.lastEventAt = new Date().toISOString();

      try {
        this.qrDataUrl = await QRCode.toDataURL(this.qrCode);
      } catch {
        this.qrDataUrl = null;
      }

      logger.info("WhatsApp QR generated", {
        resortId: this.resortId,
        clientId: this.clientId,
      });

      this.releaseLaunchTurnIfHeld();
    });

    bind(`qr.${this.clientId}`, async (qrImage) => {
      if (this.activeLaunchId !== launchId) return;

      this.status = "qr_waiting";
      this.connectedAt = null;
      this.phoneNumber = null;
      this.lastError = null;
      this.lastEventAt = new Date().toISOString();

      if (typeof qrImage === "string" && qrImage.trim()) {
        this.qrDataUrl = qrImage;
      }

      if (!this.qrCode && typeof qrImage === "string" && qrImage.trim()) {
        this.qrCode = qrImage;
      }

      this.releaseLaunchTurnIfHeld();
    });

    bind(`sessionDataBase64.${this.clientId}`, async (sessionDataBase64) => {
      if (this.activeLaunchId !== launchId || !this.authStore) return;

      try {
        await this.authStore.save({
          session: this.clientId,
          sessionData: String(sessionDataBase64 || ""),
        });

        logger.info("WhatsApp remote session saved", {
          resortId: this.resortId,
          clientId: this.clientId,
        });
      } catch (error) {
        logger.error("Failed to persist WhatsApp session", {
          resortId: this.resortId,
          clientId: this.clientId,
          error: getErrorMessage(error, "Unable to persist WhatsApp session"),
        });
      }
    });
  }

  unbindEmitterEvents() {
    for (const subscription of this.emitterSubscriptions) {
      ev.off(subscription.eventName, subscription.handler);
    }

    this.emitterSubscriptions = [];
  }

  async bindClientEvents(client, launchId) {
    try {
      await client.onStateChanged((state) => {
        if (this.client !== client || this.activeLaunchId !== launchId) return;
        void this.handleClientState(client, state);
      });
    } catch {
      void 0;
    }

    try {
      await client.onLogout(() => {
        if (this.client !== client || this.activeLaunchId !== launchId) return;
        void this.handleUnexpectedLogout();
      });
    } catch {
      void 0;
    }
  }

  async handleClientState(client, state) {
    const normalizedState = String(state || "").toUpperCase();
    this.lastEventAt = new Date().toISOString();

    logger.info("WhatsApp client state changed", {
      resortId: this.resortId,
      clientId: this.clientId,
      state: normalizedState,
    });

    if (normalizedState === String(STATE.CONNECTED)) {
      await this.promoteConnected(client, { source: "state:CONNECTED" });
      return;
    }

    if (
      [
        String(STATE.UNPAIRED),
        String(STATE.UNPAIRED_IDLE),
        String(STATE.PAIRING),
      ].includes(normalizedState)
    ) {
      this.status = "qr_waiting";
      this.connectedAt = null;
      this.phoneNumber = null;
      return;
    }

    if (
      [
        String(STATE.OPENING),
        String(STATE.SYNCING),
        String(STATE.PROXYBLOCK),
      ].includes(normalizedState)
    ) {
      this.status = "initializing";
      return;
    }

    if (normalizedState === String(STATE.CONFLICT)) {
      try {
        await client.forceRefocus();
      } catch {
        void 0;
      }
      return;
    }

    if (
      [
        String(STATE.DISCONNECTED),
        String(STATE.TIMEOUT),
        String(STATE.TOS_BLOCK),
        String(STATE.SMB_TOS_BLOCK),
      ].includes(normalizedState)
    ) {
      this.markClientUnhealthy(`WhatsApp state changed to ${normalizedState}`);
    }
  }

  async handleUnexpectedLogout() {
    this.status = "disconnected";
    this.connectedAt = null;
    this.phoneNumber = null;
    this.qrCode = null;
    this.qrDataUrl = null;
    this.lastError = "WhatsApp session logged out";
    this.lastEventAt = new Date().toISOString();

    logger.warn("WhatsApp client logged out", {
      resortId: this.resortId,
      clientId: this.clientId,
    });

    this.releaseLaunchTurnIfHeld();

    try {
      await this.clearStoredSession();
    } catch (error) {
      logger.error("Failed to clear logged out WhatsApp session", {
        resortId: this.resortId,
        clientId: this.clientId,
        error: getErrorMessage(error, "Unable to clear WhatsApp session"),
      });
    }

    if (!this.manualLogout && !this.shutdownRequested) {
      this.scheduleReconnect();
    }
  }

  async promoteConnected(client, { source }) {
    if (this.client !== client) return;

    const phoneNumber = await this.resolveConnectedPhoneNumber(client);
    this.status = "connected";
    this.qrCode = null;
    this.qrDataUrl = null;
    this.phoneNumber = phoneNumber || this.phoneNumber;
    this.connectedAt = this.connectedAt || new Date().toISOString();
    this.lastError = null;
    this.lastEventAt = new Date().toISOString();
    this.reconnectAttempts = 0;

    logger.info("WhatsApp client connected", {
      resortId: this.resortId,
      clientId: this.clientId,
      source,
      phoneNumber: this.phoneNumber,
    });

    this.releaseLaunchTurnIfHeld();
  }

  async resolveConnectedPhoneNumber(client) {
    try {
      const hostNumber = await this.runOperationWithTimeout(
        () => client.getHostNumber(),
        PHONE_LOOKUP_TIMEOUT_MS,
        "load WhatsApp host number",
      );
      return formatDisplayPhoneNumber(normalizePhoneNumber(hostNumber));
    } catch {
      void 0;
    }

    try {
      const me = await this.runOperationWithTimeout(
        () => client.getMe(),
        PHONE_LOOKUP_TIMEOUT_MS,
        "load WhatsApp profile",
      );
      return formatDisplayPhoneNumber(
        normalizePhoneNumber(
          me?.wid || me?.me || me?.id || me?.user || me?._serialized,
        ),
      );
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

      if (this.sendDelayMaxMs > 0) {
        await sleep(randomBetween(this.sendDelayMinMs, this.sendDelayMaxMs));
      }

      try {
        const response = await this.runOperationWithTimeout(
          () => this.client.sendText(`${targetNumber}@c.us`, messageText),
          SEND_MESSAGE_TIMEOUT_MS,
          "send WhatsApp message",
        );

        if (response === false) {
          throw new Error("WhatsApp rejected the send request");
        }

        await this.logMessage({
          bookingId,
          resortId,
          roomNumber,
          targetNumber,
          status: "sent",
          whatsappMessageId:
            typeof response === "string"
              ? response
              : response?._serialized || response?.id || null,
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
        const rawReason = getErrorMessage(error);
        const normalizedReason = String(rawReason).toLowerCase();
        const isTimeoutFailure =
          normalizedReason.includes("timed out") ||
          normalizedReason.includes("protocolerror") ||
          normalizedReason.includes("runtime.callfunctionon") ||
          normalizedReason.includes("connection state timed out");
        const reason = isTimeoutFailure
          ? "WhatsApp session stopped responding. Restart the session and try again."
          : rawReason;

        await this.logMessage({
          bookingId,
          resortId,
          roomNumber,
          targetNumber,
          status: "failed",
          error: reason,
        });

        if (isTimeoutFailure) {
          this.markClientUnhealthy(rawReason, {
            bookingId,
            targetNumber,
            messageType,
          });
        }

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
    let timedOut = false;
    let timer = null;

    const operationPromise = Promise.resolve().then(executor);
    operationPromise.catch((error) => {
      if (!timedOut) return;

      logger.warn("WhatsApp operation rejected after timeout", {
        resortId: this.resortId,
        clientId: this.clientId,
        operation: label,
        error: getErrorMessage(error, `${label} failed after timeout`),
      });
    });

    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    try {
      return await Promise.race([operationPromise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  markClientUnhealthy(reason, context = {}) {
    this.status = "disconnected";
    this.connectedAt = null;
    this.qrCode = null;
    this.qrDataUrl = null;
    this.lastError = reason;
    this.lastEventAt = new Date().toISOString();

    logger.warn("Marked WhatsApp client unhealthy", {
      resortId: this.resortId,
      clientId: this.clientId,
      reason,
      ...context,
    });

    this.releaseLaunchTurnIfHeld();

    if (!this.manualLogout && !this.shutdownRequested) {
      this.scheduleReconnect();
    }
  }

  resolveBrowserLaunchConfig() {
    if (this.puppeteerExecutablePath) {
      return {
        executablePath: this.puppeteerExecutablePath,
        browserSource: "env",
      };
    }

    const systemBrowserExecutablePath = resolveSystemBrowserExecutablePath();
    if (systemBrowserExecutablePath) {
      return {
        executablePath: systemBrowserExecutablePath,
        browserSource: "system",
      };
    }

    return {
      executablePath: undefined,
      browserSource: "default",
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
      void this.restart();
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

  async resetRuntime({ clearStoredSession }) {
    this.activeLaunchId = null;
    this.pendingLaunchId = null;
    this.createPromise = null;
    this.initializing = false;
    this.unbindEmitterEvents();
    this.releaseLaunchTurnIfHeld();

    if (this.client) {
      const currentClient = this.client;
      this.client = null;

      try {
        await currentClient.kill("MANUALLY_KILLED");
      } catch {
        void 0;
      }
    }

    if (clearStoredSession) {
      await this.clearStoredSession();
    } else {
      await this.cleanupLocalSessionArtifacts();
    }
  }

  getLocalSessionDataFile() {
    return path.join(this.sessionsDir, `${this.clientId}.data.json`);
  }

  getLocalUserDataDir() {
    return path.join(this.sessionsDir, `_IGNORE_${this.clientId}`);
  }

  async cleanupLocalSessionArtifacts() {
    await Promise.allSettled([
      fs.rm(this.getLocalSessionDataFile(), { force: true }),
      fs.rm(this.getLocalUserDataDir(), { recursive: true, force: true }),
    ]);
  }

  async clearStoredSession() {
    await this.cleanupLocalSessionArtifacts();
    if (!this.authStore) return;
    await this.authStore.delete({ session: this.clientId });
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

  handleLaunchFailure(error) {
    this.status = "disconnected";
    this.lastError = getErrorMessage(
      error,
      "Unable to initialize WhatsApp client",
    );
    this.connectedAt = null;
    this.phoneNumber = null;
    this.qrCode = null;
    this.qrDataUrl = null;
    this.lastEventAt = new Date().toISOString();

    logger.error("Failed to initialize WhatsApp client", {
      resortId: this.resortId,
      clientId: this.clientId,
      error: this.lastError,
    });

    this.releaseLaunchTurnIfHeld();

    if (!this.manualLogout && !this.shutdownRequested) {
      this.scheduleReconnect();
    }
  }

  async acquireLaunchTurn() {
    const previousTurn = launchTurn;
    let release = () => {};
    launchTurn = new Promise((resolve) => {
      release = resolve;
    });
    this.releaseLaunchTurn = release;
    await previousTurn;
  }

  releaseLaunchTurnIfHeld() {
    if (!this.releaseLaunchTurn) return;
    const release = this.releaseLaunchTurn;
    this.releaseLaunchTurn = null;
    release();
  }
}
