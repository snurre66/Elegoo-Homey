'use strict';

const { FDM_MACHINE_STATUS_MAP, FDM_PRINT_STATUS_MAP, SDCP_ERROR_REASONS } = require('./SDCPCommands');

/**
 * CapabilityMapper contains decomposed helpers for mapping
 * SDCP attributes to Homey capabilities and firing triggers.
 * Each method receives the device instance and the raw attributes object.
 */
class CapabilityMapper {
  /**
   * Map temperature attributes to capabilities.
   * @returns {{ nozzleTemp, bedTemp, chamberTemp, nozzleTarget, bedTarget }}
   */
  static updateTemperatures(device, attr) {
    const nozzleTemp = attr.TempOfNozzle ?? attr.ExtruderTemp;
    const bedTemp = attr.TempOfHotbed ?? attr.BedTemp;
    const chamberTemp = attr.TempOfBox ?? attr.TempOfAmbient ?? attr.ChamberTemp;

    if (nozzleTemp !== undefined) device.safeSetCapabilityValue('measure_temperature.nozzle', nozzleTemp);
    if (bedTemp !== undefined) device.safeSetCapabilityValue('measure_temperature.bed', bedTemp);
    if (chamberTemp !== undefined) device.safeSetCapabilityValue('measure_temperature', chamberTemp);

    const nozzleTarget = attr.TempTargetNozzle ?? attr.TargetTempOfNozzle ?? attr.ExtruderTargetTemp;
    const bedTarget = attr.TempTargetHotbed ?? attr.TargetTempOfHotbed ?? attr.BedTargetTemp;
    if (nozzleTarget !== undefined) device.safeSetCapabilityValue('target_temperature.nozzle', nozzleTarget);
    if (bedTarget !== undefined) device.safeSetCapabilityValue('target_temperature.bed', bedTarget);

    return { nozzleTemp, bedTemp, chamberTemp, nozzleTarget, bedTarget };
  }

  /**
   * Map speed/extrusion factor attributes.
   */
  static updateFactors(device, attr) {
    if (attr.SpeedFactor !== undefined) device.safeSetCapabilityValue('speed_factor', attr.SpeedFactor);
    if (attr.ExtrusionFactor !== undefined) device.safeSetCapabilityValue('extrusion_factor', attr.ExtrusionFactor);
  }

  /**
   * Map fan speed and light attributes.
   */
  static updateFansAndLights(device, attr) {
    if (attr.CurrentFanSpeed) {
      const fs = attr.CurrentFanSpeed;
      if (fs.ModelFan !== undefined) device.safeSetCapabilityValue('part_fan_speed', fs.ModelFan);
      if (fs.AuxiliaryFan !== undefined) device.safeSetCapabilityValue('onoff.auxfan', fs.AuxiliaryFan > 0);
      if (fs.ExhaustFan !== undefined) device.safeSetCapabilityValue('onoff.exhaustfan', fs.ExhaustFan > 0);
      if (fs.BoxFan !== undefined) device.safeSetCapabilityValue('onoff.boxfan', fs.BoxFan > 0);
    }
    if (attr.Fan !== undefined) device.safeSetCapabilityValue('part_fan_speed', attr.Fan);
    if (attr.ExtraFan !== undefined) {
      const on = typeof attr.ExtraFan === 'boolean' ? attr.ExtraFan : attr.ExtraFan > 0;
      device.safeSetCapabilityValue('onoff.auxfan', on);
    }
    if (attr.ExhaustFan !== undefined) device.safeSetCapabilityValue('onoff.exhaustfan', attr.ExhaustFan > 0);

    if (attr.LightStatus && attr.LightStatus.SecondLight !== undefined) {
      device.safeSetCapabilityValue('onoff.chamberlight', attr.LightStatus.SecondLight === 1);
    }
    if (attr.SecondLight !== undefined) {
      device.safeSetCapabilityValue('onoff.chamberlight', attr.SecondLight === 1);
    }
  }

