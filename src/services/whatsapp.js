import { existsSync, promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import QRCode from "qrcode";
import chromium from "@sparticuz/chromium";
import whatsappWeb from "whatsapp-web.js";
import { createLogger } from "../utils/logger.js";

const { Client, RemoteAuth, WAState } = whatsappWeb;
const require = createRequire(import.meta.url);
const { LoadUtils } = require("whatsapp-web.js/src/util/Injected/Utils.js");
const ClientInfo = require("whatsapp-web.js/src/structures/ClientInfo.js");
const InterfaceController = require("whatsapp-web.js/src/util/InterfaceController.js");

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
const STATE_CHECK_TIMEOUT_MS = 5_000;
const READY_RECOVERY_DELAY_MS = 1_250;
const QR_CODE_WIDTH = 320;
const DEFAULT_REMOTE_AUTH_BACKUP_SYNC_INTERVAL_MS = 300_000;
const SYSTEM_BROWSER_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
];
const SYSTEM_BROWSER_PATHS = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
];

let launchTurn = Promise.resolve();
let bundledChromiumExecutablePathPromise = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const randomBetween = (min, max) => {
  const lower = Math.max(0, Number(min) || 0);
  const upper = Math.max(lower, Number(max) || lower);
  if (upper === lower) return lower;
  return Math.floor(Math.random() * (upper - lower + 1)) + lower;
};

const getErrorMessage = (
  error,
  fallback = "Unable to process WhatsApp request",
) => (error instanceof Error ? error.message : fallback);

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

const normalizePhoneNumber = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  return digits || null;
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

const resolveSystemBrowserExecutablePath = () =>
  SYSTEM_BROWSER_PATHS.find((browserPath) => existsSync(browserPath));

const acquireLaunchTurn = async () => {
  const previousTurn = launchTurn;
  let releaseTurn = () => {};
  launchTurn = new Promise((resolve) => {
    releaseTurn = resolve;
  });
  await previousTurn;
  return releaseTurn;
};

const resolveBundledChromiumExecutablePath = async () => {
  if (!bundledChromiumExecutablePathPromise) {
    bundledChromiumExecutablePathPromise = chromium.executablePath();
  }

  try {
    return await bundledChromiumExecutablePathPromise;
  } catch (error) {
    bundledChromiumExecutablePathPromise = null;
    throw error;
  }
};

