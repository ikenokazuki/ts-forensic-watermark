import { describe, it, expect } from 'vitest';
import { embedForensicImage, extractForensicImage } from '../src/node';
import { Jimp } from 'jimp';

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
});
