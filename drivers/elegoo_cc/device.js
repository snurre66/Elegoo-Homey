'use strict';

const http = require('http');
const { Readable } = require('stream');
const PrinterDevice = require('../../lib/PrinterDevice');
const { SDCP_CMD } = require('../../lib/SDCPCommands');
const CapabilityMapper = require('../../lib/CapabilityMapper');

// Static JPEG SOI and EOI markers
const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);

// 1x1 transparent PNG fallback buffer to prevent Homey decoding errors when idle
const FALLBACK_THUMBNAIL_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAAElFTkSuQmCC',
  'base64',
);

class ElegooCCDevice extends PrinterDevice {
  async onInit() {
    await super.onInit();
    this.log(`Elegoo Centauri Carbon device initialized at ${this.host}`);

    this._lastTaskId = null;
    this._lastThumbData = null;
    this.thumbnailBuffer = null;
    this._homingTimeout = null;
    this._initCameraTimeout = null;

    this.registerCamera().catch((err) => this.error(err));
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
    if (settings.model) this.setCapabilityValue('printer_model', settings.model).catch((err) => this.error(err));
    if (settings.address) this.setCapabilityValue('ip_address', settings.address).catch((err) => this.error(err));

    // Connect after all capabilities are ready
    this.client.connect();

    this.client.on('connected', () => {
      this.log('Enabling printer video stream (CMD 386)');
      this.client.sendCommand(SDCP_CMD.TOGGLE_VIDEO_STREAM, { Enable: 1 }).catch(() => {});
    });

    // Periodic attribute refresh (FDM-specific Cmd 385) & video stream keepalive (Cmd 386)
    this._attrInterval = this.homey.setInterval(() => {
      this.log('Periodic sync: Requesting attributes (FDM_GET_ATTRIBUTES)');
      this.client.sendCommand(SDCP_CMD.FDM_GET_ATTRIBUTES).catch(() => {});
      this.client.sendCommand(SDCP_CMD.TOGGLE_VIDEO_STREAM, { Enable: 1 }).catch(() => {});
    }, 60000);
  }

