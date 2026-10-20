/* Server-side checks for processed ad images: the dashboard resizes them, this makes sure it did. */
import {MAX_IMAGE_BYTES} from './config.ts';

export interface ImageInfo { type: 'image/webp' | 'image/png'; width: number; height: number }

const u32be = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u24le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));

/** Reads type and size from the file header. Returns null for anything that isn't PNG or WebP. */
export function imageInfo(b: Uint8Array): ImageInfo | null {
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' && ascii(b, 12, 4) === 'IHDR') {
    return {type: 'image/png', width: u32be(b, 16), height: u32be(b, 20)};
  }
  if (b.length >= 30 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') {
    const chunk = ascii(b, 12, 4);
    if (chunk === 'VP8X') return {type: 'image/webp', width: u24le(b, 24) + 1, height: u24le(b, 27) + 1};
    if (chunk === 'VP8L' && b[20] === 0x2f) {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return {type: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1};
    }
    if (chunk === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
      return {type: 'image/webp', width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff};
    }
  }
  return null;
}

/** Why an upload can't be used, or null when it's fine. */
export function checkImage(b: Uint8Array, width: number, height: number): string | null {
  if (b.length > MAX_IMAGE_BYTES) return `The image is ${Math.round(b.length / 1024)} KB; the limit is ${MAX_IMAGE_BYTES / 1024} KB.`;
  const info = imageInfo(b);
  if (!info) return 'The image must be PNG or WebP.';
  if (info.width !== width || info.height !== height) return `The image is ${info.width}×${info.height}; it must be ${width}×${height}.`;
  return null;
}

/** Animated WebP has an ANIM chunk; animated PNG has acTL. Both are refused. */
export function isAnimated(b: Uint8Array): boolean {
  const s = ascii(b, 0, Math.min(b.length, 4096));
  return s.includes('ANIM') || s.includes('acTL');
}
