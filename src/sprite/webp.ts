import type { RasterFrame } from './raster.js';

/** Encode the registered frames, then verify pixels, ordering, timing and looping. */
export async function encodeWebp(frames: RasterFrame[], frameDurationMs: number): Promise<Uint8Array> {
  // Load the native encoder only when WebP is requested; PNG/APNG stay independent.
  const { default: sharp } = await import('sharp');
  const { width, height } = frames[0]!;
  const pixels = Buffer.concat(frames.map((frame) => Buffer.from(frame.rgba)));
  // Sharp's animation optimizer merges duplicate poses (including all-idle sequences).
  // Wrap lossless still frames in ANMF chunks to preserve the exact source timeline.
  // Container layout: https://developers.google.com/speed/webp/docs/riff_container
  const extended = Buffer.alloc(10);
  extended[0] = 0x12; // Alpha and animation flags.
  extended.writeUIntLE(width - 1, 4, 3);
  extended.writeUIntLE(height - 1, 7, 3);
  const chunks = [chunk('VP8X', extended), chunk('ANIM', Buffer.alloc(6))]; // Transparent background, infinite loop.
  for (const frame of frames) {
    const still = await sharp(frame.rgba, { raw: { width, height, channels: 4 } })
      .webp({ lossless: true, exact: true }).toBuffer();
    // A lossless still emitted without metadata contains one VP8L image chunk.
    const payloadSize = still.readUInt32LE(16);
    if (still.toString('ascii', 12, 16) !== 'VP8L' || 20 + payloadSize + (payloadSize % 2) !== still.length) {
      throw new Error('Unexpected lossless WebP frame structure');
    }
    const header = Buffer.alloc(16);
    header.writeUIntLE(width - 1, 6, 3);
    header.writeUIntLE(height - 1, 9, 3);
    header.writeUIntLE(frameDurationMs, 12, 3);
    header[15] = 2; // Replace the full canvas without alpha blending or disposal.
    chunks.push(chunk('ANMF', Buffer.concat([header, still.subarray(12)])));
  }
  const body = Buffer.concat([Buffer.from('WEBP'), ...chunks]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF');
  riff.writeUInt32LE(body.length, 4);
  const bytes = Buffer.concat([riff, body]);
  const decoded = sharp(bytes, { animated: true });
  const metadata = await decoded.metadata();
  if (metadata.pages !== frames.length || metadata.width !== width || metadata.pageHeight !== height || metadata.loop !== 0
    || metadata.delay?.length !== frames.length || metadata.delay.some((delay) => delay !== frameDurationMs)) {
    throw new Error('WebP animation structure or timing mismatch');
  }
  const actual = await decoded.ensureAlpha().raw().toBuffer();
  if (!actual.equals(pixels)) throw new Error('WebP changed normalized pixels');
  return bytes;
}

function chunk(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(type);
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload, Buffer.alloc(payload.length % 2)]);
}
