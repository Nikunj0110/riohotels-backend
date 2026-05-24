import { promises as fs } from "node:fs";
import path from "node:path";
import QRCode from "qrcode";
import whatsappWeb from "whatsapp-web.js";
import chromium from "@sparticuz/chromium";

const { Client, LocalAuth } = whatsappWeb;

const DEFAULT_STATS = {
  totalToday: 0,
  sentToday: 0,
  failedToday: 0,
  skippedToday: 0,
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
  }) {
    this.enabled = enabled;
    this.resortId = resortId;
    this.resortName = resortName;
    this.clientId = clientId;
    this.sessionsDir = sessionsDir;
    this.defaultCountryCode = defaultCountryCode;
    this.puppeteerExecutablePath = puppeteerExecutablePath;
    this.logsCollection = logsCollection;

    this.client = null;
    this.initializing = false;
    this.status = enabled ? "initializing" : "disabled";
    this.qrCode = null;
    this.qrDataUrl = null;
    this.phoneNumber = null;
    this.connectedAt = null;
    this.lastError = enabled ? null : "WhatsApp automation is disabled";
    this.lastEventAt = null;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.manualLogout = false;
  }

  async init() {
    if (!this.enabled) return this.getStatus();
    return this.initializeClient();
  }

  async restart() {
    this.manualLogout = false;
    this.clearReconnectTimer();
    await this.destroyClient();
    return this.initializeClient();
  }

  async logout() {
    this.manualLogout = true;
    this.clearReconnectTimer();

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
    return this.initializeClient();
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

      return {
        attempted: false,
        sent: false,
        recipient: booking.mobile,
        reason: "Invalid mobile number format",
      };
    }

    if (!this.client || !this.isReady()) {
      await this.logMessage({
        bookingId: booking.id,
        resortId: booking.resortId,
        roomNumber: booking.roomNumber,
        targetNumber: recipient,
        status: "skipped",
        error: "WhatsApp client is not connected",
      });

      return {
        attempted: false,
        sent: false,
        recipient: displayRecipient,
        reason: "WhatsApp client is not connected",
      };
    }

    try {
      const chatId = await this.validateNumber(recipient);
      if (!chatId) {
        await this.logMessage({
          bookingId: booking.id,
          resortId: booking.resortId,
          roomNumber: booking.roomNumber,
          targetNumber: recipient,
          status: "failed",
          error: "Number is not registered on WhatsApp",
        });

        return {
          attempted: true,
          sent: false,
          recipient: displayRecipient,
          reason: "Number is not registered on WhatsApp",
        };
      }

      const messageText = buildBookingMessage({
        booking,
        resortName: resort?.name || "Rio Hotels",
      });
      const response = await this.client.sendMessage(chatId, messageText);

      await this.logMessage({
        bookingId: booking.id,
        resortId: booking.resortId,
        roomNumber: booking.roomNumber,
        targetNumber: recipient,
        status: "sent",
        whatsappMessageId: response?.id?._serialized || null,
      });

      return {
        attempted: true,
        sent: true,
        recipient: displayRecipient,
      };
    } catch (error) {
      const reason =
        error instanceof Error
          ? error.message
          : "Unable to send WhatsApp message";

      await this.logMessage({
        bookingId: booking.id,
        resortId: booking.resortId,
        roomNumber: booking.roomNumber,
        targetNumber: recipient,
        status: "failed",
        error: reason,
      });

      return {
        attempted: true,
        sent: false,
        recipient: displayRecipient,
        reason,
      };
    }
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

    try {
      await fs.mkdir(this.sessionsDir, { recursive: true });
      await this.destroyClient();

      // Determine Chrome executable path
      const executablePath = this.puppeteerExecutablePath || 
        (process.env.NODE_ENV === "production" ? await chromium.executablePath() : undefined);

      const nextClient = new Client({
        authStrategy: new LocalAuth({
          clientId: this.clientId,
          dataPath: this.sessionsDir,
        }),
        puppeteer: {
          headless: true,
          args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            ...(process.env.NODE_ENV === "production" ? chromium.args : []),
          ],
          ...(executablePath ? { executablePath } : {}),
        },
      });

      this.client = nextClient;
      this.bindEvents(nextClient);
      await nextClient.initialize();
    } catch (error) {
      this.status = "disconnected";
      this.lastError =
        error instanceof Error
          ? error.message
          : "Unable to initialize WhatsApp client";
      this.connectedAt = null;
      this.phoneNumber = null;
      this.qrCode = null;
      this.qrDataUrl = null;
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
        this.lastError =
          error instanceof Error ? error.message : "Unable to render QR";
      }

      this.status = "qr_waiting";
      this.qrCode = qr;
      this.phoneNumber = null;
      this.connectedAt = null;
      this.lastEventAt = new Date().toISOString();
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
    });

    nextClient.on("authenticated", () => {
      if (this.client !== nextClient) return;
      this.lastError = null;
      this.lastEventAt = new Date().toISOString();
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
      if (!this.manualLogout) {
        this.scheduleReconnect();
      }
    });

    nextClient.on("disconnected", (reason) => {
      if (this.client !== nextClient) return;
      this.status = "disconnected";
      this.connectedAt = null;
      this.phoneNumber = null;
      this.lastError = String(reason || "Disconnected");
      this.lastEventAt = new Date().toISOString();
      if (!this.manualLogout) {
        this.scheduleReconnect();
      }
    });
  }

  scheduleReconnect() {
    if (!this.enabled || this.manualLogout || this.reconnectTimer) return;

    const delay = Math.min(30_000, 5_000 * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.initializeClient();
    }, delay);
  }

  clearReconnectTimer() {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  async destroyClient() {
    if (!this.client) return;

    const currentClient = this.client;
    this.client = null;

    try {
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
