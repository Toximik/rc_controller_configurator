/**
 * \author Toximik
 * \file protocol.ts
 * \brief MSP message IDs, error codes and the firmware identity this
 *        configurator expects. Mirrors Application/AppMsp/MspProtocol.hpp.
 */

export const MSP = {
  API_VERSION: 1,
  FC_VARIANT: 2,
  FC_VERSION: 3,
  BOARD_INFO: 4,
  BUILD_INFO: 5,

  STATUS: 0x4000,
  RC: 0x4001,
  BATTERY: 0x4002,
  OUTPUTS_LIVE: 0x4003,

  GENERAL: 0x4010,
  SET_GENERAL: 0x4011,
  OUTPUTS: 0x4012,
  SET_OUTPUTS: 0x4013,
  LIGHTS: 0x4014,
  SET_LIGHTS: 0x4015,
  LOG_CONFIG: 0x4016,
  SET_LOG_CONFIG: 0x4017,
  BEEPER_CONFIG: 0x401a,
  SET_BEEPER_CONFIG: 0x401b,

  SAVE: 0x4020,
  DEFAULTS: 0x4021,
  REBOOT: 0x4022,

  LOG_INFO: 0x4030,
  LOG_LIST: 0x4031,
  LOG_READ: 0x4032,
  LOG_ERASE: 0x4033,
  LOG_CONTROL: 0x4034,
} as const;

/** Payload byte of an error reply ("$X!") */
export const MSP_ERRORS: Record<number, string> = {
  1: "unknown message",
  2: "bad length",
  3: "invalid value",
  4: "locked (armed)",
  5: "busy (save running / logger not idle)",
  6: "no settings storage",
  7: "settings area version not supported",
  8: "internal firmware error",
};

/** MSP_FC_VARIANT of the RC_Controller firmware */
export const FC_VARIANT = "RCCT";

/** API major this configurator speaks; a different major is refused at connect */
export const API_MAJOR = 1;
/** Highest API minor this configurator knows (newer minors only add messages / appended fields) */
export const API_MINOR_KNOWN = 6;
/** First API minor with the log download (LOG_INFO .. LOG_CONTROL) */
export const API_MINOR_LOG_DOWNLOAD = 3;
/** First API minor with the BEEPER_CONFIG area */
export const API_MINOR_BEEPER = 5;
