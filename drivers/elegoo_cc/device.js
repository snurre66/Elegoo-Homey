'use strict';

const http = require('http');
const { Duplex } = require('stream');
const PrinterDevice = require('../../lib/PrinterDevice');
const { SDCP_CMD } = require('../../lib/SDCPCommands');
const CapabilityMapper = require('../../lib/CapabilityMapper');

class ElegooCCDevice extends PrinterDevice {
  async onInit() {
    await super.onInit();
    this.log(`Elegoo Centauri Carbon device initialized at ${this.host}`);

    this.registerCamera().catch(this.error);
    this._registerListeners();
    this._registerFlowActions();
    this._registerFlowConditions();

    // Initialize flow trigger tracking state
    this._firedProgress = new Set();
    this._firedLayers = new Set();
    this._prevFilament = null;
    this._prevDoor = null;
    this._prevUsb = null;
    this._reachedNozzle = false;
    this._reachedBed = false;
    this._firedChamber = new Set();
    this._prevCamEnabled = null;
    this._prevMotors = null;
    this._prevStreamCount = null;

    // Set static info from settings if available
    const settings = this.getSettings();
    if (settings.model) this.setCapabilityValue('printer_model', settings.model).catch(this.error);
    if (settings.address) this.setCapabilityValue('ip_address', settings.address).catch(this.error);

    // Connect after all capabilities are ready
    this.client.connect();

    // Periodic attribute refresh (FDM-specific Cmd 385)
    this._attrInterval = this.homey.setInterval(() => {
      this.log('Periodic sync: Requesting attributes (FDM_GET_ATTRIBUTES)');
      this.client.sendCommand(SDCP_CMD.FDM_GET_ATTRIBUTES).catch(() => {});
    }, 60000);
  }

  async onUninit() {
    this.log('Elegoo CC Device uninitializing');
    if (this._attrInterval) this.homey.clearInterval(this._attrInterval);
    if (this._cameraInterval) this.homey.clearInterval(this._cameraInterval);
    await super.onUninit();
  }

  // ── Camera ────────────────────────────────────────────────

  async registerCamera() {
    this.log(`Registering camera feeds for ${this.host}`);
    try {
      this.snapshotImage = await this.homey.images.createImage();

      this.snapshotImage.setStream(async (stream) => {
        this.log('Camera: setStream called, fetching snapshot...');
        try {
          const buffer = await this._fetchSnapshotBuffer();
          const snapshot = new Duplex();
          snapshot._read = () => {};

          if (buffer && buffer.length > 0) {
            this.log(`Camera: pushing frame of ${buffer.length} bytes`);
            snapshot.push(buffer);
          } else {
            this.log('Camera: no frame, pushing empty stream');
          }

          snapshot.push(null); // End of stream
          return snapshot.pipe(stream);
        } catch (error) {
          this.error('Camera mapping error:', error.message);
          const snapshot = new Duplex();
          snapshot._read = () => {};
          snapshot.push(null);
          return snapshot.pipe(stream);
        }
      });

      await this.setCameraImage('elegoo_snapshot', 'Snapshot', this.snapshotImage)
        .then(() => this.log('Camera: Snapshot registered OK'))
        .catch((e) => this.error('Camera: setCameraImage FAILED:', e.message));

      // Initial fetch after 3s
      this.homey.setTimeout(() => {
        this.snapshotImage
          .update()
          .then(() => this.log('Camera: initial update() OK'))
          .catch((e) => this.error('Camera: initial update() FAILED:', e.message));
      }, 3000);

      // Thumbnail Preview Image
      this.thumbnailImage = await this.homey.images.createImage();
      this.thumbnailImage.setStream(async (stream) => {
        const snapshot = new Duplex();
        snapshot._read = () => {};
        if (this.thumbnailBuffer && this.thumbnailBuffer.length > 0) {
          snapshot.push(this.thumbnailBuffer);
        }
        snapshot.push(null);
        return snapshot.pipe(stream);
      });

      await this.setCameraImage('elegoo_thumbnail', 'Print Preview', this.thumbnailImage)
        .then(() => this.log('Camera: Print Preview Thumbnail registered OK'))
        .catch((e) => this.error('Camera: setCameraImage Thumbnail FAILED:', e.message));

      // Refresh every 5 seconds (better for Web UI fallback)
      this._cameraInterval = this.homey.setInterval(() => {
        this.snapshotImage.update().catch(() => {});
      }, 5000);

      // Live Video Stream
      this.liveVideo = await this.homey.videos.createVideoOther();
      this.liveVideo.registerVideoUrlListener(async () => {
        const url = `http://${this.host}:3031/video`;
        this.log(`Camera: live stream URL requested, returning ${url}`);
        return url;
      });

      await this.setCameraVideo('elegoo_live', 'Live Stream', this.liveVideo)
        .then(() => this.log('Camera: Live Stream registered OK'))
        .catch((e) => this.error('Camera: setCameraVideo FAILED:', e.message));
    } catch (err) {
      this.error('Critical: Failed to register camera feeds:', err.message);
    }
  }

