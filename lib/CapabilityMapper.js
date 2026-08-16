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
    if (nozzleTarget !== undefined) device.safeSetCapabilityValue('target_temp_nozzle', nozzleTarget);
    if (bedTarget !== undefined) device.safeSetCapabilityValue('target_temp_bed', bedTarget);

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
        device.triggerErrorDetected.trigger(device, { error_msg: reason, Error_msg: reason }).catch(device.error);
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
    if (attr.RemainingMemory !== undefined) {
      const mb = Math.round((attr.RemainingMemory / (1024 * 1024)) * 10) / 10;
      device.safeSetCapabilityValue('memory_remaining', mb);
    }
  }

  /**
   * Map idle telemetry (network, camera, motors, video streams) and fire related triggers.
   */
  static updateIdleTelemetry(device, attr) {
    if (attr.NetworkStatus !== undefined) device.safeSetCapabilityValue('network_type', attr.NetworkStatus);

    if (attr.CameraStatus !== undefined) {
      const isEnabled = attr.CameraStatus === 1;
      if (device._prevCamEnabled !== null && device._prevCamEnabled !== isEnabled) {
        const state = isEnabled ? 'enabled' : 'disabled';
        device.triggerCameraStatusChanged
          .trigger(device, { state, State: state }, { state })
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
        const state = engaged ? 'engaged' : 'disengaged';
        device.triggerMotorsStatusChanged.trigger(device, { state, State: state }, { state }).catch(device.error);
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
    const sRaw = attr.Status || attr.CurrentStatus;
    const pi = attr.PrintInfo;

    // Guard: If this packet has neither Status nor PrintInfo (e.g. attributes sync or simple response ACK),
    // retain the current status to prevent flickering.
    if (sRaw === undefined && pi === undefined && !device._isHoming) {
      return null;
    }

    const machineRaw = Array.isArray(sRaw?.CurrentStatus)
      ? sRaw.CurrentStatus[0]
      : Array.isArray(sRaw)
        ? sRaw[0]
        : typeof sRaw === 'number'
          ? sRaw
          : null;
    const printRaw = typeof pi?.Status === 'number' ? pi.Status : null;

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

    const isMachineIdle = !machineStatus || machineStatus === 'Idle';
    const isPrintIdle = !printStatus || printStatus === 'Idle';

    if (device._isHoming || machineStatus === 'Homing' || printStatus === 'Homing') {
      status = 'Homing';
    } else if (isMachineIdle && isPrintIdle) {
      const nozzleTarget = attr.TempTargetNozzle ?? attr.TargetTempOfNozzle ?? 0;
      const bedTarget = attr.TempTargetHotbed ?? attr.TargetTempOfHotbed ?? 0;
      if ((nozzleTarget > 0 || bedTarget > 0) && (!pi || !pi.Filename)) {
        status = 'Preheating';
      } else {
        status = 'Idle';
      }
    } else if (machineStatus === printStatus) {
      status = machineStatus;
    } else if (machineStatus && printStatus) {
      if (isMachineIdle) {
        status = printStatus;
      } else if (isPrintIdle) {
        status = machineStatus;
      } else {
        status = `${machineStatus} - ${printStatus}`;
      }
    } else {
      status = machineStatus || printStatus || 'Idle';
    }

    if (status !== oldStatus) {
      device.log(`[Status] Transition: ${oldStatus} -> ${status}`);
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
    const pi = attr.PrintInfo || {};

    if (pi.Filename !== undefined) device.safeSetCapabilityValue('filename', pi.Filename);
    if (pi.CurrentLayer !== undefined) device.safeSetCapabilityValue('current_layer', pi.CurrentLayer);
    if (pi.TotalLayer !== undefined) device.safeSetCapabilityValue('total_layers', pi.TotalLayer);

    const progress = pi.Progress !== undefined ? pi.Progress : attr.Progress;
    if (progress !== undefined) device.safeSetCapabilityValue('print_progress', progress);

    if (pi.CurrentLayer !== undefined && pi.TotalLayer && pi.TotalLayer > 0) {
      const layerPct = Math.min(100, Math.round((pi.CurrentLayer / pi.TotalLayer) * 100));
      device.safeSetCapabilityValue('layer_progress', layerPct);
    }

    if (pi.TotalTicks !== undefined && pi.CurrentTicks !== undefined) {
      const remainingSec = Math.max(0, pi.TotalTicks - pi.CurrentTicks);
      device.safeSetCapabilityValue('time_left', remainingSec);
    }

    return { progress, layer: pi.CurrentLayer };
  }

  /**
   * Map advanced info (coordinates, firmware, model, IP, resolution, fw update).
   */
  static updateAdvancedInfo(device, attr) {
    if (attr.CurrenCoord && typeof attr.CurrenCoord === 'string') {
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
      const currentVer = device.getCapabilityValue('firmware_version') || 'Unknown';
      const version =
        typeof attr.FwUpdate === 'string'
          ? attr.FwUpdate
          : attr.FwUpdateVersion || attr.NewFirmwareVersion || currentVer;
      if (!device._fwUpdateTriggered || device._lastFwUpdateVer !== version) {
        device._fwUpdateTriggered = true;
        device._lastFwUpdateVer = version;
        device.triggerFwUpdateAvailable.trigger(device, { version, Version: version }).catch(device.error);
      }
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
        device.triggerDoorStatusChanged.trigger(device, { State: state, state }).catch(device.error);
      }
      device._prevDoor = attr.Door;
    }
    if (attr.UsbDiskStatus !== undefined) {
      if (device._prevUsb !== null && device._prevUsb !== attr.UsbDiskStatus) {
        const state = attr.UsbDiskStatus === 1 ? 'inserted' : 'removed';
        device.triggerUsbStatusChanged.trigger(device, { State: state, state }).catch(device.error);
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
              device._firedProgress.add(args.percentage);
              device.triggerProgressReached
                .trigger(device, { percentage: progress, Percentage: progress }, args)
                .catch(device.error);
            } else if (progress < args.percentage) {
              device._firedProgress.delete(args.percentage);
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
              device._firedLayers.add(args.layer);
              device.triggerLayerReached.trigger(device, { layer, Layer: layer }, args).catch(device.error);
            } else if (layer < args.layer) {
              device._firedLayers.delete(args.layer);
            }
          }
        })
        .catch(() => {});
    }
    // Nozzle temp reached target
    if (nozzleTarget && nozzleTarget > 0 && nozzleTemp) {
      if (nozzleTemp >= nozzleTarget - 2 && !device._reachedNozzle) {
        device._reachedNozzle = true;
        const tempVal = Math.round(nozzleTemp * 10) / 10;
        device.triggerNozzleTempReached
          .trigger(device, { temperature: tempVal, Temperature: tempVal })
          .catch(device.error);
      } else if (nozzleTemp < nozzleTarget - 5) {
        device._reachedNozzle = false;
      }
    }
    // Bed temp reached target
    if (bedTarget && bedTarget > 0 && bedTemp) {
      if (bedTemp >= bedTarget - 2 && !device._reachedBed) {
        device._reachedBed = true;
        const tempVal = Math.round(bedTemp * 10) / 10;
        device.triggerBedTempReached
          .trigger(device, { temperature: tempVal, Temperature: tempVal })
          .catch(device.error);
      } else if (bedTemp < bedTarget - 5) {
        device._reachedBed = false;
      }
    }
    // Chamber temp reached threshold
    if (chamberTemp !== undefined) {
      device.triggerChamberTempReached
        .getArgumentValues(device)
        .then((argsList) => {
          for (const args of argsList) {
            if (chamberTemp >= args.temperature && !device._firedChamber.has(args.temperature)) {
              device._firedChamber.add(args.temperature);
              const tempVal = Math.round(chamberTemp * 10) / 10;
              device.triggerChamberTempReached
                .trigger(device, { temperature: tempVal, Temperature: tempVal }, args)
                .catch(device.error);
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

    const isPrintingNow = sLower.includes('printing');
    const wasPrinting = oldLower.includes('printing');
    const isPausedNow = sLower.includes('paused');
    const wasPaused = oldLower.includes('paused');
    const isFinishedNow = sLower.includes('finished');
    const wasFinished = oldLower.includes('finished');

    try {
      if (isPrintingNow && !wasPrinting && !wasPaused) {
        device.triggerPrintStarted.trigger(device).catch(device.error);
      } else if (isPrintingNow && wasPaused) {
        device.triggerPrintResumed.trigger(device).catch(device.error);
      } else if (isFinishedNow && !wasFinished) {
        device.triggerPrintFinished.trigger(device).catch(device.error);
      } else if (isPausedNow && !wasPaused) {
        device.triggerPrintPaused.trigger(device).catch(device.error);
      } else if (sLower.includes('error') && !oldLower.includes('error')) {
        device.triggerErrorDetected
          .trigger(device, { error_msg: 'Printer reported error state', Error_msg: 'Printer reported error state' })
          .catch(device.error);
      } else if (sLower === 'idle' && (wasPrinting || wasPaused)) {
        device.triggerPrintCancelled.trigger(device).catch(device.error);
      }

      device.triggerStatusChanged.trigger(device, { Status: newStatus, status: newStatus }).catch(device.error);

      // Clean up threshold trackers on end of print
      if (isFinishedNow || sLower === 'idle' || sLower.includes('error')) {
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
