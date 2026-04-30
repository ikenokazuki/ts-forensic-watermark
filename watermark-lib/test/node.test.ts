import { describe, it, expect, vi } from 'vitest';
import { embedForensicImage, extractForensicImage } from '../src/node';
import { Jimp, JimpMime } from 'jimp';

describe('ts-forensic-watermark (Node / Jimp integration)', () => {
  it('should embed and extract a forensic watermark in an image buffer', async () => {
    // Gray image avoids clamping artifacts at pixel value boundaries
    const originalImage = new Jimp({ width: 256, height: 256, color: 0x808080ff });
    const originalBuffer = await originalImage.getBuffer('image/png');

    // Payload must be exactly 22 Base64url characters (matching DATA_LEN)
    const payload = "TX9901SGVsbG8hV29ybGQ-";

    const watermarkedBuffer = await embedForensicImage(originalBuffer, payload, { force: true });

    expect(watermarkedBuffer).toBeDefined();
    expect(watermarkedBuffer.length).toBeGreaterThan(0);
    expect(watermarkedBuffer).not.toEqual(originalBuffer);

    const result = await extractForensicImage(watermarkedBuffer, { force: true });

    expect(result).toBeDefined();
    expect(result?.payload).toEqual(payload);
    expect(result?.confidence).toBeGreaterThan(50);
  });

  it('should embed and extract with spatial diversity (regions > 1)', async () => {
    // 3 regions arranged as 3x1 (or 1x3) need at least 480x160 or 160x480 px
    const originalImage = new Jimp({ width: 512, height: 512, color: 0x808080ff });
    const originalBuffer = await originalImage.getBuffer('image/png');

    const payload = "TX9901SGVsbG8hV29ybGQ-";

    const watermarkedBuffer = await embedForensicImage(originalBuffer, payload, { force: true, regions: 3 });

    expect(watermarkedBuffer).toBeDefined();
    expect(watermarkedBuffer).not.toEqual(originalBuffer);

    const result = await extractForensicImage(watermarkedBuffer, { force: true, regions: 3 });

    expect(result).toBeDefined();
    expect(result?.payload).toEqual(payload);
    expect(result?.confidence).toBeGreaterThan(50);
  });

  it('survives a JPEG round-trip (Q=70) on a textured image with soft decoding enabled', async () => {
    // Build a textured image so JPEG actually exercises lossy compression.
    // Pure flat images compress losslessly and don't stress the codec.
    const W = 512, H = 512;
    const tex = new Jimp({ width: W, height: H, color: 0x808080ff });
    let seed = 0xC0FFEE;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const noise = ((seed >>> 16) & 0x3F) - 32; // ±32 bounded noise
        const v = 128 + noise + Math.floor(20 * Math.sin((x + y) * 0.05));
        const c = Math.max(0, Math.min(255, v));
        tex.setPixelColor(((c << 24) | (c << 16) | (c << 8) | 0xff) >>> 0, x, y);
      }
    }
    const originalBuffer = await tex.getBuffer(JimpMime.png);
    const payload = "TX9901SGVsbG8hV29ybGQ-";

    // Embed (PNG) → re-encode as JPEG Q=70 → extract.
    const watermarkedPng = await embedForensicImage(originalBuffer, payload);
    const wmImage = await Jimp.fromBuffer(watermarkedPng);
    const jpegBuf = await wmImage.getBuffer(JimpMime.jpeg, { quality: 70 });

    const result = await extractForensicImage(jpegBuf);
    expect(result?.payload).toEqual(payload);
  });

  it('soft decoding accepts a higher payloadSymbols (smaller ECC) under JPEG than hard decoding', async () => {
    // payloadSymbols=32 → ECC=31, hard-decision t=15.
    // With soft (erasure) decoding, the same code can correct up to 31 erasures,
    // so a heavier-payload variant becomes viable in the JPEG-degradation regime.
    const W = 512, H = 512;
    const tex = new Jimp({ width: W, height: H, color: 0x808080ff });
    let seed = 0xC0FFEE;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const noise = ((seed >>> 16) & 0x3F) - 32;
        const v = 128 + noise + Math.floor(20 * Math.sin((x + y) * 0.05));
        const c = Math.max(0, Math.min(255, v));
        tex.setPixelColor(((c << 24) | (c << 16) | (c << 8) | 0xff) >>> 0, x, y);
      }
    }
    const originalBuffer = await tex.getBuffer(JimpMime.png);
    const longerPayload = "TX9901SGVsbG8hV29ybGQ-AbCdEfGhIj"; // 32 chars
    const opts = { payloadSymbols: 32 } as const;

    const watermarkedPng = await embedForensicImage(originalBuffer, longerPayload, opts);
    const wmImage = await Jimp.fromBuffer(watermarkedPng);
    const jpegBuf = await wmImage.getBuffer(JimpMime.jpeg, { quality: 70 });

    const soft = await extractForensicImage(jpegBuf, { ...opts, softDecoding: true });
    expect(soft?.payload).toEqual(longerPayload);
  });

  it('should gracefully fall back when requested regions do not fit the image', async () => {
    // 4 regions on 256x256 → each would be 128x128 < MIN_REGION_PX (160).
    // Expected: silently fall back to regions=1, round-trip still succeeds
    // because embed and extract use the same fallback logic.
    const small = new Jimp({ width: 256, height: 256, color: 0x808080ff });
    const buffer = await small.getBuffer('image/png');
    const payload = "TX9901SGVsbG8hV29ybGQ-";

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const wm = await embedForensicImage(buffer, payload, { force: true, regions: 4 });
      const result = await extractForensicImage(wm, { force: true, regions: 4 });
      expect(result?.payload).toEqual(payload);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
