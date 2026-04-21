import { 
  extractEofWatermark, 
  verifyJsonSignature, 
  verifySecurePayload,
  signJsonMetadata,
  generateSecurePayload,
  appendEofWatermark,
  rotateImageData
} from './utils';
import { extractFskBuffer, FskOptions } from './fsk';
import { extractForensic, embedForensic, ForensicOptions } from './forensic';
import { embedLlmVideoFrame, extractLlmVideoFrame, LlmVideoOptions } from './llm-dct';

export type WatermarkRobustness = 'Low (脆弱)' | 'High (堅牢)';

export interface VerificationResult {
  valid: boolean;
  message: string;
}

export interface DetectedWatermark {
  type: 'EOF' | 'UUID_BOX' | 'H264_SEI' | 'AUDIO_FSK' | 'FORENSIC' | 'AUDIO_STRUCT' | 'LLM_VIDEO';
  name: string;
  robustness: WatermarkRobustness;
  data: any;
  verification?: VerificationResult;
}

/**
 * Generate all types of watermark payloads (JSON for EOF, Secure String for Forensic/FSK)
 * based on common metadata. Encapsulates signing logic.
 */
export async function generateWatermarkPayloads(
  metadata: { userId: string, sessionId: string, [key: string]: any },
  secretKey: string,
  secureIdLength: number = 6,
  payloadLength: number = 22
) {
  const fullMetadata = {
    ...metadata,
    timestamp: new Date().toISOString()
  };
  const jsonMetadata = await signJsonMetadata(fullMetadata, secretKey, ['userId', 'sessionId']);
  const securePayload = await generateSecurePayload(metadata.sessionId, secretKey, secureIdLength, payloadLength);

  return {
    json: jsonMetadata,
    jsonString: JSON.stringify(jsonMetadata),
    securePayload
  };
}

/**
 * High-level helper to embed pixel-based forensic watermark into ImageData.
 */
export function embedImageWatermarks(
  imageData: any, 
  securePayload: string, 
  options?: ForensicOptions
): void {
  embedForensic(imageData, securePayload, options);
}

/**
 * High-level helper to append text/JSON watermark to a file buffer (EOF).
 */
export function finalizeImageBuffer(
  buffer: Uint8Array, 
  jsonMetadata: any
): Uint8Array {
  const jsonString = typeof jsonMetadata === 'string' ? jsonMetadata : JSON.stringify(jsonMetadata);
  return appendEofWatermark(buffer, jsonString);
}

/**
 * Extracts all text-based watermarks (EOF, Mp4 UUID Box, H.264 SEI)
 * natively from a binary file buffer.
 * Safe to use in both Node.js and Browser environments.
 */
