import { ReedSolomonGF64, base64urlToSymbols, symbolsToBase64url } from './rs-gf64';

export interface FskOptions {
  sampleRate?: number;
  bitDuration?: number;
  syncDuration?: number;
  marginDuration?: number;
  amplitude?: number;
  freqZero?: number;
  freqOne?: number;
  freqSync?: number;
  /**
   * データシンボル数 (デフォルト: 22、範囲: 1〜39)。
   * FSKは合計40シンボル固定。残り (40 - payloadSymbols) がECC。
   * - 小さくする → ECCが増え誤り訂正能力が上がる（最大19シンボルまで）
   * - 大きくする → ペイロードが長くなるが誤り訂正能力が下がる
   * 埋め込み時と抽出時で同じ値を指定してください。
   */
  payloadSymbols?: number;
}

const BITS_PER_SYM = 6;
const FSK_TOTAL_SYMBOLS = 40; // 固定: 合計40シンボル × 6ビット = 240ビット
const DEFAULT_PAYLOAD_SYMBOLS = 22;

/**
 * Generates an FSK (Frequency-Shift Keying) encoded WAV buffer.
 * It contains a synchronization pulse, a margin, and the encoded data.
 * The payload is padded to DATA_LEN (22 bytes) and encoded using Reed-Solomon.
 * 
 * @param payload The metadata payload (up to 22 bytes)
 * @param options FSK audio generation options
 * @returns A Uint8Array containing the complete WAV file structure
 */
export function generateFskBuffer(payload: string, options?: FskOptions): Uint8Array {
  const sampleRate = options?.sampleRate || 44100;
  const bitDuration = options?.bitDuration || 0.025; // 高速版 25ms
  const syncDuration = options?.syncDuration || 0.05; // 同期音 50ms
  const marginDuration = options?.marginDuration || 0.1; // ガードインターバル
  const amplitude = options?.amplitude || 50;
  // 14/15/16 kHz: inaudible to most humans yet preserved by AAC at 192 kb/s+.
  // 17/18/19 kHz was destroyed by AAC's psychoacoustic model at the default ~69 kb/s.
  const freqSync = options?.freqSync ?? 14000;
  const freqZero = options?.freqZero ?? 15000;
  const freqOne  = options?.freqOne  ?? 16000;
  const dataLen = Math.max(1, Math.min(39, options?.payloadSymbols ?? DEFAULT_PAYLOAD_SYMBOLS));
  const eccLen = FSK_TOTAL_SYMBOLS - dataLen;
  const totalBits = FSK_TOTAL_SYMBOLS * BITS_PER_SYM; // 常に240ビット固定
  const rsInst = new ReedSolomonGF64(eccLen);

  const samplesPerBit = Math.floor(sampleRate * bitDuration);
  const syncSamples = Math.floor(sampleRate * syncDuration);
  const marginSamples = Math.floor(sampleRate * marginDuration);

  // Payload processing (GF64: dataLen data + eccLen ECC = 40 symbols × 6 bits = 240 bits)
  const padded = payload.length >= dataLen ? payload.slice(0, dataLen) : payload + 'A'.repeat(dataLen - payload.length);
  const interleaved = rsInst.encode(base64urlToSymbols(padded));
  const totalSamples = syncSamples + marginSamples + (totalBits * samplesPerBit);
  const bufferLen = 44 + totalSamples * 2;
  const buffer = new Uint8Array(bufferLen);
  const dataView = new DataView(buffer.buffer);

  // WAV Header writing
  const writeString = (s: string, offset: number) => { 
    for (let i = 0; i < s.length; i++) buffer[offset + i] = s.charCodeAt(i); 
  };
  
  writeString('RIFF', 0);
  dataView.setUint32(4, 36 + totalSamples * 2, true);
  writeString('WAVE', 8);
  writeString('fmt ', 12);
  dataView.setUint32(16, 16, true);
  dataView.setUint16(20, 1, true);
  dataView.setUint16(22, 1, true);
  dataView.setUint32(24, sampleRate, true);
  dataView.setUint32(28, sampleRate * 2, true);
  dataView.setUint16(32, 2, true);
  dataView.setUint16(34, 16, true);
  writeString('data', 36);
  dataView.setUint32(40, totalSamples * 2, true);

  let phase = 0; // 位相を保持する変数を追加

  // 1. 同期音
  for (let i = 0; i < syncSamples; i++) {
    const val = Math.sin(phase) * amplitude;
    dataView.setInt16(44 + i * 2, Math.floor(val), true);
    phase += 2 * Math.PI * freqSync / sampleRate;
  }

  // 2. ★ 隙間 (0.1秒間、0を書き込む)
  for (let i = 0; i < marginSamples; i++) {
    dataView.setInt16(44 + (syncSamples + i) * 2, 0, true);
  }

  // 3. データビット (freqZero or freqOne)
  let currentPos = syncSamples + marginSamples;
  for (let i = 0; i < totalBits; i++) {
    const symIdx = Math.floor(i / BITS_PER_SYM);
    const bitIdx = i % BITS_PER_SYM;
    const bit = (interleaved[symIdx] >> (BITS_PER_SYM - 1 - bitIdx)) & 1;
    const freq = bit === 1 ? freqOne : freqZero;

    for (let s = 0; s < samplesPerBit; s++) {
      const val = Math.sin(2 * Math.PI * freq * s / sampleRate) * amplitude;
      dataView.setInt16(44 + (currentPos + s) * 2, Math.floor(val), true);
      phase += 2 * Math.PI * freq / sampleRate;
    }
    currentPos += samplesPerBit;
  }

  return buffer;
}

