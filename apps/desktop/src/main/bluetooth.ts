/**
 * Electron side of Web Bluetooth: answers the main window's device chooser
 * (state machine in bluetoothChooser.ts) and Windows/Linux pairing prompts.
 */
import type { BrowserWindow, Session } from 'electron';
import { webContents as WebContentsStatic } from 'electron';
import type { PickerDevice } from '../shared/contract';
import { IPC } from '../shared/ipc';
import { BluetoothChooser } from './bluetoothChooser';

export function attachBluetoothChooser(
  win: BrowserWindow,
  log: (m: string) => void,
): BluetoothChooser {
  const wc = win.webContents;
  const chooser = new BluetoothChooser({
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    onPickerDevices: (devices: PickerDevice[]) => {
      if (!wc.isDestroyed()) wc.send(IPC.btPickerDevices, devices);
    },
    log,
  });

  // Only this webContents has a listener, so only the main window can obtain
  // a device (Electron cancels requests from webContents without one).
  wc.on('select-bluetooth-device', (event, devices, callback) => {
    // Without preventDefault Electron picks the first device on its own.
    event.preventDefault();
    chooser.handleSelect(devices, callback);
  });

  // A reload/navigation or a crash abandons the request: answer it so the
  // callback is always called once (Chromium ignores a late answer).
  wc.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument)
      chooser.dispose('page navigated or reloaded');
  });
  wc.on('render-process-gone', () => chooser.dispose('renderer process gone'));
  wc.on('destroyed', () => chooser.dispose('window destroyed'));
  return chooser;
}

/**
 * Windows and Linux ask the app to confirm pairing for devices that need it
 * (macOS handles pairing itself). Trainers, HR straps and controllers use
 * "just works" pairing, which we confirm. PIN pairing would need UI we do not
 * have; those devices must be paired in the OS Bluetooth settings first.
 */
export function installPairingHandler(
  ses: Session,
  mainWindow: () => BrowserWindow | null,
  log: (m: string) => void,
): void {
  if (process.platform !== 'win32' && process.platform !== 'linux') return;
  ses.setBluetoothPairingHandler((details, callback) => {
    const win = mainWindow();
    const from = details.frame ? WebContentsStatic.fromFrame(details.frame) : undefined;
    log(`pairing prompt for ${details.deviceId}: kind ${details.pairingKind}`);
    if (!win || win.isDestroyed() || from !== win.webContents) {
      log(`pairing request for ${details.deviceId} from an unknown frame: rejected`);
      callback({ confirmed: false });
      return;
    }
    if (details.pairingKind === 'confirm') {
      log(`pairing ${details.deviceId}: "just works" pairing confirmed`);
      callback({ confirmed: true });
      return;
    }
    log(
      `pairing ${details.deviceId}: device requested ${details.pairingKind} (PIN) pairing, which Freilauf does not support. ` +
        'Pair the device in the operating system Bluetooth settings first, then connect again.',
    );
    callback({ confirmed: false });
  });
}
