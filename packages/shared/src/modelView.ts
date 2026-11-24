import type { PreviewAnnotationVector } from "@t3tools/contracts";

/**
 * A 3D preview's camera position and orbit target, in the file's own coordinates. File links carry
 * one as `model.stl#view=x,y,z,tx,ty,tz`, the format StiensWout's annotatable 3D previews introduced
 * (pingdotgg/t3code fork commit d04d876).
 */
export interface ModelView {
  readonly position: PreviewAnnotationVector;
  readonly target: PreviewAnnotationVector;
}

const VIEW_HASH_PATTERN = /#view=([^#]*)$/;
const DECIMAL_PATTERN = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i;

/** Coordinates keep every digit, so a camera far from the origin survives its own link. */
export function cleanModelCoordinate(value: number): number {
  return value === 0 ? 0 : value;
}

export function formatModelViewHash(view: ModelView): string {
  return `#view=${[...view.position, ...view.target].map(cleanModelCoordinate).join(",")}`;
}

export function modelViewFromHref(href: string): ModelView | null {
  const encoded = VIEW_HASH_PATTERN.exec(href)?.[1];
  if (encoded === undefined) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  const parts = decoded.split(",");
  if (parts.length !== 6 || !parts.every((part) => DECIMAL_PATTERN.test(part.trim()))) return null;
  const values = parts.map(Number);
  if (!values.every(Number.isFinite)) return null;
  const position: PreviewAnnotationVector = [values[0]!, values[1]!, values[2]!];
  const target: PreviewAnnotationVector = [values[3]!, values[4]!, values[5]!];
  // A camera sitting on its own target has no direction to look in.
  if (position.every((value, index) => value === target[index])) return null;
  return { position, target };
}