  async _fetchSnapshotBuffer() {
    return new Promise((resolve) => {
      const url = `http://${this.host}:3031/video`;
      this.log(`Camera: connecting to ${url}`);

      const timeout = setTimeout(() => {
        this.log('Camera: timeout waiting for MJPEG frame');
        req.destroy();
        resolve(null);
      }, 8000);

      const req = http.get(url, (res) => {
        this.log(`Camera: HTTP ${res.statusCode} content-type: ${res.headers['content-type']}`);
        if (res.statusCode !== 200) {
          clearTimeout(timeout);
          res.resume();
          resolve(null);
          return;
        }

        // Scan incoming chunks for JPEG SOI (0xFFD8) and EOI (0xFFD9) markers
        const chunks = [];
        let frameFound = false;

        res.on('data', (chunk) => {
          if (frameFound) return;
          chunks.push(chunk);
          const buf = Buffer.concat(chunks);
          const start = buf.indexOf(Buffer.from([0xff, 0xd8]));
          const end = buf.indexOf(Buffer.from([0xff, 0xd9]));
          if (start !== -1 && end !== -1 && end > start) {
            frameFound = true;
            clearTimeout(timeout);
            const frame = buf.slice(start, end + 2);
            this.log(`Camera: extracted JPEG frame ${frame.length} bytes`);
            req.destroy();
            resolve(frame);
          }
        });

        res.on('end', () => {
          if (!frameFound) {
            clearTimeout(timeout);
            this.log('Camera: stream ended without a complete frame');
            resolve(null);
          }
        });
      });

      req.on('error', (err) => {
        if (err.code === 'ECONNRESET' || err.message.includes('socket hang up')) return;
        clearTimeout(timeout);
        this.error(`Camera: fetch error: ${err.message}`);
        resolve(null);
      });
    });
  }

  // ── Capability Listeners ──────────────────────────────────

