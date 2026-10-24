import type { CaptureRect } from '../platform/capture';

export function validCaptureRect(r: CaptureRect): boolean {
  return [r.left, r.top, r.width, r.height].every(Number.isFinite) && r.left >= 0 && r.top >= 0 && r.width > 0 && r.height > 0 && r.left + r.width <= 1.001 && r.top + r.height <= 1.001;
}

/** Image and buttons share their transformed container, so zoom never changes alignment. */
export function captureButtonPosition(rects: CaptureRect[]): { left: string; top: string } | undefined {
  const rect = rects.find(validCaptureRect);
  return rect ? { left: `${Math.min(rect.left + rect.width, .82) * 100}%`, top: `${rect.top * 100}%` } : undefined;
}
