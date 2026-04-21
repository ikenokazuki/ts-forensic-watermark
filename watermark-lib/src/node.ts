import { Jimp, JimpMime } from 'jimp';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { embedForensic, extractForensic, ForensicOptions } from './forensic';
import { embedLlmVideoFrame, extractLlmVideoFrame, LlmVideoOptions } from './llm-dct';
import { generateH264SeiPayload, createMp4UuidBox } from './utils';
import { DetectedWatermark } from './analyzer';

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
 * [Node.js Helper] Embeds an LLM DCT video watermark into an image file.
 * Reads the image with Jimp, applies LLM DCT embedding frame-by-frame (single frame),
 * and returns the result as a PNG buffer.
 *
 * @param input      Raw image Buffer, local file path, or HTTP/HTTPS URL
 * @param payload    The string payload to embed (Base64url, max payloadSymbols chars)
 * @param options    LlmVideoOptions (quantStep, coeffRow, coeffCol, etc.)
 * @param outputPath Optional path to save the watermarked PNG to disk
 * @returns Promise resolving to the watermarked image buffer (PNG format)
 */
export async function embedLlmVideoFile(
  input: ImageInput,
  payload: string,
  options?: LlmVideoOptions,
  outputPath?: string
): Promise<Buffer> {
  const buffer = await resolveInput(input);
  const image = await Jimp.fromBuffer(buffer);
  const imageData = {
    data: new Uint8ClampedArray(image.bitmap.data),
    width: image.bitmap.width,
    height: image.bitmap.height
  };

  embedLlmVideoFrame(imageData, payload, options);

  image.bitmap.data = Buffer.from(imageData.data);
  const outputBuffer = await image.getBuffer(JimpMime.png);

  if (outputPath) {
    await fs.promises.writeFile(outputPath, outputBuffer);
  }

  return outputBuffer;
}

/**
 * [Node.js Helper] Extracts an LLM DCT video watermark from an image file.
 * Reads the image with Jimp, applies LLM DCT extraction, and returns the result.
 *
 * @param input   Raw image Buffer, local file path, or HTTP/HTTPS URL
 * @param options LlmVideoOptions (must match embed-time settings)
 * @returns Promise resolving to { payload, confidence } or null if extraction failed
 */
export async function extractLlmVideoFile(
  input: ImageInput,
  options?: LlmVideoOptions
): Promise<{ payload: string; confidence: number } | null> {
  const buffer = await resolveInput(input);
  const image = await Jimp.fromBuffer(buffer);
  const imageData = {
    data: new Uint8ClampedArray(image.bitmap.data),
    width: image.bitmap.width,
    height: image.bitmap.height
  };

  return extractLlmVideoFrame(imageData, options);
}

// ─── LLM DCT 動画全体処理ヘルパー ────────────────────────────────────────────

/** ffprobe で動画のフレームレートを取得する */
function getVideoFps(inputPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) return reject(err);
      const video = metadata.streams.find(s => s.codec_type === 'video');
      if (!video?.r_frame_rate) return resolve(25);
      const [num, den] = video.r_frame_rate.split('/').map(Number);
      resolve(den ? num / den : num);
    });
  });
}

/** 全フレームを PNG 連番として tmpDir へ展開する */
function extractAllFrames(inputPath: string, tmpDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions(['-vsync', '0'])
      .output(path.join(tmpDir, 'frame_%06d.png'))
      .on('end', () => resolve())
      .on('error', reject)
      .run();
  });
}

/** 動画から均等間隔で最大 maxFrames 枚のフレームを抽出する（抽出専用） */
function extractSampleFrames(inputPath: string, tmpDir: string, maxFrames: number): Promise<void> {
  return new Promise((resolve, reject) => {
    // fps=1 で秒1枚を最大 maxFrames 枚まで取得
    ffmpeg(inputPath)
      .outputOptions(['-vf', 'fps=1', '-vframes', String(maxFrames), '-vsync', '0'])
      .output(path.join(tmpDir, 'frame_%06d.png'))
      .on('end', () => resolve())
      .on('error', reject)
      .run();
  });
}

/** PNG 連番 + 元動画の音声から動画を再エンコードする */
function reencodeFromFrames(
  framesGlob: string,
  audioSourcePath: string,
  outputPath: string,
  fps: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(framesGlob)
      .inputOptions([`-framerate ${fps}`])
      .input(audioSourcePath)
      .outputOptions([
        '-map', '0:v',
        '-map', '1:a?',   // 音声トラックがない場合もエラーにしない
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'copy',
        '-shortest'
      ])
      .save(outputPath)
      .on('end', () => resolve())
      .on('error', reject);
  });
}

