import { Jimp, JimpMime } from 'jimp';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import fs from 'fs';
import { embedForensic, extractForensic, ForensicOptions } from './forensic';
import { generateH264SeiPayload, createMp4UuidBox } from './utils';

// Automatically set the FFmpeg path to the static binary
if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic);
}

/**
 * Accepted input type for image helper functions.
 * - `Buffer` — raw image bytes (current behavior, backward compatible)
 * - `string` starting with `http://` or `https://` — fetched via HTTP/HTTPS
 * - `string` (other) — treated as a local file path and read with fs.promises.readFile
 */
export type ImageInput = Buffer | string;

/**
 * Resolves an ImageInput to a Buffer.
 * Supports Buffer pass-through, HTTP/HTTPS URLs, and local file paths.
 */
async function resolveInput(input: ImageInput): Promise<Buffer> {
  if (Buffer.isBuffer(input)) return input;
  if (input.startsWith('http://') || input.startsWith('https://')) {
    const res = await fetch(input);
    if (!res.ok) throw new Error(`Failed to fetch image from URL: ${res.status} ${res.statusText}`);
    return Buffer.from(await res.arrayBuffer());
  }
  return fs.promises.readFile(input);
}

/**
 * [Node.js Helper] Embeds a forensic watermark directly into an image.
 * Accepts a Buffer, a local file path, or an HTTP/HTTPS URL as input.
 * Uses Jimp internally to decode and encode the image.
 *
 * @param input   Raw image Buffer, local file path (e.g. './photo.jpg'), or URL (e.g. 'https://...')
 * @param payload The string payload to embed (max 22 bytes)
 * @param options Tuning parameters for the watermark
 * @param outputPath Optional local file path to save the result (e.g. './out.png'). When provided, the
 *                   watermarked PNG is also written to disk in addition to being returned as a Buffer.
 * @returns A Promise resolving to the watermarked image buffer (PNG format)
 */
export async function embedForensicImage(
  input: ImageInput,
  payload: string,
  options?: ForensicOptions,
  outputPath?: string
): Promise<Buffer> {
  const buffer = await resolveInput(input);
  const image = await Jimp.fromBuffer(buffer);
  const imageData = {
    data: new Uint8ClampedArray(image.bitmap.data),
    width: image.bitmap.width,
    height: image.bitmap.height
  };

  embedForensic(imageData, payload, options);

  // Write the modified pixels back to Jimp
  image.bitmap.data = Buffer.from(imageData.data);
  const outputBuffer = await image.getBuffer(JimpMime.png);

  if (outputPath) {
    await fs.promises.writeFile(outputPath, outputBuffer);
  }

  return outputBuffer;
}

/**
 * [Node.js Helper] Extracts a forensic watermark from an image.
 * Accepts a Buffer, a local file path, or an HTTP/HTTPS URL as input.
 * Automatically tries fallback extraction parameters if the first attempt fails.
 *
 * @param input   Raw image Buffer, local file path (e.g. './photo.png'), or URL (e.g. 'https://...')
 * @param options Tuning parameters for the watermark
 * @returns The extraction result or null if failed
 */
export async function extractForensicImage(
  input: ImageInput,
  options?: ForensicOptions
) {
  const buffer = await resolveInput(input);
  const image = await Jimp.fromBuffer(buffer);
  const imageData = {
    data: new Uint8ClampedArray(image.bitmap.data),
    width: image.bitmap.width,
    height: image.bitmap.height
  };

  // First attempt with provided options or default high delta
  let result = extractForensic(imageData, options || { delta: 120 });

  // Fallback attempt with lower delta if needed
  if (!result || result.payload === 'RECOVERY_FAILED' || result.payload === '') {
    const fallbackResult = extractForensic(imageData, { ...options, delta: 60 });
    if (fallbackResult && fallbackResult.confidence > (result?.confidence || 0)) {
      result = fallbackResult;
    }
  }

  return result;
}

/**
 * [Node.js Helper] Embeds watermarks into a video file using FFmpeg.
 * Injects both H.264 SEI metadata and an MP4 UUID box.
 *
 * @param inputPath  Path to the input video file
 * @param outputPath Path to save the watermarked video file
 * @param payload    The metadata payload (e.g., JSON string)
 * @param uuidHex    The UUID hex string for the SEI/UUID box
 */
export function embedVideoWatermark(
  inputPath: string,
  outputPath: string,
  payload: string,
  uuidHex: string = "d41d8cd98f00b204e9800998ecf8427e"
): Promise<void> {
  return new Promise((resolve, reject) => {
    const seiData = generateH264SeiPayload(uuidHex, payload);

    ffmpeg(inputPath)
      .outputOptions([
        '-c:v', 'copy', // Copy video stream without re-encoding
        '-bsf:v', `h264_metadata=sei_user_data='${seiData}'`, // Inject SEI
        '-c:a', 'copy', // Copy audio stream
        '-movflags', 'frag_keyframe+empty_moov'
      ])
      .save(outputPath)
      .on('end', () => {
        try {
          // Append MP4 UUID box to the end of the generated file
          const payloadBytes = new TextEncoder().encode(payload);
          const uuidBox = createMp4UuidBox(payloadBytes);
          fs.appendFileSync(outputPath, uuidBox);
          resolve();
        } catch (err) {
          reject(err);
        }
      })
      .on('error', (err: Error) => reject(err));
  });
}
