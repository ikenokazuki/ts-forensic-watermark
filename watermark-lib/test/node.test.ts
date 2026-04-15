import { describe, it, expect } from 'vitest';
import { embedForensicImage, extractForensicImage } from '../src/node';
import { Jimp } from 'jimp';

describe('ts-forensic-watermark (Node / Jimp integration)', () => {
  it('should embed and extract a forensic watermark in an image buffer', async () => {
    // 1. Create a simple white dummy image using Jimp
    const originalImage = new Jimp({ width: 256, height: 256, color: 0xffffffff });
    
    // Unfortunately, image.getBuffer(JimpMime.png) expects the mime type.
    // Instead of importing JimpMime which might throw if not setup, we can use the 'image/png' string alias.
    const originalBuffer = await originalImage.getBuffer('image/png');
    
    const payload = "TEST_PAYLOAD_123";

    // 2. Embed the watermark (force: true because pure white image has no variance)
    const watermarkedBuffer = await embedForensicImage(originalBuffer, payload, { force: true });
    
    // Ensure the returned buffer is different from the original and has content
    expect(watermarkedBuffer).toBeDefined();
    expect(watermarkedBuffer.length).toBeGreaterThan(0);
    expect(watermarkedBuffer).not.toEqual(originalBuffer);

    // 3. Extract the watermark
    const result = await extractForensicImage(watermarkedBuffer, { force: true });

    // 4. Verify the extraction
    expect(result).toBeDefined();
    expect(result?.payload).toEqual(payload);
    expect(result?.confidence).toBeGreaterThan(0.5); // Should be a confident extraction
  });
});
