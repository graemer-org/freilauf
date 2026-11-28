import { useState } from 'react';
import { GhostHud } from '../GhostUi';
import { PowerUpHud } from '../PowerUpHud';
import { useRouteTrack } from '../routesApi';
import { WindHud } from '../WeatherUi';
import { RoadScene } from './RoadScene';
import { SideScene } from './RideScene';

export type SceneViewMode = 'road' | 'side';

const VIEW_KEY = 'freilauf.sceneView';

function readView(): SceneViewMode {
  try {
    return globalThis.localStorage?.getItem(VIEW_KEY) === 'side' ? 'side' : 'road';
  } catch {
    return 'road';
  }
}

function writeView(v: SceneViewMode): void {
  try {
    globalThis.localStorage?.setItem(VIEW_KEY, v);
  } catch {
    /* a remembered view is a convenience only */
  }
}

/**
 * The ride scene: with a route loaded, the road seen from behind the rider
 * (it bends and climbs with the route); without one, the side-on scene,
 * which shows the manual gradient best. On a route a small switch offers the
 * side view too (without its "ahead unknown" strip: the route card shows
 * the whole profile); the choice is remembered on this computer.
 */
export function RideScene() {
  const track = useRouteTrack();
  const [mode, setMode] = useState<SceneViewMode>(readView);
  if (!track) return <SideScene toolbar={<PowerUpHud />} />;
  const choose = (v: SceneViewMode): void => {
    setMode(v);
    writeView(v);
  };
  const toolbar = (
    <>
      <WindHud />
      <div className="scene-switch" role="group" aria-label="Scene view">
        <button
          type="button"
          className="scene-switch-btn"
          aria-pressed={mode === 'road'}
          data-testid="scene-view-road"
          onClick={() => choose('road')}
        >
          Road
        </button>
        <button
          type="button"
          className="scene-switch-btn"
          aria-pressed={mode === 'side'}
          data-testid="scene-view-side"
          onClick={() => choose('side')}
        >
          Side
        </button>
      </div>
      <PowerUpHud />
      <GhostHud />
    </>
  );
  return mode === 'road' ? (
    <RoadScene key={track.id} track={track} toolbar={toolbar} />
  ) : (
    <SideScene toolbar={toolbar} profile={false} />
  );
}
