/**
 * IPC channel names shared by the main process and the preload script.
 * Renderers never see these: they only talk to `window.freilauf`.
 */
export const IPC = {
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  settingsForgetDevice: 'settings:forget-device',
  /** main → both windows */
  settingsChanged: 'settings:changed',

  livePublish: 'live:publish',
  liveGet: 'live:get',
  /** main → overlay */
  liveState: 'live:state',

  overlaySetEditMode: 'overlay:set-edit-mode',
  overlayGetEditMode: 'overlay:get-edit-mode',
  /** main → both windows */
  overlayEditMode: 'overlay:edit-mode',
  overlaySetBounds: 'overlay:set-bounds',
  overlayGetBounds: 'overlay:get-bounds',

  btGrantUserGesture: 'bt:grant-user-gesture',
  btPrepareChooser: 'bt:prepare-chooser',
  /** main → main window */
  btPickerDevices: 'bt:picker-devices',
  btPick: 'bt:pick',
  btCancelPicker: 'bt:cancel-picker',

  ridesList: 'rides:list',
  ridesSave: 'rides:save',
  ridesExportFit: 'rides:export-fit',
  ridesDelete: 'rides:delete',
  ridesOpenFolder: 'rides:open-folder',

  diagBleLog: 'diag:ble-log',
  diagLogFilePath: 'diag:log-file-path',
  /** renderer → main: a batch of log entries */
  diagLog: 'diag:log',
  diagLogInfo: 'diag:log-info',
  diagOpenLogFolder: 'diag:open-log-folder',
  diagExportLog: 'diag:export-log',
  diagReadRecent: 'diag:read-recent',
} as const;

/** Command-line switches main passes to each renderer via `additionalArguments`. */
export const ARG = {
  window: '--freilauf-window=',
  sim: '--freilauf-sim=',
  bleLog: '--freilauf-ble-log=',
} as const;