  _registerListeners() {
    // Buttons
    this.registerCapabilityListener('button.pause', async () => {
      this.log('UI: Pause Program');
      return this.client.sendCommand(SDCP_CMD.PAUSE_PRINT, {});
    });
    this.registerCapabilityListener('button.resume', async () => {
      this.log('UI: Resume Program');
      return this.client.sendCommand(SDCP_CMD.RESUME_PRINT, {});
    });
    this.registerCapabilityListener('button.stop', async () => {
      this.log('UI: Stop/Cancel Program');
      return this.client.sendCommand(SDCP_CMD.STOP_PRINT, {});
    });
    this.registerCapabilityListener('button.home', async () => {
      this.log('UI: Home All Axes');
      return this.client.sendCommand(SDCP_CMD.CC_HOME_ALL, { Axis: 'XYZ' });
    });
    this.registerCapabilityListener('button.skip_preheat', async () => {
      this.log('UI: Skip Preheating');
      return this.client.sendCommand(SDCP_CMD.SKIP_PREHEAT, {});
    });

    // Read-only temperature targets
    this.registerCapabilityListener('target_temperature.nozzle', async () => true);
    this.registerCapabilityListener('target_temperature.bed', async () => true);

    // Performance factors
    this.registerCapabilityListener('speed_factor', async (value) => {
      this.log(`UI: Set Speed Factor -> ${value}%`);
      return this.client.sendCommand(403, { PrintSpeedPct: value });
    });
    this.registerCapabilityListener('extrusion_factor', async (value) => {
      this.log(`UI: Set Extrusion Factor -> ${value}%`);
      return this.client.sendCommand(SDCP_CMD.FDM_SET_EXTRUSION, { ExtrusionFactor: value });
    });

    // Fans & Lights
    this.registerCapabilityListener('part_fan_speed', async (value) => {
      this.log(`UI: Set Part Fan Speed -> ${value}%`);
      return this.client.sendCommand(SDCP_CMD.CC_SET_CONFIG, { TargetFanSpeed: { ModelFan: value } });
    });
    this.registerCapabilityListener('onoff.chamberlight', async (value) => {
      this.log(`UI: Set Chamber Light -> ${value ? 'ON' : 'OFF'}`);
      return this.client.sendCommand(SDCP_CMD.CC_SET_CONFIG, { LightStatus: { SecondLight: value ? 1 : 0 } });
    });
    this.registerCapabilityListener('onoff.auxfan', async (value) => {
      return this.client.sendCommand(SDCP_CMD.CC_SET_CONFIG, { TargetFanSpeed: { AuxiliaryFan: value ? 100 : 0 } });
    });
    this.registerCapabilityListener('onoff.exhaustfan', async (value) => {
      return this.client.sendCommand(SDCP_CMD.CC_SET_CONFIG, { TargetFanSpeed: { BoxFan: value ? 100 : 0 } });
    });
    this.registerCapabilityListener('onoff.boxfan', async (value) => {
      this.log(`UI: Set Box Fan -> ${value ? 'ON' : 'OFF'}`);
      return this.client.sendCommand(SDCP_CMD.CC_SET_CONFIG, { TargetFanSpeed: { BoxFan: value ? 100 : 0 } });
    });
  }

  // ── Flow Actions ──────────────────────────────────────────

  _registerFlowActions() {
    const flow = this.homey.flow;
    flow.getActionCard('emergency_stop').registerRunListener(async () => {
      this.log('Action: Emergency Stop');
      return this.client.sendCommand(SDCP_CMD.STOP_PRINT, {});
    });
    flow.getActionCard('pause_print').registerRunListener(async () => {
      this.log('Action: Pause Print');
      return this.client.sendCommand(SDCP_CMD.PAUSE_PRINT, {});
    });
    flow.getActionCard('resume_print').registerRunListener(async () => {
      this.log('Action: Resume Print');
      return this.client.sendCommand(SDCP_CMD.RESUME_PRINT, {});
    });
    flow.getActionCard('skip_preheat').registerRunListener(async () => {
      this.log('Action: Skip Preheating');
      return this.client.sendCommand(SDCP_CMD.SKIP_PREHEAT, {});
    });
    flow.getActionCard('stop_feeding').registerRunListener(async () => {
      this.log('Action: Stop Material Feeding');
      return this.client.sendCommand(SDCP_CMD.STOP_FEEDING, {});
    });
    flow.getActionCard('send_gcode').registerRunListener(async (args) => {
      this.log(`Action: Send G-Code (${args.gcode})`);
      if (!args.gcode || typeof args.gcode !== 'string') throw new Error('Invalid G-code command');
      return this.client.sendCommand(SDCP_CMD.FDM_SEND_GCODE, { Gcode: args.gcode.trim() });
    });
    flow.getActionCard('home_axes').registerRunListener(async (args) => {
      this.log(`Action: Home Axes (${args.axes})`);
      return this.client.sendCommand(402, { Axis: args.axes });
    });
    flow.getActionCard('set_speed_preset').registerRunListener(async (args) => {
      const pct = parseInt(args.preset);
      this.log(`Action: Set Speed Preset (${pct}%)`);
      return this.client.sendCommand(403, { PrintSpeedPct: pct });
    });
    flow.getActionCard('set_fan_speed_pct').registerRunListener(async (args) => {
      this.log(`Action: Set Fan Speed (${args.fan} -> ${args.percentage}%)`);
      const keyMap = { model: 'ModelFan', aux: 'AuxiliaryFan', exhaust: 'BoxFan' };
      const fanKey = keyMap[args.fan];
      if (!fanKey) throw new Error('Invalid fan selected');
      return this.client.sendCommand(403, { TargetFanSpeed: { [fanKey]: args.percentage } });
    });
    flow.getActionCard('set_chamber_light').registerRunListener(async (args) => {
      this.log(`Action: Set Light (${args.state})`);
      return this.client.sendCommand(403, { LightStatus: { SecondLight: args.state ? 1 : 0 } });
    });
  }

