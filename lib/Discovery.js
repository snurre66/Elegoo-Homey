'use strict';

const dgram = require('dgram');

/**
 * SDCP Discovery handles UDP discovery for Elegoo printers.
 * Sends 'M99999' to port 3000 and waits for responses.
 */
class Discovery {
  /**
   * Parse a raw UDP response into a structured printer object.
   * @param {Buffer} msg - Raw message buffer.
   * @param {object} rinfo - Remote address info from dgram.
   * @returns {object|null} Parsed printer object or null on failure.
   */
  static _parseResponse(msg, rinfo) {
    try {
      const data = JSON.parse(msg.toString());
      return {
        name: data.MachineName || data.MainboardModel,
        model: data.MainboardModel,
        address: rinfo.address,
        mainboardID: data.MainboardID || data.MainboardId || data.Id,
        data,
      };
    } catch (_err) {
      // Non-JSON response, might be old protocol or garbage
      return null;
    }
  }

  /**
   * Broadcast-discover all SDCP printers on the local network.
   * @param {number} [timeout=5000] - Discovery window in ms.
   * @returns {Promise<Array>} Array of discovered printer objects.
   */
  static async discover(timeout = 5000) {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket('udp4');
      const printers = [];
      let timer = null;
      let interval = null;
      let isDone = false;

      const cleanup = () => {
        if (isDone) return;
        isDone = true;
        if (timer) clearTimeout(timer);
        if (interval) clearInterval(interval);
        try {
          socket.close();
        } catch (_err) {
          // Socket might already be closed
        }
      };

      socket.on('error', (err) => {
        cleanup();
        reject(err);
      });

      socket.on('message', (msg, rinfo) => {
        const printer = Discovery._parseResponse(msg, rinfo);
        if (!printer) return;
        if (printers.some((p) => p.address === printer.address)) return;
        printers.push(printer);
      });

      socket.on('listening', () => {
        try {
          socket.setBroadcast(true);
          const message = Buffer.from('M99999');
          const sendProbe = () => {
            try {
              socket.send(message, 3000, '255.255.255.255');
            } catch (_err) {
              // ignore send error
            }
          };
          sendProbe();
          // Retransmit probe once per 1.5s to compensate for Wi-Fi UDP packet loss
          interval = setInterval(sendProbe, 1500);
        } catch (err) {
          cleanup();
          reject(err);
        }
      });

      socket.bind();

      timer = setTimeout(() => {
        cleanup();
        resolve(printers);
      }, timeout);
    });
  }

  /**
   * Probe a specific address and port to see if it's an SDCP printer.
   * @param {string} address - IP address to probe.
   * @param {number} [port=3000] - UDP port.
   * @param {number} [timeout=3000] - Timeout in ms.
   * @returns {Promise<object|null>} Printer object or null.
   */
  static async probe(address, port = 3000, timeout = 3000) {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket('udp4');
      let timer = null;
      let isDone = false;

      const cleanup = () => {
        if (isDone) return;
        isDone = true;
        if (timer) clearTimeout(timer);
        try {
          socket.close();
        } catch (_err) {
          // Socket might already be closed
        }
      };

      socket.on('error', (err) => {
        cleanup();
        reject(err);
      });

      socket.on('message', (msg, rinfo) => {
        if (rinfo.address === address) {
          const printer = Discovery._parseResponse(msg, rinfo);
          if (printer) {
            cleanup();
            resolve(printer);
          }
        }
      });

      socket.bind();

      const message = Buffer.from('M99999');
      socket.send(message, port, address, (err) => {
        if (err) {
          cleanup();
          reject(err);
        }
      });

      timer = setTimeout(() => {
        cleanup();
        resolve(null);
      }, timeout);
    });
  }
}

module.exports = Discovery;