const isRecoverableClientError = (message) =>
  /Protocol error|Target closed|Session closed|Execution context was destroyed|Most likely the page has been closed|Timed out|frame was detached|navigation/i.test(
    String(message || ""),
  );

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
    remoteAuthBackupSyncIntervalMs = DEFAULT_REMOTE_AUTH_BACKUP_SYNC_INTERVAL_MS,
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
    this.remoteAuthBackupSyncIntervalMs = Math.max(
      60_000,
      Number(remoteAuthBackupSyncIntervalMs) ||
        DEFAULT_REMOTE_AUTH_BACKUP_SYNC_INTERVAL_MS,
    );

    this.client = null;
    this.initializing = false;
    this.createPromise = null;
    this.qrCode = null;
    this.qrDataUrl = null;
    this.phoneNumber = null;
    this.connectedAt = null;
    this.lastError = enabled ? null : "WhatsApp automation is disabled";
    this.lastEventAt = null;
    this.lastKnownState = WAState.UNLAUNCHED;
    this.lastLoadingPercent = null;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.sendLock = Promise.resolve();
    this.recoveryPromise = null;
    this.manualLogout = false;
    this.shutdownRequested = false;
    this.status = enabled ? "initializing" : "disabled";
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

    const activeClient = this.client;
    if (activeClient) {
      try {
        await this.runOperationWithTimeout(
          () => activeClient.logout(),
          10_000,
          "Timed out while logging out WhatsApp session",
        );
      } catch (error) {
        logger.warn("WhatsApp logout failed before cleanup", {
          resortId: this.resortId,
          clientId: this.clientId,
          error: getErrorMessage(error),
        });
      }
    }

    await this.resetRuntime({ clearStoredSession: true });
    this.markDisconnected("WhatsApp session logged out");
    return this.getStatus();
  }

  async regenerateQr() {
    this.manualLogout = false;
    this.shutdownRequested = false;
    this.clearReconnectTimer();
    await this.resetRuntime({ clearStoredSession: true });
    await this.initializeClient();
    return this.getStatus();
  }

  async shutdown() {
    this.shutdownRequested = true;
    this.manualLogout = false;
    this.clearReconnectTimer();
    await this.destroyClient();
  }

  async getStatus() {
    return {
      enabled: this.enabled,
      authMode: "remote-mongodb",
      resortId: this.resortId,
      resortName: this.resortName,
      status: this.enabled ? this.status : "disabled",
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

  async sendBookingConfirmation(booking, resort) {
    const resortName = resort?.name || this.resortName;
    const targetNumber = sanitizePhoneNumber(
      booking.mobile,
      this.defaultCountryCode,
    );
    const recipient = formatDisplayPhoneNumber(targetNumber);

    if (!this.enabled) {
      return {
        attempted: false,
        sent: false,
        queued: false,
        recipient,
        reason: "WhatsApp automation is disabled",
      };
    }

    if (!targetNumber) {
      const reason = "Guest mobile number is invalid for WhatsApp delivery";
      await this.logMessage({
        bookingId: booking.id,
        recipient,
        status: "skipped",
        messageType: "booking_confirmation",
        error: reason,
      });
      return {
        attempted: false,
        sent: false,
        queued: false,
        recipient,
        reason,
      };
    }

    return this.sendTextMessageNow({
      bookingId: booking.id,
      targetNumber,
      message: buildBookingMessage({ booking, resortName }),
      messageType: "booking_confirmation",
    });
  }

  async sendMultiBookingConfirmation(summary, resort) {
    const resortName = resort?.name || this.resortName;
    const targetNumber = sanitizePhoneNumber(
      summary.mobile,
      this.defaultCountryCode,
    );
    const recipient = formatDisplayPhoneNumber(targetNumber);

    if (!this.enabled) {
      return {
        attempted: false,
        sent: false,
        queued: false,
        recipient,
        reason: "WhatsApp automation is disabled",
      };
    }

    if (!targetNumber) {
      const reason = "Guest mobile number is invalid for WhatsApp delivery";
      await this.logMessage({
        bookingId: summary.bookingId,
        recipient,
        status: "skipped",
        messageType: "booking_confirmation",
        error: reason,
      });
      return {
        attempted: false,
        sent: false,
        queued: false,
        recipient,
        reason,
      };
    }

    return this.sendTextMessageNow({
      bookingId: summary.bookingId,
      targetNumber,
      message: buildMultiBookingMessage({
        ...summary,
        resortName,
      }),
      messageType: "booking_confirmation",
    });
  }

  async initializeClient() {
    if (!this.enabled) return this.getStatus();
    if (this.shutdownRequested) return this.getStatus();
    if (this.client || this.createPromise) {
      return this.createPromise || this.getStatus();
    }

    this.initializing = true;
    this.status = this.qrDataUrl ? "qr_waiting" : "initializing";
    this.lastError = null;

    this.createPromise = (async () => {
      const releaseLaunchTurn = await acquireLaunchTurn();

      try {
        const browserConfig = await this.resolveBrowserLaunchConfig();
        logger.info("Launching WhatsApp browser", {
          resortId: this.resortId,
          clientId: this.clientId,
          executablePath: browserConfig.executablePath || "bundled-default",
          browserSource: browserConfig.browserSource,
        });

        const client = new Client({
          authStrategy: new RemoteAuth({
            clientId: this.clientId,
            store: this.authStore,
            dataPath: this.sessionsDir,
            backupSyncIntervalMs: this.remoteAuthBackupSyncIntervalMs,
          }),
          authTimeoutMs: 0,
          qrMaxRetries: 0,
          takeoverOnConflict: true,
          takeoverTimeoutMs: 0,
          deviceName: this.resortName,
          browserName: "Rio Hotels",
          puppeteer: {
            headless: browserConfig.headless,
            executablePath: browserConfig.executablePath,
            args: browserConfig.args,
            defaultViewport: null,
            ignoreHTTPSErrors: true,
          },
        });

        this.client = client;
        this.attachClientListeners(client);
        await client.initialize();
      } catch (error) {
        const message = getErrorMessage(
          error,
          "Unable to initialize WhatsApp client",
        );
        logger.error("Failed to initialize WhatsApp client", {
          resortId: this.resortId,
          clientId: this.clientId,
          error: message,
        });
        this.markDisconnected(message);
        await this.destroyClient();
        this.scheduleReconnect("init_failure");
      } finally {
        releaseLaunchTurn();
        this.initializing = false;
        this.createPromise = null;
      }

      return this.getStatus();
    })();

    return this.createPromise;
  }

  attachClientListeners(client) {
    const bind = (event, handler) => {
      client.on(event, (...args) => {
        void (async () => {
          if (client !== this.client) return;
          await handler(...args);
        })().catch((error) => {
          logger.warn("WhatsApp event handler failed", {
            resortId: this.resortId,
            clientId: this.clientId,
            event,
            error: getErrorMessage(error),
          });
        });
      });
    };

    bind("qr", (qr) => this.handleQr(qr));
    bind("authenticated", () => this.handleAuthenticated());
    bind("ready", () => this.handleReady());
    bind("loading_screen", (percent) => this.handleLoadingScreen(percent));
    bind("change_state", (state) => this.handleStateChange(state));
    bind("auth_failure", (message) => this.handleAuthFailure(message));
    bind("disconnected", (reason) => this.handleDisconnected(reason));
    bind("remote_session_saved", () => this.handleRemoteSessionSaved());
  }

  async handleQr(qr) {
    this.qrCode = qr;
    this.qrDataUrl = await QRCode.toDataURL(qr, {
      width: QR_CODE_WIDTH,
      margin: 1,
    });
    this.status = "qr_waiting";
    this.phoneNumber = null;
    this.connectedAt = null;
    this.lastError = null;
    this.lastEventAt = new Date().toISOString();
    this.lastKnownState = WAState.UNPAIRED;

    logger.info("WhatsApp QR generated", {
      resortId: this.resortId,
      clientId: this.clientId,
    });
  }

  async handleAuthenticated() {
    this.lastEventAt = new Date().toISOString();
    logger.info("WhatsApp client authenticated", {
      resortId: this.resortId,
      clientId: this.clientId,
    });
    this.scheduleReadinessRecovery("authenticated");
  }

  async handleReady() {
    await this.promoteConnected("ready");
  }

  async handleLoadingScreen(percent) {
    this.lastLoadingPercent = Number(percent) || 0;
    this.lastEventAt = new Date().toISOString();

    if (this.status !== "connected") {
      this.status = "initializing";
    }

    logger.info("WhatsApp percent", {
      resortId: this.resortId,
      clientId: this.clientId,
      percent: this.lastLoadingPercent,
    });

    if (this.lastLoadingPercent >= 100) {
      this.scheduleReadinessRecovery("loading_screen");
    }
  }

  async handleStateChange(state) {
    this.lastKnownState = state;
    this.lastEventAt = new Date().toISOString();

    logger.info("WhatsApp state changed", {
      resortId: this.resortId,
      clientId: this.clientId,
      state,
    });

    if (state === WAState.CONNECTED) {
      this.scheduleReadinessRecovery("change_state");
      return;
    }

    if (state === WAState.OPENING || state === WAState.PAIRING) {
      if (this.status !== "connected") {
        this.status = "initializing";
      }
      return;
    }

    if (state === WAState.UNPAIRED || state === WAState.UNPAIRED_IDLE) {
      if (this.qrDataUrl) {
        this.status = "qr_waiting";
      } else {
        this.status = "initializing";
      }
      return;
    }

    if (
      state === WAState.TIMEOUT ||
      state === WAState.PROXYBLOCK ||
      state === WAState.DEPRECATED_VERSION ||
      state === WAState.TOS_BLOCK ||
      state === WAState.SMB_TOS_BLOCK
    ) {
      this.markDisconnected(`WhatsApp connection state: ${state}`);
      this.scheduleReconnect(`state:${state}`);
    }
  }

  async handleAuthFailure(message) {
    const reason = message || "WhatsApp authentication failed";
    this.markDisconnected(reason);

    logger.error("WhatsApp authentication failed", {
      resortId: this.resortId,
      clientId: this.clientId,
      error: reason,
    });

    await this.destroyClient();
    this.scheduleReconnect("auth_failure");
  }

  async handleDisconnected(reason) {
    const normalizedReason = String(reason || "WhatsApp disconnected");

    logger.warn("WhatsApp client disconnected", {
      resortId: this.resortId,
      clientId: this.clientId,
      reason: normalizedReason,
    });

    this.markDisconnected(normalizedReason);
    await this.destroyClient();

    if (!this.manualLogout) {
      this.scheduleReconnect("disconnected");
    }
  }

  async handleRemoteSessionSaved() {
    this.lastEventAt = new Date().toISOString();
    logger.info("WhatsApp remote session saved", {
      resortId: this.resortId,
      clientId: this.clientId,
    });
  }

  scheduleReadinessRecovery(source) {
    if (this.recoveryPromise || !this.client) return;

    this.recoveryPromise = (async () => {
      await sleep(READY_RECOVERY_DELAY_MS);
      await this.promoteConnected(`${source}:recovered`);
    })().finally(() => {
      this.recoveryPromise = null;
    });
  }

  async promoteConnected(source) {
    if (!this.client) return false;

    try {
      const state = await this.runOperationWithTimeout(
        () => this.client.getState(),
        STATE_CHECK_TIMEOUT_MS,
        "Timed out while checking WhatsApp state",
      );

      if (state !== WAState.CONNECTED) {
        return false;
      }

      await this.hydrateClientIdentity();

      const justConnected = this.status !== "connected";
      this.status = "connected";
      this.qrCode = null;
      this.qrDataUrl = null;
      this.lastError = null;
      this.connectedAt = this.connectedAt || new Date().toISOString();
      this.lastEventAt = new Date().toISOString();
      this.reconnectAttempts = 0;

      if (justConnected) {
        logger.info("WhatsApp client connected", {
          resortId: this.resortId,
          clientId: this.clientId,
          source,
          phoneNumber: this.phoneNumber,
        });
      }

      return true;
    } catch (error) {
      logger.warn("Unable to promote WhatsApp client to connected", {
        resortId: this.resortId,
        clientId: this.clientId,
        source,
        error: getErrorMessage(error),
      });
      return false;
    }
  }

  async hydrateClientIdentity() {
    if (!this.client?.pupPage) return;

    if (!this.client.info) {
      try {
        await this.client.pupPage.evaluate(LoadUtils);
      } catch {
        void 0;
      }

      const info = await this.runOperationWithTimeout(
        () =>
          this.client.pupPage.evaluate(() => ({
            ...window.require("WAWebConnModel").Conn.serialize(),
            wid:
              window.require("WAWebUserPrefsMeUser").getMaybeMePnUser() ||
              window.require("WAWebUserPrefsMeUser").getMaybeMeLidUser(),
          })),
        STATE_CHECK_TIMEOUT_MS,
        "Timed out while hydrating WhatsApp client info",
      );

      if (info) {
        this.client.info = new ClientInfo(this.client, info);
        this.client.interface = new InterfaceController(this.client);
      }
    }

    const wid = this.client.info?.wid;
    const digits = normalizePhoneNumber(
      wid?.user ||
        (typeof wid?._serialized === "string"
          ? wid._serialized.split("@")[0]
          : ""),
    );

    if (digits) {
      this.phoneNumber = formatDisplayPhoneNumber(digits);
    }
  }

  async sendTextMessageNow({
    bookingId,
    targetNumber,
    message,
    messageType = "booking_confirmation",
  }) {
    const recipient = formatDisplayPhoneNumber(targetNumber);

    return this.runSendExclusively(async () => {
      if (!(await this.isClientSendReady())) {
        const reason =
          this.lastError || "WhatsApp is not connected for live delivery";
        await this.logMessage({
          bookingId,
          recipient,
          status: "skipped",
          messageType,
          error: reason,
        });
        return {
          attempted: false,
          sent: false,
          queued: false,
          recipient,
          reason,
        };
      }

      try {
        const delayMs = randomBetween(
          this.sendDelayMinMs,
          this.sendDelayMaxMs,
        );
        if (delayMs > 0) {
          await sleep(delayMs);
        }

        const result = await this.runOperationWithTimeout(
          () => this.client.sendMessage(`${targetNumber}@c.us`, message),
          SEND_MESSAGE_TIMEOUT_MS,
          "Timed out while sending WhatsApp message",
        );

        await this.logMessage({
          bookingId,
          recipient,
          status: "sent",
          messageType,
          messageId: result?.id?._serialized || result?.id || null,
        });

        logger.info("WhatsApp message sent", {
          resortId: this.resortId,
          clientId: this.clientId,
          bookingId,
          targetNumber,
          messageType,
        });

        return {
          attempted: true,
          sent: true,
          queued: false,
          recipient,
        };
      } catch (error) {
        const reason = getErrorMessage(error, "Unable to send WhatsApp message");

        await this.logMessage({
          bookingId,
          recipient,
          status: "failed",
          messageType,
          error: reason,
        });

        logger.error("WhatsApp message failed", {
          resortId: this.resortId,
          clientId: this.clientId,
          bookingId,
          targetNumber,
          messageType,
          error: reason,
        });

        if (isRecoverableClientError(reason)) {
          await this.markClientUnhealthy(reason);
        }

        return {
          attempted: true,
          sent: false,
          queued: false,
          recipient,
          reason,
        };
      }
    });
  }

  async isClientSendReady() {
    if (!this.enabled || !this.client || this.status !== "connected") {
      return false;
    }

    try {
      const state = await this.runOperationWithTimeout(
        () => this.client.getState(),
        STATE_CHECK_TIMEOUT_MS,
        "Timed out while checking WhatsApp state",
      );

      return state === WAState.CONNECTED;
    } catch (error) {
      this.lastError = getErrorMessage(
        error,
        "Unable to verify WhatsApp connection state",
      );
      this.lastEventAt = new Date().toISOString();
      return false;
    }
  }

  async markClientUnhealthy(reason) {
    this.markDisconnected(reason);
    await this.destroyClient();
    this.scheduleReconnect("unhealthy");
  }

  markDisconnected(reason) {
    this.status = this.enabled ? "disconnected" : "disabled";
    this.lastError = reason || null;
    this.phoneNumber = null;
    this.connectedAt = null;
    this.qrCode = null;
    this.qrDataUrl = null;
    this.lastEventAt = new Date().toISOString();
  }

  scheduleReconnect(reason) {
    if (!this.enabled || this.shutdownRequested || this.manualLogout) return;

    this.clearReconnectTimer();
    this.reconnectAttempts += 1;

    const delayMs = Math.min(60_000, 5_000 * 2 ** (this.reconnectAttempts - 1));
    logger.warn("Scheduled WhatsApp reconnect", {
      resortId: this.resortId,
      clientId: this.clientId,
      reason,
      attempt: this.reconnectAttempts,
      delayMs,
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.initializeClient();
    }, delayMs);

    this.reconnectTimer.unref?.();
  }

  clearReconnectTimer() {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  async resetRuntime({ clearStoredSession }) {
    this.clearReconnectTimer();
    await this.destroyClient();

    if (clearStoredSession) {
      await Promise.allSettled([
        this.authStore?.delete?.({ session: this.getRemoteSessionName() }),
        this.cleanupClientAuthArtifacts(),
        this.cleanupLegacyLocalAuthArtifacts(),
      ]);
    }

    this.qrCode = null;
    this.qrDataUrl = null;
    this.phoneNumber = null;
    this.connectedAt = null;
    this.lastKnownState = WAState.UNLAUNCHED;
    this.lastLoadingPercent = null;
    this.lastEventAt = new Date().toISOString();
    this.lastError = null;
  }

  async destroyClient() {
    const client = this.client;
    this.client = null;
    this.recoveryPromise = null;

    if (!client) return;

    try {
      client.removeAllListeners();
      await client.destroy();
    } catch (error) {
      logger.warn("Failed to destroy WhatsApp client cleanly", {
        resortId: this.resortId,
        clientId: this.clientId,
        error: getErrorMessage(error),
      });
    }
  }

  async cleanupClientAuthArtifacts() {
    const sessionName = this.getRemoteSessionName();
    const paths = [
      path.join(this.sessionsDir, sessionName),
      path.join(this.sessionsDir, `${sessionName}.zip`),
    ];

    await Promise.allSettled(
      paths.map((targetPath) =>
        fs.rm(targetPath, { recursive: true, force: true }),
      ),
    );
  }

  async cleanupLegacyLocalAuthArtifacts() {
    const paths = [
      path.join(this.sessionsDir, `session-${this.clientId}`),
      path.join(this.sessionsDir, `.wwebjs_auth`, `session-${this.clientId}`),
      path.join(this.sessionsDir, `_IGNORE_${this.clientId}`),
    ];

    await Promise.allSettled(
      paths.map((targetPath) =>
        fs.rm(targetPath, { recursive: true, force: true }),
      ),
    );
  }

  getRemoteSessionName() {
    return `RemoteAuth-${this.clientId}`;
  }

  async resolveBrowserLaunchConfig() {
    const explicitPath = this.puppeteerExecutablePath?.trim();
    if (explicitPath) {
      if (existsSync(explicitPath)) {
        return {
          executablePath: explicitPath,
          browserSource: "env",
          args: [...SYSTEM_BROWSER_ARGS],
          headless: true,
        };
      }

      logger.warn("Configured Chromium path was not found", {
        resortId: this.resortId,
        clientId: this.clientId,
        executablePath: explicitPath,
      });
    }

    const systemPath = resolveSystemBrowserExecutablePath();
    if (systemPath) {
      return {
        executablePath: systemPath,
        browserSource: "system",
        args: [...SYSTEM_BROWSER_ARGS],
        headless: true,
      };
    }

    const bundledPath = await resolveBundledChromiumExecutablePath();
    return {
      executablePath: bundledPath,
      browserSource: "bundled",
      args: [...chromium.args],
      headless: "shell",
    };
  }

  async getTodayStats() {
    const collection = this.logsCollection?.();
    if (!collection) return { ...DEFAULT_STATS };

    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);

    const [summary] = await collection
      .aggregate([
        {
          $match: {
            resortId: this.resortId,
            createdAt: { $gte: dayStart },
          },
        },
        {
          $group: {
            _id: null,
            totalToday: { $sum: 1 },
            sentToday: {
              $sum: { $cond: [{ $eq: ["$status", "sent"] }, 1, 0] },
            },
            failedToday: {
              $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] },
            },
            skippedToday: {
              $sum: { $cond: [{ $eq: ["$status", "skipped"] }, 1, 0] },
            },
          },
        },
      ])
      .toArray();

    return summary
      ? {
          totalToday: summary.totalToday || 0,
          sentToday: summary.sentToday || 0,
          failedToday: summary.failedToday || 0,
          skippedToday: summary.skippedToday || 0,
        }
      : { ...DEFAULT_STATS };
  }

  async logMessage({
    bookingId = null,
    recipient = null,
    status,
    messageType,
    error = null,
    messageId = null,
  }) {
    const collection = this.logsCollection?.();
    if (!collection) return;

    await collection.insertOne({
      resortId: this.resortId,
      clientId: this.clientId,
      bookingId,
      recipient,
      status,
      messageType,
      error,
      whatsappMessageId: messageId,
      createdAt: new Date(),
    });
  }

  async runSendExclusively(work) {
    const previousLock = this.sendLock;
    let releaseLock = () => {};
    this.sendLock = new Promise((resolve) => {
      releaseLock = resolve;
    });

    await previousLock;

    try {
      return await work();
    } finally {
      releaseLock();
    }
  }

  async runOperationWithTimeout(operation, timeoutMs, timeoutMessage) {
    let timeoutHandle = null;

    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(new Error(timeoutMessage));
          }, timeoutMs);
          timeoutHandle.unref?.();
        }),
      ]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }
}
