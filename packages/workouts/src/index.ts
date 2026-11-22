export type {
  FreeRideStep,
  IntervalsStep,
  RampStep,
  StepKind,
  SteadyStep,
  TextCue,
  ValidationResult,
  Workout,
  WorkoutStep,
} from './model';
export { WORKOUT_LIMITS, stepDurationS, totalDurationS, validateWorkout } from './model';

export type {
  ProfilePoint,
  Segment,
  SegmentKind,
  Timeline,
  TimelineCue,
  TrainerMode,
  WorkoutStats,
  WorkoutTarget,
} from './timeline';
export {
  CUE_DISPLAY_S,
  FREE_RIDE_ASSUMED_POWER,
  MAX_INTENSITY,
  MIN_INTENSITY,
  POWER_ZONES,
  buildTimeline,
  powerProfile,
  targetAt,
  workoutStats,
  zoneOf,
} from './timeline';

export type { RunnerChanges, RunnerUpdate, WorkoutRunnerOptions } from './runner';
export { REANCHOR_BACKWARD_S, WorkoutRunner } from './runner';

export type { ZwoParseResult } from './zwo';
export { MAX_ZWO_BYTES, parseZwo, workoutToZwo } from './zwo';

export type { DecodeResult, WorkoutEnvelope } from './codec';
export {
  MAX_ENCODED_WORKOUT_BYTES,
  WORKOUT_FILE_EXTENSION,
  WORKOUT_FORMAT,
  WORKOUT_FORMAT_VERSION,
  decodeWorkout,
  encodeWorkout,
} from './codec';

export { BUILTIN_WORKOUTS, getBuiltinWorkout } from './library';

export type {
  FtpTestInvalidReason,
  FtpTestKind,
  FtpTestProtocol,
  PowerSample,
  RampFailureOptions,
  RampTestResult,
  TwentyMinuteTestResult,
} from './ftpTest';
export {
  FTP_TESTS,
  MIN_RAMP_DURATION_S,
  MIN_WINDOW_COVERAGE,
  RAMP_FAILURE_LOW_S,
  RAMP_FAILURE_RATIO,
  RAMP_FAILURE_STOPPED_S,
  RAMP_TEST,
  RAMP_TEST_CEILING,
  RAMP_TEST_INCREMENT,
  RAMP_TEST_START,
  RAMP_TEST_STEP_S,
  TWENTY_MINUTE_TEST,
  bestAveragePower,
  detectRampFailure,
  evaluateRampTest,
  evaluateTwentyMinuteTest,
  ftpTestEffortWindow,
} from './ftpTest';
