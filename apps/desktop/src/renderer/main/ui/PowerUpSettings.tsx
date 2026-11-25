import { Toggle } from './fields';
import { useApp, useAppState } from './hooks';

/** Settings → Power-ups: on/off and effort challenges on/off (docs/power-ups.md). */
export function PowerUpSettings() {
  const app = useApp();
  const powerUps = useAppState((s) => s.settings?.powerUps ?? null);
  if (!powerUps) return null;
  return (
    <section
      className="settings-section"
      aria-labelledby="set-powerups"
      data-testid="settings-powerups"
    >
      <h2 id="set-powerups" className="section-title section-head">
        Power-ups
      </h2>
      <div className="card rows">
        <Toggle
          label="Power-ups"
          testId="settings-powerups-enabled"
          checked={powerUps.enabled}
          hint="Collect them on the road and use them with the side button or P. Not in ERG steps or FTP tests."
          onChange={(enabled) => void app.updateSettings({ powerUps: { enabled } })}
        />
        <Toggle
          label="Effort challenges"
          testId="settings-powerups-challenges"
          checked={powerUps.challenges}
          hint="When your power has dropped for a few minutes, a short hold is offered once in a while. Meet it for a power-up, or just ignore it."
          onChange={(challenges) => void app.updateSettings({ powerUps: { challenges } })}
        />
      </div>
      <p className="hint section-foot">
        Power-ups only move your race position — where you are placed among other riders. Your
        recorded speed and distance, the .fit file, points, personal bests and challenges always
        come from your own power.
      </p>
    </section>
  );
}

/** In a group ride: the host's switch for everyone; guests see what the host chose. */
export function GroupPowerUps({ role }: { role: 'host' | 'guest' }) {
  const app = useApp();
  const on = useAppState((s) => s.groupPowerUps !== false);
  const offByHost = useAppState((s) => s.live?.powerUps?.blocked === 'group');
  const enabled = useAppState((s) => s.settings?.powerUps?.enabled !== false);
  if (role === 'host') {
    return (
      <div className="rows group-powerups" data-testid="group-powerups">
        <Toggle
          label="Power-ups in this ride"
          testId="group-powerups-toggle"
          checked={on}
          hint={
            enabled
              ? 'For everyone in the group. Places include power-up gains; recorded rides never do.'
              : 'For everyone in the group. Yours are off in Settings.'
          }
          onChange={(next) => app.setGroupPowerUps(next)}
        />
      </div>
    );
  }
  return (
    <p className="hint group-powerups" data-testid="group-powerups" data-on={!offByHost}>
      {offByHost
        ? 'The host has switched power-ups off for this ride.'
        : 'Power-ups are allowed in this ride; places include their gains.'}
    </p>
  );
}