  // ── Flow Conditions ───────────────────────────────────────

  _registerFlowConditions() {
    const flow = this.homey.flow;
    flow
      .getConditionCard('is_printing')
      .registerRunListener(async () => this.getCapabilityValue('printer_status') === 'Printing');
    flow
      .getConditionCard('is_paused')
      .registerRunListener(async () => this.getCapabilityValue('printer_status') === 'Paused');
    flow.getConditionCard('is_offline').registerRunListener(async () => !this.getAvailable());
    flow
      .getConditionCard('is_light_on')
      .registerRunListener(async () => this.getCapabilityValue('onoff.chamberlight') === true);
  }

  // ── Capability Updates (delegated to CapabilityMapper) ────

  /**
   * Main entry point for SDCP data updates.
   * Dispatches to CapabilityMapper for logic.
   */
  updateCapabilities(rawAttr) {
    if (!rawAttr) return;

    // Normalize data: Flatten nested structures into a unified object.
    // Order of precedence: Root > Data > Status > Attributes
    const attr = {
      ...(typeof rawAttr.Attributes === 'object' ? rawAttr.Attributes : {}),
      ...(typeof rawAttr.Status === 'object' && !Array.isArray(rawAttr.Status) ? rawAttr.Status : {}),
      ...(typeof rawAttr.Data === 'object' ? rawAttr.Data : {}),
      ...(typeof rawAttr === 'object' ? rawAttr : {}),
    };

    // Flatten one more level for Data.Status if it exists as an object
    if (rawAttr.Data && typeof rawAttr.Data.Status === 'object' && !Array.isArray(rawAttr.Data.Status)) {
      Object.assign(attr, rawAttr.Data.Status);
    }

    // VERBOSE LOGGING for deep-dive diagnostics
    const sRaw = attr.Status || attr.CurrentStatus;
    this.log(`[SDCP Data] Status: ${JSON.stringify(sRaw)}, PrintStatus: ${attr.PrintInfo?.Status}`);

    // Check for status changes (prioritized logic)
    const oldStatus = this.getCapabilityValue('printer_status');
    const newStatus = CapabilityMapper.updateStatus(this, attr);
    if (newStatus && newStatus !== oldStatus) {
      CapabilityMapper.handleStatusTriggers(this, newStatus, oldStatus);
    }

    // Map remaining telemetry
    CapabilityMapper.updateTemperatures(this, attr);
    CapabilityMapper.updateFansAndLights(this, attr);
    CapabilityMapper.updateFactors(this, attr);
    CapabilityMapper.updateSafetySensors(this, attr);
    CapabilityMapper.updateHardwareInfo(this, attr);
    CapabilityMapper.updateIdleTelemetry(this, attr);
    CapabilityMapper.updateAdvancedInfo(this, attr);
    CapabilityMapper.processSensorTransitions(this, attr);

    // Thumbnail
    if (attr.Thumbnail && attr.Thumbnail.length > 50) {
      this._handleThumbnail(attr.Thumbnail);
    }

    const { progress, layer } = CapabilityMapper.updatePrintInfo(this, attr);
    CapabilityMapper.processThresholdTriggers(this, {
      progress,
      layer,
      nozzleTemp: attr.TempOfNozzle ?? attr.ExtruderTemp,
      bedTemp: attr.TempOfHotbed ?? attr.BedTemp,
      chamberTemp: attr.TempOfBox ?? attr.TempOfAmbient ?? attr.ChamberTemp,
      nozzleTarget: attr.TempTargetNozzle ?? attr.TargetTempOfNozzle ?? attr.ExtruderTargetTemp,
      bedTarget: attr.TempTargetHotbed ?? attr.TargetTempOfHotbed ?? attr.BedTargetTemp,
    });
  }

  _handleThumbnail(base64Data) {
    if (!this.thumbnailImage) return;
    try {
      this.thumbnailBuffer = Buffer.from(base64Data, 'base64');
      this.thumbnailImage.update().catch(this.error);
    } catch (err) {
      this.error('Error updating thumbnail:', err.message);
    }
  }
}

module.exports = ElegooCCDevice;
