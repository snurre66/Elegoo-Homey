'use strict';

const Homey = require('homey');
const SDCPClient = require('./SDCPClient');

/**
 * PrinterDevice is the shared base class for all Elegoo SDCP printer drivers.
 * It handles:
 * - SDCP client lifecycle (connect, disconnect, reconnect)
 * - Flow trigger caching and generic trigger helpers
 * - Homey Insights logging for numeric sensors
 * - Common capability helpers
 */
class PrinterDevice extends Homey.Device {
  async onInit() {
    this.log('Initializing Printer Device:', this.getName());

    // Initialize state
    this.host = this.getSetting('address');

    // Initialize SDCP Client (pass homey for SDK-compliant timers)
    this.client = new SDCPClient({
      host: this.host,
      homey: this.homey,
      logger: (...args) => this.log(...args),
    });

    // Cache ALL flow trigger cards for performance and SDK compliance
    this._initFlowTriggers();

    // Migrate obsolete capabilities on existing paired devices
    await this._migrateCapabilities();

    // Register Insights logs for numeric capabilities
    this._insightsLogs = {};
    await this._initInsights();

    // Client event handlers
    this.client.on('connected', () => {
      this.log('Printer connected');
      this.setAvailable().catch(this.error);
      // Alarm defaults: false = no alarm (normal), true = alarm triggered
      this.safeSetCapabilityValue('alarm_filament', false);
      this.safeSetCapabilityValue('alarm_contact', false);

      this.triggerPrinterOnline.trigger(this).catch(this.error);
    });

    this.client.on('disconnected', () => {
      this.log('Printer disconnected');
      this.setUnavailable(this.homey.__('printer_offline') || 'Printer Offline').catch(this.error);

      this.triggerPrinterOffline.trigger(this).catch(this.error);
    });

    this.client.on('status', (attributes) => {
      this.updateCapabilities(attributes);
    });

    // Initial connection removed from base class to allow drivers to handle migration first
  }

  /**
   * Cache all flow trigger card instances in one place.
   * Override in child classes to add driver-specific triggers.
   */
  _initFlowTriggers() {
    const flow = this.homey.flow;
    // Connection triggers
    this.triggerPrinterOnline = flow.getDeviceTriggerCard('printer_online');
    this.triggerPrinterOffline = flow.getDeviceTriggerCard('printer_offline');
    // Status triggers
    this.triggerStatusChanged = flow.getDeviceTriggerCard('status_changed');
    this.triggerErrorDetected = flow.getDeviceTriggerCard('error_detected');
    // Print lifecycle triggers
    this.triggerPrintStarted = flow.getDeviceTriggerCard('print_started');
    this.triggerPrintFinished = flow.getDeviceTriggerCard('print_finished');
    this.triggerPrintPaused = flow.getDeviceTriggerCard('print_paused');
    this.triggerPrintResumed = flow.getDeviceTriggerCard('print_resumed');
    this.triggerPrintCancelled = flow.getDeviceTriggerCard('print_cancelled');
    // Sensor triggers
    this.triggerFilamentRunout = flow.getDeviceTriggerCard('filament_runout');
    this.triggerDoorStatusChanged = flow.getDeviceTriggerCard('door_status_changed');
    this.triggerUsbStatusChanged = flow.getDeviceTriggerCard('usb_status_changed');
    // Threshold triggers
    this.triggerProgressReached = flow.getDeviceTriggerCard('progress_reached');
    this.triggerProgressReached.registerRunListener(async (args, state) => {
      return !args.percentage || !state.percentage || state.percentage >= args.percentage;
    });
    this.triggerLayerReached = flow.getDeviceTriggerCard('layer_reached');
    this.triggerLayerReached.registerRunListener(async (args, state) => {
      return !args.layer || !state.layer || state.layer >= args.layer;
    });
    this.triggerNozzleTempReached = flow.getDeviceTriggerCard('nozzle_temp_reached');
    this.triggerBedTempReached = flow.getDeviceTriggerCard('bed_temp_reached');
    this.triggerChamberTempReached = flow.getDeviceTriggerCard('chamber_temp_reached');
    this.triggerChamberTempReached.registerRunListener(async (args, state) => {
      return !args.temperature || !state.temperature || state.temperature >= args.temperature;
    });
    // Idle telemetry triggers
    this.triggerCameraStatusChanged = flow.getDeviceTriggerCard('camera_status_changed');
    this.triggerCameraStatusChanged.registerRunListener(async (args, state) => {
      return !args.state || !state.state || args.state === state.state;
    });
    this.triggerVideoStreamStarted = flow.getDeviceTriggerCard('video_stream_started');
    this.triggerVideoStreamStopped = flow.getDeviceTriggerCard('video_stream_stopped');
    this.triggerMotorsStatusChanged = flow.getDeviceTriggerCard('motors_status_changed');
    this.triggerMotorsStatusChanged.registerRunListener(async (args, state) => {
      return !args.state || !state.state || args.state === state.state;
    });
    this.triggerFwUpdateAvailable = flow.getDeviceTriggerCard('fw_update_available');
  }