  async onUninit() {
    this.log('Elegoo CC Device uninitializing');
    if (this._attrInterval) this.homey.clearInterval(this._attrInterval);
    if (this._homingTimeout) this.homey.clearTimeout(this._homingTimeout);
    if (this._initCameraTimeout) this.homey.clearTimeout(this._initCameraTimeout);
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
          const buf = buffer && buffer.length > 0 ? buffer : FALLBACK_THUMBNAIL_BUFFER;
          return Readable.from(buf).pipe(stream);
        } catch (error) {
          this.error('Camera mapping error:', error.message);
          return Readable.from(FALLBACK_THUMBNAIL_BUFFER).pipe(stream);
        }
      });

      await this.setCameraImage('elegoo_snapshot', 'Snapshot', this.snapshotImage)
        .then(() => this.log('Camera: Snapshot registered OK'))
        .catch((e) => this.error('Camera: setCameraImage FAILED:', e.message));

      // Initial fetch after 3s
      this._initCameraTimeout = this.homey.setTimeout(() => {
        this.snapshotImage
          .update()
          .then(() => this.log('Camera: initial update() OK'))
          .catch((e) => this.error('Camera: initial update() FAILED:', e.message));
      }, 3000);

      // Thumbnail Preview Image (with fallback buffer to prevent decoder errors)
      this.thumbnailImage = await this.homey.images.createImage();
      this.thumbnailImage.setStream(async (stream) => {
        const buf =
          this.thumbnailBuffer && this.thumbnailBuffer.length > 0 ? this.thumbnailBuffer : FALLBACK_THUMBNAIL_BUFFER;
        return Readable.from(buf).pipe(stream);
      });

      await this.setCameraImage('elegoo_thumbnail', 'Print Preview', this.thumbnailImage)
        .then(() => this.log('Camera: Print Preview Thumbnail registered OK'))
        .catch((e) => this.error('Camera: setCameraImage Thumbnail FAILED:', e.message));

      this.thumbnailImage.update().catch(() => {});

      // Live Video Stream (supported on Homey Pro 2023+, optional on older models)
      if (this.homey.videos && typeof this.homey.videos.createVideoOther === 'function') {
        try {
          this.liveVideo = await this.homey.videos.createVideoOther();
          this.liveVideo.registerVideoUrlListener(async () => {
            const url = `http://${this.host}:3031/video`;
            this.log(`Camera: live stream URL requested, returning ${url}`);
            return url;
          });

          await this.setCameraVideo('elegoo_live', 'Live Stream', this.liveVideo)
            .then(() => this.log('Camera: Live Stream registered OK'))
            .catch((e) => this.log('Camera: setCameraVideo skipped/unsupported:', e.message));
        } catch (videoErr) {
          this.log('Camera: Video streaming not supported on this Homey model:', videoErr.message);
        }
      }
    } catch (err) {
      this.error('Critical: Failed to register camera feeds:', err.message);
    }
  }

  async _fetchSnapshotBuffer() {
    return new Promise((resolve) => {
      let isResolved = false;
      let req = null;
      let resRef = null;
      let timeout = null;

      const done = (result) => {
        if (isResolved) return;
        isResolved = true;
        if (timeout) this.homey.clearTimeout(timeout);
        if (resRef) {
          try {
            resRef.removeAllListeners();
            resRef.destroy();
          } catch (_e) {
            // Ignore stream destroy error
          }
        }
        if (req && !req.destroyed) {
          try {
            req.destroy();
          } catch (_e) {
            // Ignore request abort error
          }
        }
        resolve(result);
      };

      const url = `http://${this.host}:3031/video`;
      this.log(`Camera: connecting to ${url}`);

      timeout = this.homey.setTimeout(() => {
        this.log('Camera: timeout waiting for MJPEG frame');
        done(null);
      }, 5000);

      req = http.get(url, (res) => {
        resRef = res;
        this.log(`Camera: HTTP ${res.statusCode} content-type: ${res.headers['content-type']}`);
        if (res.statusCode !== 200) {
          res.resume();
          done(null);
          return;
        }

        // Scan incoming chunks for JPEG SOI (0xFFD8) and EOI (0xFFD9) markers
        const chunks = [];
        let totalBytes = 0;

        res.on('data', (chunk) => {
          if (isResolved) return;
          chunks.push(chunk);
          totalBytes += chunk.length;

          // Guard against runaway memory if stream is corrupt (max 2MB per frame search)
          if (totalBytes > 2 * 1024 * 1024) {
            this.log('Camera: frame buffer exceeded 2MB without EOI marker');
            done(null);
            return;
          }

          // Fast path: only test buffer concat if the current chunk contains JPEG end marker byte
          if (chunk.includes(0xd9)) {
            const buf = Buffer.concat(chunks);
            const start = buf.indexOf(JPEG_SOI);
            if (start !== -1) {
              const end = buf.indexOf(JPEG_EOI, start + 2);
              if (end !== -1) {
                const frame = buf.slice(start, end + 2);
                this.log(`Camera: extracted JPEG frame ${frame.length} bytes`);
                done(frame);
              }
            }
          }
        });

        res.on('end', () => {
          done(null);
        });
      });

      req.on('error', (err) => {
        if (err.code !== 'ECONNRESET' && !err.message.includes('socket hang up')) {
          this.error(`Camera: fetch error: ${err.message}`);
        }
        done(null);
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
      this.log('UI: Home All Axes (CMD 402)');
      this._isHoming = true;
      this.setCapabilityValue('printer_status', 'Homing').catch(() => {});
      if (this._homingTimeout) this.homey.clearTimeout(this._homingTimeout);
      this._homingTimeout = this.homey.setTimeout(() => {
        this._isHoming = false;
        this.updateCapabilities({});
      }, 25000);
      return this.client.sendCommand(SDCP_CMD.CC_HOME_ALL, { Axis: 'XYZ' });
    });
    this.registerCapabilityListener('button.skip_preheat', async () => {
      this.log('UI: Skip Preheating');
      return this.client.sendCommand(SDCP_CMD.SKIP_PREHEAT, {});
    });

    // Performance factors
    this.registerCapabilityListener('speed_factor', async (value) => {
      this.log(`UI: Set Speed Factor -> ${value}%`);
      return this.client.sendCommand(SDCP_CMD.CC_SET_CONFIG, { PrintSpeedPct: value });
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
      return this.client.sendCommand(SDCP_CMD.CC_SET_CONFIG, { TargetFanSpeed: { ExhaustFan: value ? 100 : 0 } });
    });
    this.registerCapabilityListener('onoff.boxfan', async (value) => {
      this.log(`UI: Set Box Fan -> ${value ? 'ON' : 'OFF'}`);
      return this.client.sendCommand(SDCP_CMD.CC_SET_CONFIG, { TargetFanSpeed: { BoxFan: value ? 100 : 0 } });
    });
  }

  // ── Flow Actions ──────────────────────────────────────────

  _registerFlowActions() {
    const flow = this.homey.flow;
    flow.getActionCard('emergency_stop').registerRunListener(async (args) => {
      const device = args?.device || this;
      device.log('Action: Emergency Stop');
      return device.client.sendCommand(SDCP_CMD.STOP_PRINT, {});
    });
    flow.getActionCard('pause_print').registerRunListener(async (args) => {
      const device = args?.device || this;
      device.log('Action: Pause Print');
      return device.client.sendCommand(SDCP_CMD.PAUSE_PRINT, {});
    });
    flow.getActionCard('resume_print').registerRunListener(async (args) => {
      const device = args?.device || this;
      device.log('Action: Resume Print');
      return device.client.sendCommand(SDCP_CMD.RESUME_PRINT, {});
    });
    flow.getActionCard('skip_preheat').registerRunListener(async (args) => {
      const device = args?.device || this;
      device.log('Action: Skip Preheating');
      return device.client.sendCommand(SDCP_CMD.SKIP_PREHEAT, {});
    });
    flow.getActionCard('stop_feeding').registerRunListener(async (args) => {
      const device = args?.device || this;
      device.log('Action: Stop Material Feeding');
      return device.client.sendCommand(SDCP_CMD.STOP_FEEDING, {});
    });
    flow.getActionCard('send_gcode').registerRunListener(async (args) => {
      const device = args?.device || this;
      device.log(`Action: Send G-Code (${args.gcode})`);
      if (!args.gcode || typeof args.gcode !== 'string') throw new Error('Invalid G-code command');
      return device.client.sendCommand(SDCP_CMD.FDM_SEND_GCODE, { Gcode: args.gcode.trim() });
    });
    flow.getActionCard('home_axes').registerRunListener(async (args) => {
      const device = args?.device || this;
      device.log(`Action: Home Axes (${args.axes})`);
      device._isHoming = true;
      device.setCapabilityValue('printer_status', 'Homing').catch(() => {});
      if (device._homingTimeout) device.homey.clearTimeout(device._homingTimeout);
      device._homingTimeout = device.homey.setTimeout(() => {
        device._isHoming = false;
        device.updateCapabilities({});
      }, 25000);
      return device.client.sendCommand(SDCP_CMD.CC_HOME_ALL, { Axis: args.axes });
    });
    flow.getActionCard('set_speed_preset').registerRunListener(async (args) => {
      const device = args?.device || this;
      const pct = parseInt(args.preset);
      device.log(`Action: Set Speed Preset (${pct}%)`);
      return device.client.sendCommand(SDCP_CMD.CC_SET_CONFIG, { PrintSpeedPct: pct });
    });
    flow.getActionCard('set_fan_speed_pct').registerRunListener(async (args) => {
      const device = args?.device || this;
      device.log(`Action: Set Fan Speed (${args.fan} -> ${args.percentage}%)`);
      const keyMap = { model: 'ModelFan', aux: 'AuxiliaryFan', exhaust: 'ExhaustFan' };
      const fanKey = keyMap[args.fan];
      if (!fanKey) throw new Error('Invalid fan selected');
      return device.client.sendCommand(SDCP_CMD.CC_SET_CONFIG, { TargetFanSpeed: { [fanKey]: args.percentage } });
    });
    flow.getActionCard('set_chamber_light').registerRunListener(async (args) => {
      const device = args?.device || this;
      const isOn = args.state === 'on' || args.state === true || args.state === 1;
      device.log(`Action: Set Chamber Light (${isOn ? 'ON' : 'OFF'})`);
      return device.client.sendCommand(SDCP_CMD.CC_SET_CONFIG, { LightStatus: { SecondLight: isOn ? 1 : 0 } });
    });
  }

  // ── Flow Conditions ───────────────────────────────────────

  _registerFlowConditions() {
    const flow = this.homey.flow;
    flow.getConditionCard('is_printing').registerRunListener(async (args) => {
      const device = args?.device || this;
      const s = device.getCapabilityValue('printer_status') || '';
      return s.toLowerCase().includes('printing');
    });
    flow.getConditionCard('is_paused').registerRunListener(async (args) => {
      const device = args?.device || this;
      const s = device.getCapabilityValue('printer_status') || '';
      return s.toLowerCase().includes('paused');
    });
    flow.getConditionCard('is_offline').registerRunListener(async (args) => {
      const device = args?.device || this;
      return !device.getAvailable();
    });
    flow.getConditionCard('is_light_on').registerRunListener(async (args) => {
      const device = args?.device || this;
      return device.getCapabilityValue('onoff.chamberlight') === true;
    });
  }

  // ── Capability Updates (delegated to CapabilityMapper) ────

  /**
   * Main entry point for SDCP data updates.
   * Dispatches to CapabilityMapper for logic.
   */
  updateCapabilities(rawAttr) {
    if (!rawAttr) return;

    // Deep drill-down normalization for all SDCP packet structures
    const statusObj =
      rawAttr.Data?.Data?.Status ||
      rawAttr.Data?.Status ||
      (rawAttr.Status && typeof rawAttr.Status === 'object' && !Array.isArray(rawAttr.Status)
        ? rawAttr.Status
        : null) ||
      {};

    const attrObj =
      rawAttr.Data?.Data?.Attributes ||
      rawAttr.Data?.Attributes ||
      (rawAttr.Attributes && typeof rawAttr.Attributes === 'object' ? rawAttr.Attributes : null) ||
      {};

    const dataObj =
      (rawAttr.Data?.Data && typeof rawAttr.Data.Data === 'object' ? rawAttr.Data.Data : null) ||
      (rawAttr.Data && typeof rawAttr.Data === 'object' ? rawAttr.Data : null) ||
      {};

    const attr = {
      ...attrObj,
      ...statusObj,
      ...dataObj,
      ...(typeof rawAttr === 'object' ? rawAttr : {}),
      ...(statusObj.CurrentStatus !== undefined ? { CurrentStatus: statusObj.CurrentStatus } : {}),
      ...(statusObj.PrintInfo ? { PrintInfo: statusObj.PrintInfo } : {}),
      ...(statusObj.DevicesStatus ? { DevicesStatus: statusObj.DevicesStatus } : {}),
      ...(statusObj.LightStatus ? { LightStatus: statusObj.LightStatus } : {}),
      ...(statusObj.CurrentFanSpeed ? { CurrentFanSpeed: statusObj.CurrentFanSpeed } : {}),
      ...(statusObj.CurrenCoord !== undefined ? { CurrenCoord: statusObj.CurrenCoord } : {}),
      ...(statusObj.TempOfNozzle !== undefined ? { TempOfNozzle: statusObj.TempOfNozzle } : {}),
      ...(statusObj.TempOfHotbed !== undefined ? { TempOfHotbed: statusObj.TempOfHotbed } : {}),
      ...(statusObj.TempOfBox !== undefined ? { TempOfBox: statusObj.TempOfBox } : {}),
      ...(statusObj.ZOffset !== undefined ? { ZOffset: statusObj.ZOffset } : {}),
    };

    // Detect coordinate motion while idle (e.g. manual homing or jogging from printer touchscreen)
    const currentCoord = attr.CurrenCoord;
    if (currentCoord && typeof currentCoord === 'string') {
      if (this._prevCoord && this._prevCoord !== currentCoord && (!attr.PrintInfo || !attr.PrintInfo.Filename)) {
        if (!this._isHoming) {
          this.log(
            `[Motion] Detected coordinate change (${this._prevCoord} -> ${currentCoord}) during standby, setting status to Homing`,
          );
          this._isHoming = true;
          if (this._homingTimeout) this.homey.clearTimeout(this._homingTimeout);
          this._homingTimeout = this.homey.setTimeout(() => {
            this._isHoming = false;
            this.updateCapabilities({});
          }, 10000);
        }
      }
      this._prevCoord = currentCoord;
    }

    // Check for status changes (prioritized logic)
    const oldStatus = this.getCapabilityValue('printer_status');
    const newStatus = CapabilityMapper.updateStatus(this, attr);
    if (newStatus && newStatus !== oldStatus) {
      CapabilityMapper.handleStatusTriggers(this, newStatus, oldStatus);
      if (this.snapshotImage) {
        this.snapshotImage.update().catch(() => {});
      }
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

    // Auto-fetch thumbnail if new TaskId is detected
    const taskId = attr.PrintInfo?.TaskId || attr.TaskId;
    if (taskId && taskId !== this._lastTaskId) {
      this._lastTaskId = taskId;
      this.log(`New TaskId detected (${taskId}), requesting task details with thumbnail (CMD 321)`);
      this.client.sendCommand(SDCP_CMD.GET_HISTORY_DETAIL, { Id: [taskId] }).catch(() => {});
    }

    // Thumbnail
    const thumbData = attr.Thumbnail || attr.thumbnail || attr.TaskDetail?.Thumbnail || attr.TaskDetail?.thumbnail;
    if (thumbData && thumbData.length > 20) {
      this._handleThumbnail(thumbData);
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

  _handleThumbnail(thumbData) {
    if (!this.thumbnailImage || !thumbData) return;
    if (thumbData === this._lastThumbData) return;
    this._lastThumbData = thumbData;

    try {
      if (typeof thumbData === 'string') {
        if (thumbData.startsWith('http://') || thumbData.startsWith('https://')) {
          const req = http.get(thumbData, (res) => {
            if (res.statusCode !== 200) {
              res.resume();
              return;
            }
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
              if (chunks.length > 0) {
                this.thumbnailBuffer = Buffer.concat(chunks);
                this.thumbnailImage.update().catch((err) => this.error(err));
              }
            });
          });
          req.setTimeout(5000, () => req.destroy());
          req.on('error', (e) => this.error('Error fetching thumbnail URL:', e.message));
        } else {
          const cleanBase64 = thumbData.replace(/^data:image\/\w+;base64,/, '');
          this.thumbnailBuffer = Buffer.from(cleanBase64, 'base64');
          this.thumbnailImage.update().catch((err) => this.error(err));
        }
      }
    } catch (err) {
      this.error('Error updating thumbnail:', err.message);
    }
  }

  onDeleted() {
    this.log('Device being deleted or app stopped, cleaning up...');
    if (this._homingTimeout) this.homey.clearTimeout(this._homingTimeout);
    if (this.client) {
      this.client.disconnect();
    }
  }
}

module.exports = ElegooCCDevice;