/**
 * [Node.js Helper] 動画ファイルの全フレームに LLM DCT 透かしを埋め込みます。
 *
 * 処理フロー:
 *   1. FFmpeg で全フレームを PNG 連番に展開（一時ディレクトリ）
 *   2. Jimp で各フレームを読み込み → `embedLlmVideoFrame` で透かし埋め込み → 上書き保存
 *   3. FFmpeg で PNG 連番 + 元音声から動画を再エンコード
 *   4. 一時ディレクトリを削除
 *
 * @param inputPath  入力動画ファイルのパス（MP4 等）
 * @param payload    埋め込むペイロード文字列（Base64url）
 * @param outputPath 出力動画ファイルのパス
 * @param options    LlmVideoOptions（埋め込みパラメータ）
 */
export async function embedLlmVideoFrames(
  inputPath: string,
  payload: string,
  outputPath: string,
  options?: LlmVideoOptions
): Promise<void> {
  const tmpDir = path.join(os.tmpdir(), `llm_embed_${crypto.randomBytes(8).toString('hex')}`);
  await fs.promises.mkdir(tmpDir, { recursive: true });

  try {
    const fps = await getVideoFps(inputPath);
    await extractAllFrames(inputPath, tmpDir);

    const frameFiles = (await fs.promises.readdir(tmpDir))
      .filter(f => f.endsWith('.png'))
      .sort();

    for (const frameFile of frameFiles) {
      const framePath = path.join(tmpDir, frameFile);
      const image = await Jimp.fromBuffer(await fs.promises.readFile(framePath));
      const imageData = {
        data: new Uint8ClampedArray(image.bitmap.data),
        width: image.bitmap.width,
        height: image.bitmap.height
      };

      embedLlmVideoFrame(imageData, payload, options);

      image.bitmap.data = Buffer.from(imageData.data);
      await fs.promises.writeFile(framePath, await image.getBuffer(JimpMime.png));
    }

    await reencodeFromFrames(
      path.join(tmpDir, 'frame_%06d.png'),
      inputPath,
      outputPath,
      fps
    );
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * [Node.js Helper] 動画ファイルから LLM DCT 透かしを抽出します。
 *
 * 動画全体から等間隔でフレームをサンプリングし、
 * 最も信頼度（confidence）が高い抽出結果を返します。
 *
 * @param inputPath    入力動画ファイルのパス
 * @param options      LlmVideoOptions + `sampleFrames`（サンプル枚数、デフォルト: 10）
 * @returns `{ payload, confidence }` または null（Reed-Solomon 訂正不能の場合）
 */
export async function extractLlmVideoFrames(
  inputPath: string,
  options?: LlmVideoOptions & { sampleFrames?: number }
): Promise<{ payload: string; confidence: number } | null> {
  const { sampleFrames = 10, ...llmOpts } = options ?? {};
  const tmpDir = path.join(os.tmpdir(), `llm_extract_${crypto.randomBytes(8).toString('hex')}`);
  await fs.promises.mkdir(tmpDir, { recursive: true });

  try {
    await extractSampleFrames(inputPath, tmpDir, sampleFrames);

    const frameFiles = (await fs.promises.readdir(tmpDir))
      .filter(f => f.endsWith('.png'))
      .sort();

    let best: { payload: string; confidence: number } | null = null;

    for (const frameFile of frameFiles) {
      const framePath = path.join(tmpDir, frameFile);
      const image = await Jimp.fromBuffer(await fs.promises.readFile(framePath));
      const imageData = {
        data: new Uint8ClampedArray(image.bitmap.data),
        width: image.bitmap.width,
        height: image.bitmap.height
      };

      const result = extractLlmVideoFrame(imageData, llmOpts);
      if (result && (!best || result.confidence > best.confidence)) {
        best = result;
      }
    }

    return best;
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * [Node.js Helper] 動画ファイルから LLM DCT 透かしを抽出し、DetectedWatermark[] 形式で返します。
 *
 * `verifyWatermarks` に直接渡せる形式で返すため、
 * `extractLlmVideoFrames` → 手動ラップ → `verifyWatermarks` という手順なしに
 * 動画の一括署名検証が可能になります。
 *
 * 使用例:
 * ```typescript
 * const watermarks = await analyzeVideoLlmWatermarks('./video.mp4', { quantStep: 300 });
 * const verified   = await verifyWatermarks(watermarks, secretKey, 6, 22);
 * ```
 *
 * @param inputPath  入力動画ファイルのパス
 * @param options    LlmVideoOptions + `sampleFrames`（デフォルト: 10）
 * @returns `DetectedWatermark[]`（検出できなかった場合は空配列）
 */
export async function analyzeVideoLlmWatermarks(
  inputPath: string,
  options?: LlmVideoOptions & { sampleFrames?: number }
): Promise<DetectedWatermark[]> {
  const watermarks: DetectedWatermark[] = [];
  try {
    const result = await extractLlmVideoFrames(inputPath, options);
    if (result && result.payload) {
      watermarks.push({
        type: 'LLM_VIDEO',
        name: 'LLM DCT動画フレーム透かし (Reed-Solomon自己修復)',
        robustness: 'High (堅牢)',
        data: { payload: result.payload, confidence: result.confidence }
      });
    }
  } catch (e) {
    console.warn('LLM DCT video extraction failed', e);
  }
  return watermarks;
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
