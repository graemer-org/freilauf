/**
 * "Share with my watch": the Devices screen section and the small badge on the
 * start screen and in the ride toolbar. The relay itself runs in the main
 * process (main/sensorRelayController.ts); this only shows its status and
 * edits Settings.watchRelay.
 */
import type { RelayServiceKind } from '@freilauf/devices';
import { DEFAULT_WATCH_RELAY } from '../../../shared/contract';
import { useApp, useAppState } from './hooks';
import {
  WATCH_RELAY_KINDS,
  WATCH_RELAY_KIND_HINT,
  WATCH_RELAY_KIND_LABEL,
  describeWatchRelay,
  watchRelayBadge,
} from './watchRelayView';

export function WatchRelaySection() {
  const app = useApp();
  const status = useAppState((s) => s.watchRelay ?? { state: 'off' as const });
  const settings = useAppState((s) => s.settings?.watchRelay ?? DEFAULT_WATCH_RELAY);
  const unavailable = status.state === 'unavailable';
  const { text, tone } = describeWatchRelay(status);
  const setShare = (kind: RelayServiceKind, on: boolean) =>
    void app.updateSettings({ watchRelay: { share: { [kind]: on } } });

  return (
    <section
      className="settings-section watch-relay"
      aria-labelledby="dev-watch-relay"
      data-testid="watch-relay"
    >
      <h2 id="dev-watch-relay" className="section-title section-head">
        Share with my watch
      </h2>
      <p className="hint watch-relay-intro">
        Freilauf can pass the live values on over Bluetooth, as if this computer were a sensor, so a
        sports watch can record the indoor ride too.
      </p>
      <label className="check-row watch-relay-switch">
        <input
          type="checkbox"
          role="switch"
          data-testid="watch-relay-enabled"
          disabled={unavailable}
          checked={settings.enabled && !unavailable}
          onChange={(e) =>
            void app.updateSettings({ watchRelay: { enabled: e.currentTarget.checked } })
          }
        />{' '}
        Share live values with a watch
      </label>
      <p
        className={`watch-relay-status chip chip-${tone}`}
        role="status"
        data-testid="watch-relay-status"
        data-state={status.state}
      >
        <span className="status-mark" aria-hidden="true" />
        <span className="chip-text">{text}</span>
      </p>
      {!unavailable && (
        <fieldset className="watch-relay-kinds">
          <legend>What to share</legend>
          {WATCH_RELAY_KINDS.map((kind) => (
            <label key={kind} className="check-row">
              <input
                type="checkbox"
                data-testid={`watch-relay-share-${kind}`}
                checked={settings.share[kind]}
                onChange={(e) => setShare(kind, e.currentTarget.checked)}
              />{' '}
              <span>
                {WATCH_RELAY_KIND_LABEL[kind]}
                <span className="hint watch-relay-kind-hint">{WATCH_RELAY_KIND_HINT[kind]}</span>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {!unavailable && (
        <details className="disclosure watch-relay-howto" data-testid="watch-relay-howto">
          <summary>How to pair a watch</summary>
          <ol className="hint">
            <li>Switch sharing on above and wait for “Waiting for a watch”.</li>
            <li>
              On the watch, search for new sensors. This computer shows up under its Bluetooth name
              (on Windows: Settings → Bluetooth &amp; devices → Devices → “Device name”), once per
              kind: as a heart-rate sensor, a power meter and a bike speed/cadence sensor.
            </li>
            <li>Pair each one you want, then start the watch’s indoor cycling exercise.</li>
            <li>
              Keep Freilauf open while riding. Pairing stays; next time the watch finds the computer
              again once sharing is on.
            </li>
          </ol>
          <p className="hint">
            Suunto Race 2 (not yet tried with this feature): look for this computer’s name in the
            watch’s sensor settings (on Suunto watches usually Settings → Connectivity → Pair
            devices), and pair before starting an indoor cycling exercise.
          </p>
          <p className="hint">
            Receiving from your trainer and sending to the watch at the same time depends on the
            Bluetooth adapter. If values stutter, a second USB Bluetooth adapter can help. Some
            watches use only one sensor of each type. Details: docs/watch-relay.md.
          </p>
        </details>
      )}
    </section>
  );
}

/** Small "Watch: …" badge for the start-screen device line and the ride toolbar. */
export function WatchRelayBadge() {
  const status = useAppState((s) => s.watchRelay ?? { state: 'off' as const });
  const enabled = useAppState((s) => s.settings?.watchRelay?.enabled ?? false);
  const badge = watchRelayBadge(status, enabled);
  if (!badge) return null;
  return (
    <span
      className={`chip chip-${badge.tone} watch-relay-badge`}
      data-testid="watch-relay-badge"
      data-state={status.state}
      title={describeWatchRelay(status).text}
    >
      <span className="status-mark" aria-hidden="true" />
      <span className="chip-text">{badge.text}</span>
    </span>
  );
}