  /**
   * Map safety sensor attributes (filament, door, z-offset, error reason).
   */
  static updateSafetySensors(device, attr) {
    if (attr.Filament !== undefined) device.safeSetCapabilityValue('alarm_filament', attr.Filament === 0);
    if (attr.Door !== undefined) device.safeSetCapabilityValue('alarm_contact', attr.Door === 1);
    if (attr.ZOffset !== undefined) device.safeSetCapabilityValue('z_offset', attr.ZOffset);

    // Map rich Error Status Reason
    const pi = attr.PrintInfo;
    const errCode = pi?.ErrorStatusReason ?? attr.ErrorStatusReason ?? attr.StatusReason;
    if (errCode !== undefined && errCode !== null) {
      const reason = SDCP_ERROR_REASONS[errCode] ?? `Error (${errCode})`;
      device.safeSetCapabilityValue('error_reason', reason);

      if (device._prevErrorCode !== errCode && errCode > 0) {
        device.log(`[Error Detected] Code: ${errCode} -> ${reason}`);
        device.triggerErrorDetected.trigger(device, { error_msg: reason }).catch(device.error);
      }
      device._prevErrorCode = errCode;
    }
  }

  /**
   * Map hardware attributes (USB, MAC, memory).
   */
  static updateHardwareInfo(device, attr) {
    if (attr.UsbDiskStatus !== undefined) device.safeSetCapabilityValue('alarm_usb', attr.UsbDiskStatus === 1);
    if (attr.MainboardMAC !== undefined) device.safeSetCapabilityValue('mac_address', attr.MainboardMAC);
    if (attr.RemainingMemory !== undefined) device.safeSetCapabilityValue('memory_remaining', attr.RemainingMemory);
  }

  /**
   * Map idle telemetry (network, camera, motors, video streams) and fire related triggers.
   */
  static updateIdleTelemetry(device, attr) {
    if (attr.NetworkStatus !== undefined) device.safeSetCapabilityValue('network_type', attr.NetworkStatus);

    if (attr.CameraStatus !== undefined) {
      const isEnabled = attr.CameraStatus === 1;
      if (device._prevCamEnabled !== null && device._prevCamEnabled !== isEnabled) {
        device.triggerCameraStatusChanged
          .trigger(device, { state: isEnabled ? 'enabled' : 'disabled' })
          .catch((err) => device.log('[Warning] Trigger camera_status_changed failed:', err.message));
      }
      device._prevCamEnabled = isEnabled;
      device.safeSetCapabilityValue('camera_enabled', isEnabled);
    }

    if (attr.NumberOfVideoStreamConnected !== undefined) {
      const count = attr.NumberOfVideoStreamConnected;
      if (device._prevStreamCount === 0 && count > 0) {
        device.triggerVideoStreamStarted.trigger(device).catch(device.error);
      } else if (device._prevStreamCount > 0 && count === 0) {
        device.triggerVideoStreamStopped.trigger(device).catch(device.error);
      }
      device._prevStreamCount = count;
      device.safeSetCapabilityValue('video_stream_count', count);
    }

    if (attr.DevicesStatus) {
      const ds = attr.DevicesStatus;
      const engaged = ds.XMotorStatus === 1 || ds.YMotorStatus === 1 || ds.ZMotorStatus === 1 || ds.SgStatus === 1;
      if (device._prevMotors !== null && device._prevMotors !== engaged) {
        device.triggerMotorsStatusChanged
          .trigger(device, { state: engaged ? 'engaged' : 'disengaged' })
          .catch(device.error);
      }
      device._prevMotors = engaged;
      device.safeSetCapabilityValue('motors_engaged', engaged);
    }
  }