export function analyzeTextWatermarks(fileBuffer: Uint8Array): DetectedWatermark[] {
  const watermarks: DetectedWatermark[] = [];

  // 1. Analyze EOF Text Metadata
  try {
    const eofText = extractEofWatermark(fileBuffer);
    if (eofText) {
      watermarks.push({
        type: 'EOF',
        name: 'ファイル末尾メタデータ (EOF)',
        robustness: 'Low (脆弱)',
        data: JSON.parse(eofText)
      });
    }
  } catch (e) {
    console.warn("Failed to parse EOF JSON", e);
  }

  // 2. Search for raw JSON string match (MP4 UUID Box or general file embedding)
  try {
    // For large files, scanning the whole file to text might OOM. 
    // We'll scan a smaller chunk at the beginning and end if possible, or use TextDecoder.
    // However, to keep it simple and isomorphic, we limit the search string decode:
    const scanLength = Math.min(fileBuffer.length, 5 * 1024 * 1024); // Scan first 5MB
    const decoder = new TextDecoder();
    const headText = decoder.decode(fileBuffer.subarray(0, scanLength));
    
    // Look for standard payload JSON inside uncompressed streams (UUID Box)
    const jsonMatch = headText.match(/\{"userId":"[^"]+","sessionId":"[^"]+".*?"signature":"[^"]+"\}/);
    if (jsonMatch) {
      if (!watermarks.some(w => w.type === 'EOF' && JSON.stringify(w.data) === jsonMatch[0])) {
        watermarks.push({
          type: 'UUID_BOX',
          name: 'MP4 UUID Box メタデータ',
          robustness: 'Low (脆弱)',
          data: JSON.parse(jsonMatch[0])
        });
      }
    }
  } catch (e) {
    console.warn("Failed to scan for UUID BOX", e);
  }

  // 3. H.264 SEI Extraction
  try {
    const seiUuidHex = '086f3693b7b34f2c965321492feee5b8';
    const seiUuidBytes = new Uint8Array(seiUuidHex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
    
    let seiOffset = -1;
    // Search for SEI UUID across the file
    // To prevent total freeze on large files, we can cap the search or do it chunked, but straightforward loop works well in most V8 engines if not excessively large.
    const searchLimit = Math.min(fileBuffer.length, 50 * 1024 * 1024); // Limit search to first 50MB realistically
    for (let i = 0; i < searchLimit - seiUuidBytes.length; i++) {
      if (fileBuffer[i] === seiUuidBytes[0]) {
        let match = true;
        for (let j = 1; j < seiUuidBytes.length; j++) {
          if (fileBuffer[i + j] !== seiUuidBytes[j]) {
            match = false;
            break;
          }
        }
        if (match) {
          seiOffset = i;
          break;
        }
      }
    }

    if (seiOffset !== -1) {
      const payloadBytes: number[] = [];
      for (let i = seiOffset + 16; i < fileBuffer.length; i++) {
        if (fileBuffer[i] === 0 || fileBuffer[i] < 32 || fileBuffer[i] > 126) break;
        payloadBytes.push(fileBuffer[i]);
      }
      let base64Payload = String.fromCharCode(...payloadBytes);
      if (base64Payload.startsWith('+')) {
        base64Payload = base64Payload.substring(1);
      }
      base64Payload = base64Payload.replace(/-/g, '+').replace(/_/g, '/');
      while (base64Payload.length % 4 !== 0) {
        base64Payload += '=';
      }
      try {
        const jsonStr = atob(base64Payload);
        const data = JSON.parse(jsonStr);
        if (!watermarks.some(w => w.type === 'H264_SEI' && JSON.stringify(w.data) === jsonStr)) {
          watermarks.push({
            type: 'H264_SEI',
            name: 'ビデオストリーム (H.264 SEI)',
            robustness: 'High (堅牢)',
            data: data
          });
        }
      } catch (e) {
        console.warn("Failed to parse SEI payload JSON:", e);
      }
    }
  } catch (e) {
    console.warn("H264 SEI extraction failed", e);
  }

  return watermarks;
}

/**
 * Wraps the FSK Float32 array extraction and shapes the output.
 */
export function analyzeAudioWatermarks(channelData: Float32Array, options?: FskOptions): DetectedWatermark[] {
  const watermarks: DetectedWatermark[] = [];
  try {
    const finalPayload = extractFskBuffer(channelData, options);
    if (finalPayload) {
      watermarks.push({
        type: 'AUDIO_FSK',
        name: 'FSK音声透かし (Reed-Solomon自己修復)',
        robustness: 'High (堅牢)',
        data: { payload: finalPayload }
      });
    }
  } catch (e) {
    console.warn("Audio FSK extraction failed", e);
  }
  return watermarks;
}

/**
 * High-level helper to embed LLM DCT watermark into a single ImageData (image or video frame).
 * ブラウザ・Node.js 両対応。動画ファイル全体を処理する場合は node.ts の embedLlmVideoFrames を使用。
 *
 * 推奨用途:
 *  - 動画フレーム・均質な画像（PNG/JPG）への埋め込み
 *  - 自然写真には embedImageWatermarks（DWT+DCT+SVD）の方が適している場合がある
 */
export function embedLlmImageWatermark(
  imageData: any,
  payload: string,
  options?: LlmVideoOptions
): void {
  embedLlmVideoFrame(imageData, payload, options);
}

/**
 * Extracts LLM DCT watermarks from a single ImageData (image or video frame) and shapes output.
 * ブラウザ・Node.js 両対応。動画ファイル全体を処理する場合は node.ts の analyzeVideoLlmWatermarks を使用。
 *
 * Note: Requires `ImageData`, which is native to Browser (Canvas) but requires `canvas` polyfill in Node.
 */
export function analyzeLlmImageWatermarks(imageData: any, options?: LlmVideoOptions): DetectedWatermark[] {
  const watermarks: DetectedWatermark[] = [];
  const angles = options?.robustAngles || [0];

  for (const angle of angles) {
    try {
      let processedImageData = imageData;
      if (Math.abs(angle) > 0.01) {
        processedImageData = rotateImageData(imageData, angle);
      }

      const result = extractLlmVideoFrame(processedImageData, options);
      if (result && result.payload) {
        watermarks.push({
          type: 'LLM_VIDEO',
          name: angle === 0 ? 'LLM DCT透かし (Reed-Solomon自己修復)' : `LLM DCT透かし (${angle}度回転時)`,
          robustness: 'High (堅牢)',
          data: { payload: result.payload, confidence: result.confidence, angle }
        });
        // 成功したら即返す（無駄な回転解析を省略）
        return watermarks;
      }
    } catch (e) {
      console.warn(`LLM DCT extraction failed at angle ${angle}`, e);
    }
  }
  return watermarks;
}

/**
 * Wraps Forensic extraction and shapes output.
 * Note: Requires `ImageData`, which is native to Browser (Canvas) but requires `canvas` polyfill in Node.
 */
export function analyzeImageWatermarks(imageData: any, options: ForensicOptions): DetectedWatermark[] {
  const watermarks: DetectedWatermark[] = [];
  const angles = options.robustAngles || [0];
  
  for (const angle of angles) {
    try {
      let processedImageData = imageData;
      if (Math.abs(angle) > 0.01) {
        processedImageData = rotateImageData(imageData, angle);
      }

      const forensicResult = extractForensic(processedImageData, options);
      if (forensicResult && forensicResult.payload !== 'RECOVERY_FAILED' && forensicResult.payload.length > 0) {
        watermarks.push({
          type: 'FORENSIC',
          name: angle === 0 ? '高度フォレンジック透かし (DWT+DCT+SVD)' : `高度フォレンジック透かし (${angle}度回転時)`,
          robustness: 'High (堅牢)',
          data: { payload: forensicResult.payload, confidence: forensicResult.confidence, angle }
        });
        // 成功したらその結果を返し、無駄な回転解析を終了する
        return watermarks;
      }
    } catch (err) {
      console.warn(`Forensic extraction failed at angle ${angle}`, err);
    }
  }
  return watermarks;
}

/**
 * High-level helper that runs both DWT+DCT+SVD (forensic) and LLM DCT extraction
 * on the same ImageData, returning all detected watermarks combined.
 *
 * 埋め込み方式が不明な場合や両方式を試したい場合に使用します。
 * - forensicOptions を省略すると DWT+DCT+SVD は delta:120 で試行します
 * - llmOptions を省略すると LLM DCT はデフォルト設定（quantStep:300）で試行します
 *
 * @param imageData      RGBA フレームデータ（ImageData 互換）
 * @param forensicOptions DWT+DCT+SVD 抽出オプション（省略可）
 * @param llmOptions     LLM DCT 抽出オプション（省略可）
 * @returns 検出されたすべての透かし（FORENSIC / LLM_VIDEO）の配列
 */
export function analyzeAllImageWatermarks(
  imageData: any,
  forensicOptions?: ForensicOptions,
  llmOptions?: LlmVideoOptions
): DetectedWatermark[] {
  const results: DetectedWatermark[] = [];

  // 1. DWT+DCT+SVD フォレンジック透かし
  const forensicWMs = analyzeImageWatermarks(imageData, forensicOptions ?? { delta: 120 });
  results.push(...forensicWMs);

  // 2. LLM DCT 動画フレーム透かし
  const llmWMs = analyzeLlmImageWatermarks(imageData, llmOptions);
  results.push(...llmWMs);

  return results;
}

/**
 * Runs cryptographic verification over all detected watermarks.
 * Depending on the payload structure (JSON vs Secure String), it applies the correct HMAC checking logic.
 */
export async function verifyWatermarks(
  watermarks: DetectedWatermark[],
  secretKey: string,
  secureIdLength: number = 6,
  payloadLength: number = 22
): Promise<DetectedWatermark[]> {
  const verified: DetectedWatermark[] = [];

  for (const wm of watermarks) {
    let result: DetectedWatermark = { ...wm };

    if (wm.type === 'EOF' || wm.type === 'UUID_BOX' || wm.type === 'H264_SEI' || wm.type === 'AUDIO_STRUCT') {
      try {
        const isValid = await verifyJsonSignature(wm.data, secretKey, ['userId', 'sessionId']);
        result.verification = {
          valid: isValid,
          message: isValid ? 'HMAC署名の検証に成功しました。データは真正です。' : 'HMAC署名が一致しません。改ざんの可能性があります。'
        };
      } catch (e) {
        result.verification = { valid: false, message: 'JSON検証中にエラーが発生しました。' };
      }
    } 
    else if (wm.type === 'AUDIO_FSK' || wm.type === 'FORENSIC' || wm.type === 'LLM_VIDEO') {
      const payloadString = wm.data.payload || wm.data.sessionId; // Accommodating multiple data structures depending on embed logic
      if (payloadString && payloadString.length === payloadLength) {
        try {
          const isValid = await verifySecurePayload(payloadString, secretKey, secureIdLength, payloadLength);
          result.verification = {
            valid: isValid,
            message: isValid
              ? `セキュアペイロードの検証に成功しました。（セッションID: ${payloadString.substring(0, secureIdLength)}）`
              : 'セキュアペイロードの検証に失敗しました。'
          };
        } catch(e) {
          result.verification = { valid: false, message: 'セキュアペイロード検証中にエラーが発生しました。' };
        }
      } else {
        result.verification = {
          valid: true,
          message: '署名なしのペイロードですが、抽出に成功しました。'
        };
        // Normalize for user provided UI
        if (payloadString && !wm.data.sessionId) {
          result.data.sessionId = payloadString;
          result.data.userId = '注文番号から特定可能';
        }
      }
    }

    verified.push(result);
  }

  return verified;
}
