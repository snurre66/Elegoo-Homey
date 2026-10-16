'use strict';

const WebSocket = require('ws');
const EventEmitter = require('events');
const { SDCP_CMD } = require('./SDCPCommands');

/**
 * SDCPClient handles the WebSocket connection to Elegoo SDCP printers.
 * Features:
 * - Exponential backoff reconnection logic.
 * - Pulse/Heartbeat monitoring.
 * - JSON command abstraction with Promise-based responses.
 *
 * @param {object} options
 * @param {string} options.host - Printer IP address.
 * @param {number} [options.port=3030] - WebSocket port.
 * @param {object} options.homey - Homey instance for SDK-compliant timers.
 * @param {function} [options.logger] - Logging function.
 */
class SDCPClient extends EventEmitter {
  constructor({ host, port = 3030, homey, logger, mainboardId = '' }) {
    super();
    this.url = `ws://${host}:${port}/websocket`;
    this.homey = homey;
    this.log = logger || console.log;
    this.ws = null;
    this.mainboardId = mainboardId;
    this.printerConnectionId = null;
    this.reconnectAttempts = 0;
    this.maxReconnectDelay = 30000; // 30 seconds
    this.baseReconnectDelay = 1000; // 1 second
    this.isConnected = false;
    this.isIntentionallyClosed = false;
    this.heartbeatInterval = null;
    this.reconnectTimeout = null;
    this.lastActivity = 0;
  }

  connect() {
    this.log(` Connecting to SDCP printer at ${this.url}`);
    this.isIntentionallyClosed = false;

    if (this.reconnectTimeout) {
      this.homey.clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.terminate();
      } catch (_err) {
        // Ignore termination error on old socket
      }
      this.ws = null;
    }

    try {
      this.ws = new WebSocket(this.url);

      this.ws.on('open', () => {
        this.log(` WebSocket connection established to ${this.url}`);
        this.isConnected = true;
        this.lastActivity = Date.now();
        this.reconnectAttempts = 0;
        this.emit('connected');
        this.startHeartbeat();
      });

      this.ws.on('message', (data) => {
        try {
          this.lastActivity = Date.now();
          const message = JSON.parse(data.toString());

          // Extract printer MainboardID and connection ID from live traffic
          if (message.Id && !this.printerConnectionId) {
            this.printerConnectionId = message.Id;
          }
          const mbId = message.Data?.MainboardID || message.Data?.Data?.MainboardID || message.MainboardID;
          if (mbId && !this.mainboardId) {
            this.mainboardId = mbId;
          }

          this.emit('message', message);

          // Unified Status Handling:
          // Instead of multiple partial emits, we emit a single status event with the full message.
          // This allows drivers to correlate top-level Status with nested PrintInfo.
          this.emit('status', message);
        } catch (err) {
          this.log(' Error parsing WebSocket message:', err.message);
        }
      });

      this.ws.on('close', (code, reason) => {
        this.log(` WebSocket connection closed: code=${code}, reason=${reason || 'none'}`);
        this.handleDisconnect();
      });

      this.ws.on('error', (err) => {
        this.log(` WebSocket error for ${this.url}:`, err.message);
        // Error triggers 'close', so we handle it there
      });

      this.ws.on('pong', () => {
        this.lastActivity = Date.now();
      });
    } catch (err) {
      this.log(' Error creating WebSocket:', err.message);
      this.handleDisconnect();
    }
  }

  handleDisconnect() {
    this.isConnected = false;
    this.stopHeartbeat();
    this.emit('disconnected');

    if (!this.isIntentionallyClosed) {
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimeout) {
      this.homey.clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    const delay = Math.min(this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);

    // Add 20% jitter
    const jitter = delay * 0.2 * (Math.random() * 2 - 1);
    const finalDelay = delay + jitter;

    this.log(` Scheduling reconnection in ${Math.round(finalDelay / 1000)}s (Attempt ${this.reconnectAttempts + 1})`);

    this.reconnectTimeout = this.homey.setTimeout(() => {
      this.reconnectAttempts++;
      this.connect();
    }, finalDelay);
  }

  disconnect() {
    this.isIntentionallyClosed = true;
    if (this.reconnectTimeout) {
      this.homey.clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.terminate();
      } catch (_err) {
        // Ignore termination error on disconnect
      }
      this.ws = null;
    }
    this.stopHeartbeat();
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.lastActivity = Date.now();
    // Poll status every 2 seconds (matches Home Assistant SDCP coordinator interval for real-time responsiveness)
    this.heartbeatInterval = this.homey.setInterval(() => {
      // Check for zombie socket (>15s without message or pong)
      if (this.isConnected && Date.now() - this.lastActivity > 15000) {
        this.log(' WebSocket heartbeat lost (silent for >15s) - terminating socket');
        if (this.ws) {
          try {
            this.ws.terminate();
          } catch (_e) {
            // ignore
          }
        }
        return;
      }
      this.getStatus();
      this.ping();
    }, 2000);
  }

  stopHeartbeat() {
    if (this.heartbeatInterval) {
      this.homey.clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  ping() {
    if (this.ws && this.isConnected && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.ping();
      } catch (_err) {
        // Ping error will be handled by close/error listener
      }
    }
  }

  /**
   * Send a JSON command to the printer.
   * @param {number} commandId - Command ID from SDCP_CMD constants.
   * @param {object} [payload] - Additional command data.
   * @returns {Promise<boolean>} Resolves true on success.
   * @throws {Error} If not connected.
   */
  async sendCommand(commandId, payload = {}) {
    if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Cannot send command: Not connected to printer');
    }

    const ts = Math.floor(Date.now() / 1000);
    const request_id = this.generateTransactionId();
    const mainboardId = this.mainboardId || '';

    const message = {
      Id: this.printerConnectionId || '12345',
      Data: {
        Cmd: commandId,
        Data: payload,
        RequestID: request_id,
        MainboardID: mainboardId,
        TimeStamp: ts,
        From: 0,
      },
      Topic: mainboardId ? `sdcp/request/${mainboardId}` : 'sdcp/request',
    };

    return new Promise((resolve, reject) => {
      this.log(` Sending Command [${commandId}]:`, JSON.stringify(message));
      this.ws.send(JSON.stringify(message), (err) => {
        if (err) {
          this.log(` Error sending command [${commandId}]:`, err.message);
          reject(err);
        } else {
          resolve(true);
        }
      });
    });
  }

  getStatus() {
    return this.sendCommand(SDCP_CMD.GET_STATUS).catch(() => {
      // Silent fail during heartbeat — disconnection is handled elsewhere
    });
  }

  generateTransactionId() {
    return Math.floor(Math.random() * 1000000).toString();
  }
}

module.exports = SDCPClient;