  /**
   * Initialize Homey Insights logs for all numeric capabilities.
   */
  async _initInsights() {
    const insightsCapabilities = [
      { id: 'measure_temperature.nozzle', label: 'Nozzle Temperature' },
      { id: 'measure_temperature.bed', label: 'Bed Temperature' },
      { id: 'measure_temperature', label: 'Chamber Temperature' },
      { id: 'target_temp_nozzle', label: 'Target Nozzle' },
      { id: 'target_temp_bed', label: 'Target Bed' },
      { id: 'print_progress', label: 'Print Progress' },
      { id: 'layer_progress', label: 'Layer Progress' },
      { id: 'current_layer', label: 'Current Layer' },
      { id: 'total_layers', label: 'Total Layers' },
      { id: 'time_left', label: 'Time Remaining' },
      { id: 'speed_factor', label: 'Speed Factor' },
      { id: 'extrusion_factor', label: 'Extrusion Factor' },
      { id: 'part_fan_speed', label: 'Part Fan Speed' },
      { id: 'z_position', label: 'Z Position' },
      { id: 'x_position', label: 'X Position' },
      { id: 'y_position', label: 'Y Position' },
      { id: 'z_offset', label: 'Z Offset' },
      { id: 'video_stream_count', label: 'Video Stream Count' },
      { id: 'memory_remaining', label: 'Remaining Memory' },
    ];

    for (const cap of insightsCapabilities) {
      if (!this.hasCapability(cap.id)) continue;
      try {
        const logId = cap.id.replace(/\./g, '_');
        const log = await this.homey.insights.createLog(logId, {
          title: cap.label,
          type: 'number',
          chart: 'line',
        });
        this._insightsLogs[cap.id] = log;
      } catch (_err) {
        // Log may already exist — that's fine
      }
    }
  }

  /**
   * Log a value to Homey Insights.
   * @param {string} capabilityId
   * @param {number} value
   */
  _logInsight(capabilityId, value) {
    const log = this._insightsLogs[capabilityId];
    if (log && typeof value === 'number' && isFinite(value)) {
      log.createEntry(value).catch(() => {});
    }
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('Settings changed');

    if (changedKeys.includes('address')) {
      this.log(`IP address changed from ${oldSettings.address} to ${newSettings.address}`);
      this.host = newSettings.address;

      if (this.client) {
        this.log('Re-initializing SDCP client with new host');
        this.client.disconnect();
        this.client.url = `ws://${this.host}:3030/websocket`;
        this.client.connect();
      }

      this.setCapabilityValue('ip_address', this.host).catch(this.error);
    }
  }

  async onUninit() {
    this.log('Uninitializing Printer Device');
    if (this.client) {
      this.client.disconnect();
    }
  }

  /**
   * Override this in child classes to map SDCP attributes to Homey capabilities.
   * @param {object} attributes
   */
  updateCapabilities(_attributes) {
    // To be implemented in drivers
  }

  /**
   * Migrate and order capabilities on existing paired devices.
   */
  async _migrateCapabilities() {
    const desiredCapabilities = [
      'printer_status',
      'print_progress',
      'time_left',
      'filename',
      'current_layer',
      'total_layers',
      'layer_progress',
      'measure_temperature.nozzle',
      'target_temp_nozzle',
      'measure_temperature.bed',
      'target_temp_bed',
      'measure_temperature',
      'onoff.chamberlight',
      'part_fan_speed',
      'onoff.auxfan',
      'onoff.exhaustfan',
      'onoff.boxfan',
      'speed_factor',
      'extrusion_factor',
      'button.pause',
      'button.resume',
      'button.stop',
      'button.home',
      'button.skip_preheat',
      'alarm_filament',
      'alarm_contact',
      'alarm_usb',
      'error_reason',
      'z_position',
      'x_position',
      'y_position',
      'z_offset',
      'motors_engaged',
      'camera_enabled',
      'video_stream_count',
      'network_type',
      'ip_address',
      'mac_address',
      'memory_remaining',
      'firmware_version',
      'printer_model',
      'resolution',
    ];

    try {
      const currentCaps = this.getCapabilities();
      const needsUpdate =
        currentCaps.length !== desiredCapabilities.length ||
        currentCaps.some((cap, idx) => cap !== desiredCapabilities[idx]);

      if (needsUpdate) {
        this.log('[Migration] Updating and ordering device capabilities...');
        await this.setCapabilities(desiredCapabilities);
        this.log('[Migration] Capabilities updated and ordered successfully.');
      }
    } catch (err) {
      this.error('[Migration] Failed to synchronize capabilities:', err);
    }
  }

  /**
   * Helper to set capability value safely with optional Insights logging.
   * @param {string} capability
   * @param {*} value
   */
  safeSetCapabilityValue(capability, value) {
    if (this.hasCapability(capability)) {
      this.setCapabilityValue(capability, value).catch(this.error);
      this._logInsight(capability, value);
    }
  }
}

module.exports = PrinterDevice;
