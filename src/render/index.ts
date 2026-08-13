/**
 * Public surface of the map renderer.
 *
 * The UI only ever needs `MapRenderer`, `RenderView` and `Viewport`; everything
 * else is exported for tooling, tests and one-off overlays.
 */

export { MapRenderer, type RenderView, type Viewport } from './renderer.js';
export { Camera, HEX_SIZE, MAX_HEX_PX, MIN_HEX_PX, type WorldRect } from './camera.js';
export { Starfield } from './starfield.js';
export {
  LOD,
  SIZES,
  THEME,
  darken,
  inkOn,
  lighten,
  luminance,
  mix,
  parseColor,
  rgba,
  type RGB,
} from './theme.js';
export { drawClassGlyph, drawOrdnanceMarker, drawShipCounter } from './counters.js';
export { drawAccelMark, drawCourseArrow, drawPredictedCourse, drawTrail } from './courses.js';
export { drawBodies, drawBodyLabels, drawBases, drawOrbitRings } from './bodies.js';
export type { Frame } from './draw.js';
