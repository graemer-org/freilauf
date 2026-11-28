export * from './types';

export type { GpxParseResult, RawPoint, RawTrack } from './gpx';
export { MAX_GPX_BYTES, MAX_GPX_POINTS, parseGpx, routeToGpx } from './gpx';

export type { BuildOptions, BuildStats, PrepareResult, SmoothingOptions } from './build';
export {
  DEFAULT_SMOOTHING,
  DEFAULT_STEP_M,
  LOOP_MAX_GAP_M,
  LOOP_MIN_LENGTH_M,
  MAX_ROUTE_LENGTH_M,
  MAX_TRACK_SAMPLES,
  MIN_ROUTE_LENGTH_M,
  ascentDescent,
  buildRoute,
  prepareRoute,
  resampleTrack,
} from './build';

export type { Lookahead, RoutePoint } from './query';
export {
  FINISH_MARGIN_M,
  MAX_CURVATURE,
  ascentTo,
  curvatureAt,
  elevationAt,
  gradeAt,
  headingAt,
  lookahead,
  normalizeRouteStart,
  outline,
  pointAt,
  positionAt,
  profile,
  routeBaseId,
} from './query';

export type { DecodeRouteResult, EncodeOptions, ShareRouteResult } from './codec';
export {
  MAX_ENCODED_ROUTE_BYTES,
  MAX_SHARE_STEP_M,
  ROUTE_FILE_EXTENSION,
  ROUTE_FORMAT,
  ROUTE_FORMAT_VERSION,
  ROUTE_SHARE_BUDGET_BYTES,
  SHARE_STEPS_M,
  decodeRoute,
  encodeRoute,
  simplifyForSharing,
} from './codec';

export { builtinRoutes, getBuiltinRoute } from './builtin';
export type { Projection } from './geo';
export { haversineM, project, unproject, utf8ByteLength } from './geo';

export type { MatchPoint, MatchResult } from './match';
export { MATCH_TOLERANCE_M, MIN_MATCH_M, matchTrackToRoute } from './match';

export type {
  BuildingKind,
  DecodeSceneryResult,
  GroundKind,
  PlaceKind,
  SceneryBuilding,
  SceneryModel,
  SceneryPlace,
  SceneryStretch,
  SceneryStructure,
  ScenerySummary,
  StructureKind,
  WaterKind,
} from './scenery';
export {
  BUILDING_KINDS,
  GROUND_KINDS,
  MAX_SCENERY_BUILDINGS,
  MAX_SCENERY_BYTES,
  MAX_SCENERY_PLACES,
  MAX_SCENERY_STRETCHES,
  MAX_STRETCH_M,
  OSM_ATTRIBUTION,
  SCENERY_CORRIDOR_M,
  SCENERY_FORMAT,
  SCENERY_FORMAT_VERSION,
  WATER_KINDS,
  boundScenery,
  decodeScenery,
  emptyScenery,
  encodeScenery,
  forEachBuildingIn,
  forEachStretchIn,
  lowerBound,
  sceneryIsEmpty,
  summarizeScenery,
} from './scenery';

export type {
  Bbox,
  LatLon,
  OsmElement,
  OsmTags,
  OverpassParseResult,
  SceneryChunk,
} from './overpass';
export {
  DEFAULT_OVERPASS_URL,
  OVERPASS_TIMEOUT_S,
  OVERPASS_USER_AGENT,
  coveredSamples,
  overpassBody,
  overpassQuery,
  parseOverpassJson,
  routeXY,
  sceneryChunks,
} from './overpass';

export type { SceneryBuildOptions } from './sceneryBuild';
export {
  BUILDING_MIN_OFFSET_M,
  PROBE_M,
  SceneryBuilder,
  areaKind,
  buildScenery,
  buildingShape,
  parseMetres,
} from './sceneryBuild';

export type {
  CancelSignal,
  FetchSceneryOptions,
  FetchSceneryResult,
  OverpassResponse,
  OverpassTransport,
  SceneryProgress,
} from './sceneryFetch';
export {
  CancelSource,
  CancelledError,
  cancellableSleep,
  fetchScenery,
  isRetryableStatus,
  untilCancelled,
} from './sceneryFetch';

export type { RouteTimes } from './times';
export {
  MAX_ROUTE_TIMES,
  decodeRouteTimes,
  routeTimeAt,
  routeTimesFrom,
  routeTimesSpan,
} from './times';

export type {
  BuildWindResult,
  DecodeWindResult,
  RiderWind,
  WeatherLocation,
  WeatherParseResult,
  WeatherPlanResult,
  WeatherSample,
  WeatherSeries,
  WeatherSummary,
  WeatherWhen,
  WindPoint,
  WindProfile,
} from './weather';
export {
  DEFAULT_WEATHER_ARCHIVE_URL,
  DEFAULT_WEATHER_START,
  ESTIMATED_SPEED_MPS,
  MAX_RIDER_WIND_MPS,
  MAX_WEATHER_BYTES,
  MAX_WEATHER_SAMPLES,
  RIDER_WIND_FACTOR_OPEN,
  RIDER_WIND_FACTOR_SHELTERED,
  SHELTER_NEAR_M,
  WEATHER_ATTRIBUTION,
  WEATHER_FORMAT,
  WEATHER_GRID_DEG,
  WEATHER_HOURLY,
  WEATHER_LICENCE,
  WEATHER_LOCATIONS_PER_REQUEST,
  WEATHER_SPACING_M,
  buildWindProfile,
  compassWord,
  conditionsText,
  decodeWindProfile,
  encodeWindProfile,
  formatWeatherSpan,
  isoDay,
  parseWeatherJson,
  planWeather,
  riderWind,
  riderWindFactor,
  shelterAt,
  summarizeWind,
  wallClockMs,
  weatherAt,
  weatherDayLabel,
  weatherLocations,
  weatherQuery,
  weatherSamples,
  windAt,
  windComponents,
  windConditionsKey,
} from './weather';

export type {
  FetchWeatherOptions,
  FetchWeatherResult,
  WeatherProgress,
  WeatherTransport,
} from './weatherFetch';
export { fetchWeather } from './weatherFetch';
