/* Crops an uploaded image to a slot's shape and resizes it to exact pixel sizes:
   Lanczos3 when shrinking, nearest neighbour when enlarging, so pixel art stays crisp and photos stay sharp. */
import {createDitherette, type Ditherette} from 'ditherette';

export const MAX_BYTES = 300 * 1024;
export interface Crop { sx: number; sy: number; sw: number; sh: number }

let processor: Promise<Ditherette> | null = null;
const getProcessor = () => (processor ??= createDitherette());

/** The largest crop of the target shape, scaled by `zoom` (1 = as large as possible) and centred on (fx, fy) in 0–1. */
export function cropFor(srcW: number, srcH: number, aspect: number, zoom: number, fx: number, fy: number): Crop {
  let sw = srcW, sh = srcW / aspect;
  if (sh > srcH) { sh = srcH; sw = srcH * aspect; }
  sw *= zoom; sh *= zoom;
  const sx = Math.min(Math.max(0, fx * srcW - sw / 2), srcW - sw);
  const sy = Math.min(Math.max(0, fy * srcH - sh / 2), srcH - sh);
  return {sx: Math.round(sx), sy: Math.round(sy), sw: Math.max(1, Math.round(sw)), sh: Math.max(1, Math.round(sh))};
}

function pixels(bitmap: ImageBitmap, c: Crop): Uint8Array {
  const canvas = new OffscreenCanvas(c.sw, c.sh), g = canvas.getContext('2d')!;
  g.drawImage(bitmap, c.sx, c.sy, c.sw, c.sh, 0, 0, c.sw, c.sh);
  const data = g.getImageData(0, 0, c.sw, c.sh).data;
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/** Resizes the crop to width×height and encodes WebP small enough for the size limit. */
export async function render(bitmap: ImageBitmap, crop: Crop, width: number, height: number): Promise<{blob: Blob; algorithm: string}> {
  const source = {width: crop.sw, height: crop.sh, data: pixels(bitmap, crop)};
  const shrinking = width * height < crop.sw * crop.sh;
  const resize = shrinking
    ? {algorithm: 'lanczos3', anchor: 'center', support: 'scale-aware'} as const
    : {algorithm: 'nearest', anchor: 'center'} as const;
  const out = (await getProcessor()).resize({version: 1, source, output: {width, height, resize}});
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(out.data) as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0);
  for (const quality of [0.92, 0.85, 0.75, 0.6, 0.45]) {
    const blob = await canvas.convertToBlob({type: 'image/webp', quality});
    if (blob.type === 'image/webp' && blob.size <= MAX_BYTES) return {blob, algorithm: shrinking ? 'Lanczos3' : 'nearest neighbour'};
  }
  throw new Error('This image can’t get under 300 KB at that size. Try a simpler image.');
}

/** Fits the whole image inside width×height on a transparent background, for logos. */
export async function renderContain(bitmap: ImageBitmap, width: number, height: number): Promise<Blob> {
  const k = Math.min(width / bitmap.width, height / bitmap.height);
  const w = Math.max(1, Math.round(bitmap.width * k)), h = Math.max(1, Math.round(bitmap.height * k));
  const {blob} = await render(bitmap, {sx: 0, sy: 0, sw: bitmap.width, sh: bitmap.height}, w, h);
  const fitted = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d')!.drawImage(fitted, Math.round((width - w) / 2), Math.round((height - h) / 2));
  for (const quality of [0.92, 0.8, 0.65]) {
    const out = await canvas.convertToBlob({type: 'image/webp', quality});
    if (out.size <= MAX_BYTES) return out;
  }
  throw new Error('This logo can’t get under 300 KB. Try a simpler file.');
}
