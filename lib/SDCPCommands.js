'use strict';

/**
 * SDCP V3 Protocol Command Constants.
 *
 * Official SDCP v3 commands (from cbd-tech/SDCP-Smart-Device-Control-Protocol-V3.0.0):
 *   0, 1, 128–133, 192, 255, 258, 259, 320, 321, 386, 387
 *
 * FDM-specific commands (Centauri Carbon / Klipper-based firmware):
 *   2–4, 7, 12–18, 260, 385
 *   These are reverse-engineered extensions not in the official spec.
 */
const SDCP_CMD = Object.freeze({
  // --- Official SDCP v3 Commands ---
  GET_STATUS: 0,
  GET_ATTRIBUTES: 1,
  START_PRINT: 128,
  PAUSE_PRINT: 129,
  STOP_PRINT: 130,
  RESUME_PRINT: 131,
  STOP_FEEDING: 132,
  SKIP_PREHEAT: 133,
  RENAME_PRINTER: 192,
  TERMINATE_TRANSFER: 255,
  LIST_FILES: 258,
  DELETE_FILES: 259,
  GET_HISTORY: 320,
  GET_HISTORY_DETAIL: 321,
  TOGGLE_VIDEO_STREAM: 386,
  TOGGLE_TIMELAPSE: 387,

  // --- FDM-Specific Commands (Centauri Carbon) ---
  FDM_PAUSE: 2,
  FDM_RESUME: 3,
  FDM_STOP: 4,
  FDM_SET_PART_FAN: 7,
  FDM_SET_LIGHT: 12,
  FDM_SET_SPEED: 13,
  FDM_SET_EXTRUSION: 14,
  FDM_SET_AUX_FAN: 15,
  FDM_SET_EXHAUST_FAN: 16,
  FDM_HOME_AXIS: 17,
  FDM_SET_MODEL_FAN: 18,
  FDM_SEND_GCODE: 260,
  FDM_GET_ATTRIBUTES: 385,

  // --- Centauri Carbon Specific Extensions ---
  CC_HOME_ALL: 402,
  CC_SET_CONFIG: 403,
});

/**
 * SDCP Machine Status Codes (official + FDM extensions).
 */
const SDCP_STATUS = Object.freeze({
  // Machine Status (CurrentStatus)
  IDLE: 0,
  PRINTING: 1,
  STOPPING: 7,
  STOPPED: 8,
  HOMING: 9,
  LOADING: 10,

  // Print Status (PrintInfo.Status)
  PRINT_IDLE: 0,
  PRINT_HOMING: 1,
  PRINT_PRINTING: 3,
  PRINT_PAUSED: 6,
  PRINT_COMPLETE: 9,
  PRINT_PREHEATING: 16,
});

/**
 * FDM-specific status map for the Centauri Carbon.
 * Maps raw CurrentStatus codes to human-readable strings.
 */
const FDM_MACHINE_STATUS_MAP = Object.freeze({
  0: 'Idle',
  1: 'Printing',
  2: 'File Transferring',
  3: 'Exposure Testing',
  4: 'Devices Testing',
  5: 'Leveling',
  6: 'Input Shaping',
  7: 'Stopping',
  8: 'Stopped',
  9: 'Homing',
  10: 'Loading/Unloading',
  11: 'PID Tuning',
  12: 'Recovery',
  13: 'Printing',
});

const FDM_PRINT_STATUS_MAP = Object.freeze({
  0: 'Idle',
  1: 'Homing',
  2: 'Dropping',
  3: 'Printing',
  4: 'Lifting',
  5: 'Pausing',
  6: 'Paused',
  7: 'Stopping',
  8: 'Stopped',
  9: 'Finished',
  10: 'File Checking',
  12: 'Recovery',
  13: 'Printing',
  15: 'Loading',
  16: 'Preheating',
  18: 'Loading',
  19: 'Loading',
  20: 'Leveling',
  21: 'Loading',
});

/**
 * SDCP Error Status Reasons (PrintInfo.ErrorStatusReason / StatusReason)
 */
const SDCP_ERROR_REASONS = Object.freeze({
  0: 'OK',
  1: 'Temperature Error (Nozzle/Bed)',
  3: 'Filament Runout',
  6: 'Filament Jam / Clog',
  7: 'Bed Leveling Failed',
  12: 'USB Drive Removed',
  13: 'Homing Failed (X-Axis)',
  14: 'Homing Failed (Z-Axis)',
  17: 'Homing Failed (General)',
  18: 'Bed Adhesion Failed',
  19: 'General Printing Exception',
  20: 'Abnormal Motor Movement',
  23: 'Homing Failed (Y-Axis)',
  24: 'File Read Error',
  25: 'Camera Error',
  26: 'Network Error',
  27: 'Server Connection Failed',
  28: 'App Disconnected',
  33: 'Nozzle Temperature Sensor Offline',
  34: 'Bed Temperature Sensor Offline',
  45: 'Filament About to Run Out',
});

module.exports = {
  SDCP_CMD,
  SDCP_STATUS,
  FDM_MACHINE_STATUS_MAP,
  FDM_PRINT_STATUS_MAP,
  SDCP_ERROR_REASONS,
};
