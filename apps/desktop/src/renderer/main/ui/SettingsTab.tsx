import { useId } from 'react';
import type { OverlayTile, StatId } from '../../../shared/contract';
import {
  ALL_STATS,
  DEFAULT_OVERPASS_URL,
  DEFAULT_WEATHER_ARCHIVE_URL,
} from '../../../shared/contract';
import { isOverpassUrl, isWeatherArchiveUrl } from '../../../main/settings';
import { RiderEnergyFields } from './EnergyUi';
import { NumberField, RangeField, TextField, Toggle } from './fields';
import { PowerUpSettings } from './PowerUpSettings';
import { RideSettings } from './RideSettings';
import { statLabel } from './format';
import { useApp, useAppState } from './hooks';
import { routeDifficultyOf, setRouteDifficulty } from './routesApi';
import { DiagnosticsCard } from './SettingsExtras';

export const MAX_NAME_LENGTH = 24;
const MAX_TILES = 12;

const SIZE_LABEL: Record<OverlayTile['size'], string> = { s: 'Small', m: 'Medium', l: 'Large' };

const nonEmpty =
  (max: number) =>
  (text: string): string | undefined => {
    const t = text.trim();
    return t.length > 0 && t.length <= max ? t : undefined;
  };

/** A ws(s):// address, or nothing (= no own server set up). */
const validUrl = (text: string): string | undefined => {
  const t = text.trim();
  if (t === '') return '';
  return t.length <= 500 && /^wss?:\/\/[^\s]+$/i.test(t) ? t : undefined;
};

/** Relay addresses separated by spaces, commas or new lines. */
function relayList(text: string): string[] {
  return text.split(/[\s,]+/).filter((u) => u !== '');
}