  /**
   * Map printer status and detect status transitions.
   * @returns {string|null} New status string if changed, null otherwise.
   */
  static updateStatus(device, attr) {
    // Normalization is now handled by the driver (root + Data + Attributes merged)
    let rawStatus = attr.Status || attr.CurrentStatus;

    // Safety drill-down if we still have a nested object (e.g. { Status: [9] })
    if (rawStatus && typeof rawStatus === 'object' && !Array.isArray(rawStatus)) {
      rawStatus = rawStatus.Status || rawStatus.CurrentStatus || rawStatus;
    }

    const machineRaw = Array.isArray(rawStatus) ? rawStatus[0] : rawStatus !== undefined ? rawStatus : null;

    const pi = attr.PrintInfo;
    const printRaw = pi && pi.Status !== undefined ? pi.Status : null;

    const machineStatus =
      machineRaw !== null && typeof machineRaw !== 'object'
        ? (FDM_MACHINE_STATUS_MAP[machineRaw] ?? `Unknown (${machineRaw})`)
        : null;
    const printStatus =
      printRaw !== null && typeof printRaw !== 'object'
        ? (FDM_PRINT_STATUS_MAP[printRaw] ?? `Unknown (${printRaw})`)
        : null;

    const oldStatus = device.getCapabilityValue('printer_status');
    let status = oldStatus;

    // Priority Logic (Refined for Centauri Carbon):
    // 1. If machine status is explicitly active (Homing, Leveling, Printing), it takes precedence.
    // 2. If print status is active, it can override or refine the status.
    // 3. Only go to Idle if BOTH say so, or if machine says Idle and there's no active print task.

    if (machineStatus && machineStatus !== 'Idle') {
      status = machineStatus;
    }

    // Print Status overrides if it's explicitly active (Printing, Paused, etc)
    if (printStatus && printStatus !== 'Idle') {
      status = printStatus;
    }

    // Explicitly transition to Idle only if we have a confirmation of idleness
    const machineIsIdle = machineStatus === 'Idle';
    const printIsIdleOrMissing = printStatus === 'Idle' || printStatus === null;

    if (machineIsIdle && printIsIdleOrMissing) {
      status = 'Idle';
    }

    if (status !== oldStatus) {
      device.log(`[Status] Transition: ${oldStatus} -> ${status} (Raw Machine: ${machineRaw}, Raw Print: ${printRaw})`);
      device.safeSetCapabilityValue('printer_status', status);
      return status;
    }

    return null;
  }

  /**
   * Map print info (progress, filename, layers, time).
   * @returns {{ progress, layer }}
   */
  static updatePrintInfo(device, attr) {
    const pi = attr.PrintInfo;
    let progress, layer;

    if (pi) {
      if (pi.Progress !== undefined) {
        device.safeSetCapabilityValue('print_progress', pi.Progress);
        progress = pi.Progress;
      }
      if (pi.Filename !== undefined) device.safeSetCapabilityValue('filename', pi.Filename);
      if (pi.CurrentLayer !== undefined) {
        device.safeSetCapabilityValue('current_layer', pi.CurrentLayer);
        layer = pi.CurrentLayer;
      }
      if (pi.TotalLayer !== undefined) device.safeSetCapabilityValue('total_layers', pi.TotalLayer);
      if (pi.TotalLayers !== undefined) device.safeSetCapabilityValue('total_layers', pi.TotalLayers);

      const total = pi.TotalLayer ?? pi.TotalLayers;
      if (pi.CurrentLayer !== undefined && total && total > 0) {
        const pct = Math.min(100, Math.max(0, Math.round((pi.CurrentLayer / total) * 100)));
        device.safeSetCapabilityValue('layer_progress', pct);
      }

      if (pi.CurrentTicks !== undefined && pi.TotalTicks !== undefined && pi.TotalTicks > 0) {
        device.safeSetCapabilityValue('time_left', Math.round(Math.max(0, pi.TotalTicks - pi.CurrentTicks) / 60));
      }
    }

    // Flat fallbacks
    if (attr.PrintProgress !== undefined) {
      device.safeSetCapabilityValue('print_progress', attr.PrintProgress);
      progress = progress ?? attr.PrintProgress;
    }
    if (attr.FileName !== undefined) device.safeSetCapabilityValue('filename', attr.FileName);

    const fbLayer = attr.CurrentLayer;
    const fbTotal = attr.TotalLayer ?? attr.TotalLayers;
    if (fbLayer !== undefined && fbTotal && fbTotal > 0) {
      device.safeSetCapabilityValue(
        'layer_progress',
        Math.min(100, Math.max(0, Math.round((fbLayer / fbTotal) * 100))),
      );
    }
    if (attr.RemainingTime !== undefined) {
      device.safeSetCapabilityValue('time_left', Math.round(attr.RemainingTime / 60));
    }

    layer = layer ?? attr.CurrentLayer;
    return { progress, layer };
  }