/**
 * Extracts FSK encoded payload from audio channel data (Float32Array).
 * Uses Goertzel algorithm for frequency detection and Reed-Solomon for error correction.
 */
export function extractFskBuffer(channelData: Float32Array, options?: FskOptions): string | null {
  const sampleRate = options?.sampleRate || 44100;
  const bitDuration = options?.bitDuration || 0.025;
  const syncDuration = options?.syncDuration || 0.05;
  const marginDuration = options?.marginDuration || 0.1;
  const freqZero = options?.freqZero ?? 15000;
  const freqOne  = options?.freqOne  ?? 16000;
  const freqSync = options?.freqSync ?? 14000;
  const dataLen = Math.max(1, Math.min(39, options?.payloadSymbols ?? DEFAULT_PAYLOAD_SYMBOLS));
  const eccLen = FSK_TOTAL_SYMBOLS - dataLen;
  const totalBits = FSK_TOTAL_SYMBOLS * BITS_PER_SYM; // 常に240ビット固定

  function goertzel(data: Float32Array | Array<number>, freq: number, sampleRate: number) {
    const k = Math.round(0.5 + (data.length * freq) / sampleRate);
    const w = (2 * Math.PI * k) / data.length;
    const cosine = Math.cos(w);
    const coeff = 2 * cosine;
    let q1 = 0, q2 = 0;
    for (let i = 0; i < data.length; i++) {
      const q0 = coeff * q1 - q2 + data[i];
      q2 = q1;
      q1 = q0;
    }
    return Math.sqrt(q1 * q1 + q2 * q2 - q1 * q2 * coeff);
  }

  const stepSamples = Math.floor(sampleRate * 0.005); 
  const syncWindow = Math.floor(sampleRate * 0.05);
  
  let syncStart = -1;
  let maxSyncMag = 0;

  // 1. Search for sync signal (17kHz)
  for (let i = 0; i < Math.min(channelData.length - syncWindow, sampleRate * 5); i += stepSamples) {
    const windowData = channelData.slice(i, i + syncWindow);
    const magSync = goertzel(windowData, freqSync, sampleRate);
    const mag0 = goertzel(windowData, freqZero, sampleRate);
    const mag1 = goertzel(windowData, freqOne,  sampleRate);
    
    if (magSync > maxSyncMag) maxSyncMag = magSync;

    // ★ 閾値を 0.5 まで下げ、さらに条件を緩和 (元コードのコメントに沿うが値は0.05)
    if (magSync > 0.05 && magSync > mag0 * 1.2 && magSync > mag1 * 1.2) {
      syncStart = i + syncWindow;
      console.log(`同期信号検出成功! 強度: ${magSync.toFixed(4)}`);
      break;
    }
  }
  
  if (syncStart !== -1) {
    const bitDuration = 0.025; 
    const samplesPerBit = Math.floor(sampleRate * bitDuration);
    
    // スキャン設定：タイミングを前後15ms、ビット位置をずらして全探索
    const timeShifts = [-10, -5, 0, 5, 10, 15];
    let finalPayload: string | null = null;
    const rsDec = new ReedSolomonGF64(eccLen);

    console.log("=== 堅牢スキャニング・デコード開始 ===");

    outerLoop: for (const tShift of timeShifts) {
      const marginMs = 100;
      const adjustedStart = syncStart + Math.floor(sampleRate * ((tShift + marginMs) / 1000));
      if (adjustedStart < 0) continue;

      const rawBits: number[] = [];
      for (let i = adjustedStart; i < channelData.length - samplesPerBit && rawBits.length < totalBits; i += samplesPerBit) {
        const windowSize = Math.floor(samplesPerBit * 0.5);
        const offset = Math.floor(samplesPerBit * 0.25);
        const windowData = channelData.slice(i + offset, i + offset + windowSize);

        const mag0 = goertzel(windowData, freqZero, sampleRate);
        const mag1 = goertzel(windowData, freqOne,  sampleRate);
        rawBits.push(mag1 > mag0 ? 1 : 0);
      }

      // ビットの読み出し開始位置（0〜5ビット）をずらしながらRSデコードを試す
      for (let bShift = 0; bShift < BITS_PER_SYM; bShift++) {
        const symCount = dataLen + eccLen;
        const shiftedSymbols = new Uint8Array(symCount);
        for (let b = 0; b < totalBits - bShift; b++) {
          const symIdx = Math.floor(b / BITS_PER_SYM);
          const bitIdx = b % BITS_PER_SYM;
          if (symIdx < symCount) {
            shiftedSymbols[symIdx] |= (rawBits[b + bShift] << (BITS_PER_SYM - 1 - bitIdx));
          }
        }
        for (let i = 0; i < symCount; i++) shiftedSymbols[i] &= 0x3F;

        const tryDecode = (target: Uint8Array) => {
          let d = rsDec.decode(target);
          if (!d) d = rsDec.decode(target.map(s => s ^ 0x3F));
          return d;
        };

        const decoded = tryDecode(shiftedSymbols);
        if (decoded) {
          const res = symbolsToBase64url(decoded);

          if (res.startsWith("ORD") || res.length >= 6) {
            console.log(`【🎉 解析成功！】Time:${tShift}ms / BitShift:${bShift} でID復元に成功`);
            finalPayload = res.trim();
            break outerLoop;
          }
        }
      }
    }
    
    if (finalPayload) return finalPayload;
    else {
      console.error("全パターンを走査しましたが、RS符号の修復限界を超えています。");
    }
  }

  return null;
}