/** Normalised list text, or undefined when an entry is not a ws(s):// address. */
const validRelayList = (text: string): string | undefined => {
  const urls = relayList(text);
  if (urls.length > 16) return undefined;
  return urls.every((u) => u.length <= 300 && /^wss?:\/\/[^\s/?#]+/i.test(u))
    ? urls.join(' ')
    : undefined;
};

function TileRow({
  tile,
  index,
  count,
  onChange,
}: {
  tile: OverlayTile;
  index: number;
  count: number;
  onChange: (
    op: { kind: 'set'; tile: OverlayTile } | { kind: 'move'; by: -1 | 1 } | { kind: 'remove' },
  ) => void;
}) {
  const statId = useId();
  const sizeId = useId();
  const n = index + 1;
  return (
    <li className="tile-editor-row" data-testid="overlay-tile">
      <span className="tile-index">{n}</span>
      <label className="visually-hidden" htmlFor={statId}>
        Tile {n} value
      </label>
      <select
        id={statId}
        value={tile.stat}
        onChange={(e) =>
          onChange({ kind: 'set', tile: { ...tile, stat: e.currentTarget.value as StatId } })
        }
      >
        {ALL_STATS.map((s) => (
          <option key={s} value={s}>
            {statLabel(s)}
          </option>
        ))}
      </select>
      <label className="visually-hidden" htmlFor={sizeId}>
        Tile {n} size
      </label>
      <select
        id={sizeId}
        value={tile.size}
        onChange={(e) =>
          onChange({
            kind: 'set',
            tile: { ...tile, size: e.currentTarget.value as OverlayTile['size'] },
          })
        }
      >
        {(Object.keys(SIZE_LABEL) as OverlayTile['size'][]).map((s) => (
          <option key={s} value={s}>
            {SIZE_LABEL[s]}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="btn btn-small btn-icon"
        aria-label={`Move tile ${n} up`}
        disabled={index === 0}
        onClick={() => onChange({ kind: 'move', by: -1 })}
      >
        ↑
      </button>
      <button
        type="button"
        className="btn btn-small btn-icon"
        aria-label={`Move tile ${n} down`}
        disabled={index === count - 1}
        onClick={() => onChange({ kind: 'move', by: 1 })}
      >
        ↓
      </button>
      <button
        type="button"
        className="btn btn-small btn-danger"
        aria-label={`Remove tile ${n}`}
        onClick={() => onChange({ kind: 'remove' })}
      >
        Remove
      </button>
    </li>
  );
}

export function TileEditor({ tiles }: { tiles: OverlayTile[] }) {
  const app = useApp();
  const save = (next: OverlayTile[]): void => {
    void app.updateSettings({ overlay: { tiles: next } });
  };
  const addTile = (): void => {
    const used = new Set(tiles.map((t) => t.stat));
    const stat = ALL_STATS.find((s) => !used.has(s)) ?? 'power';
    save([...tiles, { stat, size: 'm' }]);
  };
  return (
    <>
      <h3 className="subhead">Overlay tiles</h3>
      <div className="card">
        {tiles.length === 0 ? (
          <p className="hint tile-editor-row">
            No tiles — the overlay shows only the group, if enabled.
          </p>
        ) : (
          <ol className="list tile-editor">
            {tiles.map((tile, i) => (
              <TileRow
                // Tiles have no id; position is their identity in this list.
                key={i}
                tile={tile}
                index={i}
                count={tiles.length}
                onChange={(op) => {
                  const next = [...tiles];
                  if (op.kind === 'set') next[i] = op.tile;
                  else if (op.kind === 'remove') next.splice(i, 1);
                  else {
                    const j = i + op.by;
                    const a = next[i];
                    const b = next[j];
                    if (!a || !b) return;
                    next[i] = b;
                    next[j] = a;
                  }
                  save(next);
                }}
              />
            ))}
          </ol>
        )}
        <div className="tile-editor-foot">
          <button
            type="button"
            className="btn btn-small btn-quiet"
            data-testid="overlay-add-tile"
            disabled={tiles.length >= MAX_TILES}
            onClick={addTile}
          >
            + Add tile
          </button>
        </div>
      </div>
    </>
  );
}

export function SettingsTab({ onOpenFtpTests }: { onOpenFtpTests?: () => void }) {
  const app = useApp();
  const settings = useAppState((s) => s.settings);
  if (!settings) return null;
  const { rider, shifting, group } = settings;
  const update = (patch: Parameters<typeof app.updateSettings>[0]): void => {
    void app.updateSettings(patch);
  };

  return (
    <div className="page settings">
      <section className="settings-section" aria-labelledby="set-rider">
        <h2 id="set-rider" className="section-title section-head">
          Rider
        </h2>
        <div className="card rows">
          <TextField
            label="Name"
            testId="settings-name"
            value={rider.name}
            maxLength={MAX_NAME_LENGTH}
            validate={nonEmpty(MAX_NAME_LENGTH)}
            errorText={`Enter 1 to ${MAX_NAME_LENGTH} characters.`}
            hint="Shown to other riders in a group ride."
            onCommit={(name) => update({ rider: { name } })}
          />
          <NumberField
            label="Rider mass"
            unit="kg"
            testId="settings-rider-mass"
            value={rider.massKg}
            min={20}
            max={300}
            step={0.5}
            onCommit={(v) => v !== null && update({ rider: { massKg: v } })}
          />
          <NumberField
            label="Bike mass"
            unit="kg"
            testId="settings-bike-mass"
            value={rider.bikeMassKg}
            min={0}
            max={60}
            step={0.5}
            onCommit={(v) => v !== null && update({ rider: { bikeMassKg: v } })}
          />
          <NumberField
            label="FTP"
            unit="W"
            testId="settings-ftp"
            value={rider.ftpW}
            min={50}
            max={600}
            step={1}
            hint={
              <>
                Functional threshold power: roughly the power you can hold for an hour. Workout
                targets are scaled to it.
                {onOpenFtpTests && (
                  <>
                    {' '}
                    <button type="button" className="link" onClick={onOpenFtpTests}>
                      Measure it with an FTP test
                    </button>
                  </>
                )}
              </>
            }
            onCommit={(v) => v !== null && update({ rider: { ftpW: Math.round(v) } })}
          />
          <RiderEnergyFields rider={rider} />
        </div>
      </section>

      <RideSettings />

      <section className="settings-section" aria-labelledby="set-overlay">
        <h2 id="set-overlay" className="section-title section-head">
          Overlay
        </h2>
        <OverlaySettings />
      </section>

      <section className="settings-section" aria-labelledby="set-group">
        <h2 id="set-group" className="section-title section-head">
          Group
        </h2>
        <div className="card rows">
          <p className="hint settings-note">
            Group rides need no setup: riders find each other through public relay servers run by
            others, which only pass on an encrypted handshake. The options below are for special
            cases.
          </p>
        </div>
        <details
          className="card disclosure settings-advanced"
          data-testid="settings-group-advanced"
          open={group.useOwnServer || group.relayUrls.length > 0}
        >
          <summary>Advanced: own signalling server and relays</summary>
          <div className="rows">
            <Toggle
              label="Use my own signalling server"
              testId="settings-own-server"
              checked={group.useOwnServer}
              hint="Rides you create go through your own server instead of the public relays. Old-style invite links with a server address work either way."
              onChange={(useOwnServer) => update({ group: { useOwnServer } })}
            />
            <TextField
              label="Own signalling server URL"
              testId="settings-signalling"
              value={group.signallingUrl}
              maxLength={500}
              validate={validUrl}
              errorText="Enter a ws:// or wss:// address, or leave it empty."
              hint="Only used with the option above. Friends who join with your invite link use it automatically."
              placeholder="wss://your-server.example/signal"
              onCommit={(signallingUrl) => update({ group: { signallingUrl } })}
            />
            <TextField
              label="Relay servers (advanced)"
              testId="settings-relays"
              value={group.relayUrls.join(' ')}
              maxLength={4000}
              validate={validRelayList}
              errorText="Enter wss:// addresses separated by spaces, or leave it empty for the built-in ones."
              hint="Empty = the built-in public relays. Everyone in a ride needs at least one relay in common, so only change this together with your friends."
              placeholder="wss://relay.example.org wss://relay2.example.org"
              onCommit={(text) => update({ group: { relayUrls: relayList(text) } })}
            />
          </div>
        </details>
      </section>

      <RouteSettings />

      <PowerUpSettings />

      <section className="settings-section" aria-labelledby="set-diagnostics">
        <h2 id="set-diagnostics" className="section-title section-head">
          Diagnostics
        </h2>
        <DiagnosticsCard />
      </section>

      <section className="settings-section" aria-labelledby="set-advanced">
        <h2 id="set-advanced" className="section-title section-head">
          Advanced
        </h2>
        <details className="card disclosure settings-advanced" data-testid="settings-advanced">
          <summary>Trainer and shifting details</summary>
          <div className="rows">
            <NumberField
              label="Physical gear ratio"
              testId="settings-ratio"
              value={shifting.physicalRatio}
              min={0.1}
              max={20}
              step={0.01}
              hint="Chainring teeth ÷ cog teeth of the gear the bike is actually in, e.g. 34 ÷ 14 ≈ 2.43."
              onCommit={(v) => v !== null && update({ shifting: { physicalRatio: v } })}
            />
            <NumberField
              label="Trainer assumed mass"
              unit="kg"
              testId="settings-trainer-mass"
              value={shifting.trainerMassKg}
              min={1}
              max={500}
              step={0.5}
              allowEmpty
              placeholder={`${rider.massKg + rider.bikeMassKg} (rider + bike)`}
              hint="Leave empty if the trainer uses your rider + bike mass."
              onCommit={(v) => update({ shifting: { trainerMassKg: v } })}
            />
          </div>
        </details>
        <p className="hint section-foot">
          Rarely needed. Controller buttons and levers are set up on the Devices screen.
        </p>
      </section>
    </div>
  );
}

/** Overlay options; also offered in the ride view's Overlay panel, next to the overlay itself. */
export function OverlaySettings() {
  const app = useApp();
  const overlay = useAppState((s) => s.settings?.overlay ?? null);
  const editMode = useAppState((s) => s.overlayEditMode);
  if (!overlay) return null;
  const update = (patch: Parameters<typeof app.updateSettings>[0]): void => {
    void app.updateSettings(patch);
  };
  return (
    <>
      <div className="card rows">
        <Toggle
          label="Show overlay"
          testId="settings-overlay-visible"
          checked={overlay.visible}
          onChange={(visible) => update({ overlay: { visible } })}
        />
        <Toggle
          label="Edit overlay position"
          testId="settings-overlay-edit"
          checked={editMode}
          hint={
            <>
              Drag and resize the overlay while this is on. Hotkey: <kbd>{overlay.editHotkey}</kbd>
            </>
          }
          onChange={(edit) => app.setOverlayEditMode(edit)}
        />
        <Toggle
          label="Show group riders on the overlay"
          checked={overlay.showGroup}
          onChange={(showGroup) => update({ overlay: { showGroup } })}
        />
        <RangeField
          label="Backdrop opacity"
          value={overlay.backdropOpacity}
          min={0}
          max={1}
          step={0.05}
          format={(v) => `${Math.round(v * 100)} %`}
          onCommit={(backdropOpacity) => update({ overlay: { backdropOpacity } })}
        />
        <TextField
          label="Edit hotkey"
          value={overlay.editHotkey}
          maxLength={100}
          validate={nonEmpty(100)}
          errorText="Enter a shortcut such as CommandOrControl+Shift+O."
          hint="Format: modifiers and a key joined by +, e.g. CommandOrControl+Shift+O."
          onCommit={(editHotkey) => update({ overlay: { editHotkey } })}
        />
      </div>
      <TileEditor tiles={overlay.tiles} />
    </>
  );
}

/** Surroundings from OpenStreetMap along routes (docs/routes.md). */
function ScenerySettings() {
  const app = useApp();
  const scenery = useAppState((s) => s.settings?.scenery ?? null);
  if (!scenery) return null;
  return (
    <>
      <Toggle
        label="Show surroundings"
        testId="settings-scenery-enabled"
        checked={scenery.enabled}
        hint="Draw the buildings, woods, fields and water stored with a route in the ride scene. Loading them is a choice per route, in the route library."
        onChange={(enabled) => void app.updateSettings({ scenery: { enabled } })}
      />
      <TextField
        label="Map server for surroundings"
        testId="settings-scenery-server"
        value={scenery.overpassUrl}
        maxLength={300}
        validate={(t) => {
          const v = t.trim();
          if (v === '') return DEFAULT_OVERPASS_URL;
          return isOverpassUrl(v) ? v : undefined;
        }}
        errorText="Enter an https:// address (or http://localhost for a server on this computer)."
        hint={`An Overpass API address; empty = the public server (${DEFAULT_OVERPASS_URL}). Data © OpenStreetMap contributors.`}
        onCommit={(overpassUrl) => void app.updateSettings({ scenery: { overpassUrl } })}
      />
    </>
  );
}

/** The weather of a day along routes (docs/routes.md): where it is loaded from. */
function WeatherSettings() {
  const app = useApp();
  const weather = useAppState((s) => s.settings?.weather ?? null);
  if (!weather) return null;
  return (
    <TextField
      label="Weather server for the weather of a day"
      testId="settings-weather-server"
      value={weather.archiveUrl}
      maxLength={300}
      validate={(t) => {
        const v = t.trim();
        if (v === '') return DEFAULT_WEATHER_ARCHIVE_URL;
        return isWeatherArchiveUrl(v) ? v : undefined;
      }}
      errorText="Enter an https:// address (or http://localhost for a server on this computer)."
      hint={`A historical weather archive (same request format as the default); empty = the public archive (${DEFAULT_WEATHER_ARCHIVE_URL}). Weather data by Open-Meteo.com (CC BY 4.0).`}
      onCommit={(archiveUrl) => void app.updateSettings({ weather: { archiveUrl } })}
    />
  );
}

/** Route difficulty; shown only when the settings carry it. */
function RouteSettings() {
  const app = useApp();
  const difficulty = useAppState(routeDifficultyOf);
  if (difficulty === null) return null;
  return (
    <section
      className="settings-section"
      aria-labelledby="set-routes"
      data-testid="settings-routes"
    >
      <h2 id="set-routes" className="section-title section-head">
        Routes
      </h2>
      <div className="card rows">
        <RangeField
          label="Climb difficulty"
          testId="settings-route-difficulty"
          value={difficulty}
          min={0}
          max={100}
          step={5}
          format={(v) => `${Math.round(v)} %`}
          onCommit={(v) => setRouteDifficulty(app, v)}
        />
        <ScenerySettings />
        <WeatherSettings />
      </div>
      <p className="hint section-foot">
        How much of each route gradient the trainer makes you feel. 100 % is the real road; at 50 %
        an 8 % climb feels like 4 %. Speed, distance and the recording always use the real gradient.
        A day’s wind is scaled the same way for the trainer.
      </p>
    </section>
  );
}