  /**
   * Map axis positions and firmware/model info.
   */
  static updateAdvancedInfo(device, attr) {
    if (attr.CurrenCoord) {
      const parts = attr.CurrenCoord.split(',');
      if (parts.length >= 3) {
        const [x, y, z] = parts.map((p) => parseFloat(p));
        if (!isNaN(x)) device.safeSetCapabilityValue('x_position', Math.round(x * 100) / 100);
        if (!isNaN(y)) device.safeSetCapabilityValue('y_position', Math.round(y * 100) / 100);
        if (!isNaN(z)) device.safeSetCapabilityValue('z_position', Math.round(z * 100) / 100);
      }
    } else if (attr.ZPosition !== undefined) {
      device.safeSetCapabilityValue('z_position', Math.round(attr.ZPosition * 100) / 100);
    }

    if (attr.FwVersion !== undefined) device.safeSetCapabilityValue('firmware_version', attr.FwVersion);
    if (attr.FirmwareVersion !== undefined) device.safeSetCapabilityValue('firmware_version', attr.FirmwareVersion);
    if (attr.MachineName !== undefined) device.safeSetCapabilityValue('printer_model', attr.MachineName);
    if (attr.MainboardIP !== undefined) device.safeSetCapabilityValue('ip_address', attr.MainboardIP);
    if (attr.Resolution !== undefined) device.safeSetCapabilityValue('resolution', attr.Resolution);

    if (attr.FwUpdate) {
      device.triggerFwUpdateAvailable.trigger(device).catch(device.error);
    }
  }

  /**
   * Fire sensor transition triggers (filament, door, USB).
   */
  static processSensorTransitions(device, attr) {
    if (attr.Filament !== undefined) {
      if (device._prevFilament === 1 && attr.Filament === 0) {
        device.triggerFilamentRunout.trigger(device).catch(device.error);
      }
      device._prevFilament = attr.Filament;
    }
    if (attr.Door !== undefined) {
      if (device._prevDoor !== null && device._prevDoor !== attr.Door) {
        const state = attr.Door === 1 ? 'opened' : 'closed';
        device.triggerDoorStatusChanged.trigger(device, { state }).catch(device.error);
      }
      device._prevDoor = attr.Door;
    }
    if (attr.UsbDiskStatus !== undefined) {
      if (device._prevUsb !== null && device._prevUsb !== attr.UsbDiskStatus) {
        const state = attr.UsbDiskStatus === 1 ? 'inserted' : 'removed';
        device.triggerUsbStatusChanged.trigger(device, { state }).catch(device.error);
      }
      device._prevUsb = attr.UsbDiskStatus;
    }
  }

