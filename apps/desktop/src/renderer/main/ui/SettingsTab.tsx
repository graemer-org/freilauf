import type { ControllerButton } from '@freilauf/devices';
import { useId } from 'react';
import { CONTROLLER_ACTION_LABELS } from '../../../shared/contract';
import type { OverlayTile, Settings, ShiftAction, StatId } from '../../../shared/contract';
import { ALL_STATS } from '../../../shared/contract';
import { NumberField, RangeField, TextField, Toggle } from './fields';
import { statLabel } from './format';
import { useApp, useAppState } from './hooks';

export const MAX_NAME_LENGTH = 24;
const MAX_TILES = 12;

const SHIFT_BUTTONS: readonly { button: ControllerButton; label: string }[] = [
  { button: 'shiftUpRight', label: 'Right shift button, upper' },
  { button: 'shiftDownRight', label: 'Right shift button, lower' },
  { button: 'shiftUpLeft', label: 'Left shift button, upper' },
  { button: 'shiftDownLeft', label: 'Left shift button, lower' },
];

const OTHER_BUTTONS: readonly { button: ControllerButton; label: string }[] = [
  { button: 'up', label: 'Up' },
  { button: 'down', label: 'Down' },
  { button: 'left', label: 'Left' },
  { button: 'right', label: 'Right' },
  { button: 'a', label: 'A' },
  { button: 'b', label: 'B' },
  { button: 'y', label: 'Y' },
  { button: 'z', label: 'Z' },
  { button: 'powerUpLeft', label: 'Left power-up' },
  { button: 'powerUpRight', label: 'Right power-up' },
];

const ACTION_LABEL = CONTROLLER_ACTION_LABELS;

const SIZE_LABEL: Record<OverlayTile['size'], string> = { s: 'Small', m: 'Medium', l: 'Large' };

const nonEmpty =
  (max: number) =>
  (text: string): string | undefined => {
    const t = text.trim();
    return t.length > 0 && t.length <= max ? t : undefined;
  };

const validUrl = (text: string): string | undefined => {
  const t = text.trim();
  return t.length <= 500 && /^wss?:\/\/[^\s]+$/i.test(t) ? t : undefined;
};

function ButtonMapRow({
  button,
  label,
  action,
  onChange,
}: {
  button: ControllerButton;
  label: string;
  action: ShiftAction;
  onChange: (button: ControllerButton, action: ShiftAction) => void;
}) {
  const id = useId();
  return (
    <tr>
      <th scope="row">
        <label htmlFor={id}>{label}</label>
      </th>
      <td>
        <select
          id={id}
          data-testid={`button-map-${button}`}
          value={action}
          onChange={(e) => onChange(button, e.currentTarget.value as ShiftAction)}
        >
          {(Object.keys(ACTION_LABEL) as ShiftAction[]).map((a) => (
            <option key={a} value={a}>
              {ACTION_LABEL[a]}
            </option>
          ))}
        </select>
      </td>
    </tr>
  );
}

function ButtonMapping({ buttons }: { buttons: Settings['shifting']['buttons'] }) {
  const app = useApp();
  const onChange = (button: ControllerButton, action: ShiftAction): void => {
    void app.updateSettings({ shifting: { buttons: { [button]: action } } });
  };
  return (
    <>
      <h3 className="subhead">Controller buttons</h3>
      <div className="card">
        <table className="map-table">
          <tbody>
            {SHIFT_BUTTONS.map(({ button, label }) => (
              <ButtonMapRow
                key={button}
                button={button}
                label={label}
                action={buttons[button] ?? 'none'}
                onChange={onChange}
              />
            ))}
          </tbody>
        </table>
        <details className="disclosure">
          <summary>More buttons</summary>
          <table className="map-table">
            <tbody>
              {OTHER_BUTTONS.map(({ button, label }) => (
                <ButtonMapRow
                  key={button}
                  button={button}
                  label={label}
                  action={buttons[button] ?? 'none'}
                  onChange={onChange}
                />
              ))}
            </tbody>
          </table>
        </details>
      </div>
      <p className="hint section-foot">
        Smart frame controller support is experimental; if a button shifts the wrong way, change it
        here. Keyboard shifting always works.
      </p>
    </>
  );
}

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

function TileEditor({ tiles }: { tiles: OverlayTile[] }) {
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
  const editMode = useAppState((s) => s.overlayEditMode);
  if (!settings) return null;
  const { rider, shifting, overlay, group } = settings;
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
        </div>
      </section>

      <section className="settings-section" aria-labelledby="set-shifting">
        <h2 id="set-shifting" className="section-title section-head">
          Shifting
        </h2>
        <div className="card rows">
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
        <ButtonMapping buttons={shifting.buttons} />
      </section>

      <section className="settings-section" aria-labelledby="set-overlay">
        <h2 id="set-overlay" className="section-title section-head">
          Overlay
        </h2>
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
                Drag and resize the overlay while this is on. Hotkey:{' '}
                <kbd>{overlay.editHotkey}</kbd>
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
      </section>

      <section className="settings-section" aria-labelledby="set-group">
        <h2 id="set-group" className="section-title section-head">
          Group
        </h2>
        <div className="card rows">
          <TextField
            label="Signalling server URL"
            testId="settings-signalling"
            value={group.signallingUrl}
            maxLength={500}
            validate={validUrl}
            errorText="Enter a ws:// or wss:// URL."
            hint="All riders in a group must use the same server and be able to reach it."
            placeholder="wss://example.org"
            onCommit={(signallingUrl) => update({ group: { signallingUrl } })}
          />
        </div>
      </section>
    </div>
  );
}
