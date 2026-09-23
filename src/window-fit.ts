export type WindowSize = { width: number; height: number };
export type WindowPosition = { x: number; y: number };

const WINDOW_MARGIN = 32;
const MIN_WINDOW_WIDTH = 320;
const MIN_WINDOW_HEIGHT = 240;

function fitDimension(current: number, available: number, minimum: number) {
  // Tauri enforces the same minimum natively, so never request a smaller size.
  const maximum = Math.max(minimum, available - WINDOW_MARGIN);
  return Math.min(Math.max(current, Math.min(minimum, maximum)), maximum);
}

export function fitWindowSizeToWorkArea(current: WindowSize, workArea: WindowSize): WindowSize {
  return {
    width: fitDimension(current.width, workArea.width, MIN_WINDOW_WIDTH),
    height: fitDimension(current.height, workArea.height, MIN_WINDOW_HEIGHT),
  };
}

export function fitWindowPositionToWorkArea(
  current: WindowPosition,
  size: WindowSize,
  workArea: { position: WindowPosition; size: WindowSize },
): WindowPosition {
  const minX = workArea.position.x;
  const minY = workArea.position.y;
  const maxX = Math.max(minX, minX + workArea.size.width - size.width);
  const maxY = Math.max(minY, minY + workArea.size.height - size.height);
  return {
    x: Math.min(Math.max(current.x, minX), maxX),
    y: Math.min(Math.max(current.y, minY), maxY),
  };
}