  /**
   * Fire threshold-based triggers (progress %, layer, temperatures).
   */
  static processThresholdTriggers(
    device,
    { progress, layer, nozzleTemp, bedTemp, chamberTemp, nozzleTarget, bedTarget },
  ) {
    // Progress threshold
    if (progress !== undefined && progress > 0) {
      device.triggerProgressReached
        .getArgumentValues(device)
        .then((argsList) => {
          for (const args of argsList) {
            if (progress >= args.percentage && !device._firedProgress.has(args.percentage)) {
              device.triggerProgressReached.trigger(device, {}, args).catch(device.error);
              device._firedProgress.add(args.percentage);
            }
          }
        })
        .catch(() => {});
    }
    // Layer threshold
    if (layer !== undefined && layer > 0) {
      device.triggerLayerReached
        .getArgumentValues(device)
        .then((argsList) => {
          for (const args of argsList) {
            if (layer >= args.layer && !device._firedLayers.has(args.layer)) {
              device.triggerLayerReached.trigger(device, {}, args).catch(device.error);
              device._firedLayers.add(args.layer);
            }
          }
        })
        .catch(() => {});
    }
    // Nozzle temp reached
    if (nozzleTemp !== undefined && nozzleTarget !== undefined && nozzleTarget > 0) {
      if (!device._reachedNozzle && nozzleTemp >= nozzleTarget - 1) {
        device.triggerNozzleTempReached.trigger(device).catch(device.error);
        device._reachedNozzle = true;
      } else if (nozzleTemp < nozzleTarget - 5) {
        device._reachedNozzle = false;
      }
    }
    // Bed temp reached
    if (bedTemp !== undefined && bedTarget !== undefined && bedTarget > 0) {
      if (!device._reachedBed && bedTemp >= bedTarget - 1) {
        device.triggerBedTempReached.trigger(device).catch(device.error);
        device._reachedBed = true;
      } else if (bedTemp < bedTarget - 5) {
        device._reachedBed = false;
      }
    }
    // Chamber temp threshold
    if (chamberTemp !== undefined) {
      device.triggerChamberTempReached
        .getArgumentValues(device)
        .then((argsList) => {
          for (const args of argsList) {
            if (chamberTemp >= args.temperature && !device._firedChamber.has(args.temperature)) {
              device.triggerChamberTempReached.trigger(device, {}, args).catch(device.error);
              device._firedChamber.add(args.temperature);
            } else if (chamberTemp < args.temperature - 2) {
              device._firedChamber.delete(args.temperature);
            }
          }
        })
        .catch(() => {});
    }
  }

  /**
   * Handle status transition triggers.
   */
  static handleStatusTriggers(device, newStatus, oldStatus) {
    if (newStatus === oldStatus || !oldStatus) return;
    const sLower = newStatus.toLowerCase();
    const oldLower = oldStatus.toLowerCase();

    try {
      if (sLower === 'printing' && oldLower !== 'printing') {
        const trigger = oldLower === 'paused' ? device.triggerPrintResumed : device.triggerPrintStarted;
        trigger.trigger(device).catch(device.error);
      } else if (sLower === 'finished' && oldLower !== 'finished') {
        device.triggerPrintFinished.trigger(device).catch(device.error);
      } else if (sLower === 'paused' && oldLower !== 'paused') {
        device.triggerPrintPaused.trigger(device).catch(device.error);
      } else if (sLower === 'error' && oldLower !== 'error') {
        device.triggerErrorDetected.trigger(device, { error_msg: 'Printer reported error state' }).catch(device.error);
      } else if (sLower === 'idle' && (oldLower === 'printing' || oldLower === 'paused')) {
        device.triggerPrintCancelled.trigger(device).catch(device.error);
      }

      device.triggerStatusChanged.trigger(device, { status: newStatus }).catch(device.error);

      // Clean up threshold trackers on end of print
      if (sLower === 'finished' || sLower === 'idle' || sLower === 'error') {
        device._firedProgress.clear();
        device._firedLayers.clear();
        device._reachedNozzle = false;
        device._reachedBed = false;
        device._firedChamber.clear();
      }
    } catch (err) {
      device.log('[Warning] Failed to trigger flow card:', err.message);
    }
  }
}

module.exports = CapabilityMapper;
