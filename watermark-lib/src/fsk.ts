import { ReedSolomon } from './forensic';

export interface FskOptions {
  sampleRate?: number;
  bitDuration?: number;
  syncDuration?: number;
  marginDuration?: number;
  amplitude?: number;
  freqZero?: number;
  freqOne?: number;
  freqSync?: number;
}

const DATA_LEN = 22;
const ECC_LEN = 8;
const rs = new ReedSolomon(ECC_LEN);

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
  const amplitude = options?.amplitude || 2000; 
  
  const samplesPerBit = Math.floor(sampleRate * bitDuration);
  const syncSamples = Math.floor(sampleRate * syncDuration);
  const marginSamples = Math.floor(sampleRate * marginDuration);

  // Payload processing
  const dataBytes = new Uint8Array(DATA_LEN);
  const encoder = new TextEncoder();
  const encoded = encoder.encode(payload.padEnd(DATA_LEN, '\0'));
  dataBytes.set(encoded.slice(0, DATA_LEN));
  
  const interleaved = rs.encode(dataBytes); // 30 bytes (240 bits)
  const totalSamples = syncSamples + marginSamples + (240 * samplesPerBit);
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

  // 1. 同期音 (17000Hz)
  for (let i = 0; i < syncSamples; i++) {
    const val = Math.sin(phase) * amplitude;
    dataView.setInt16(44 + i * 2, Math.floor(val), true);
    phase += 2 * Math.PI * 17000 / sampleRate; // 次の位相を計算
  }

  // 2. ★ 隙間 (0.1秒間、0を書き込む)
  for (let i = 0; i < marginSamples; i++) {
    dataView.setInt16(44 + (syncSamples + i) * 2, 0, true);
  }

  // 3. データビット (18000Hz or 19000Hz)
  let currentPos = syncSamples + marginSamples;
  for (let i = 0; i < 240; i++) {
    const byteIdx = Math.floor(i / 8);
    const bitIdx = i % 8;
    const bit = (interleaved[byteIdx] >> (7 - bitIdx)) & 1;
    const freq = bit === 1 ? 19000 : 18000;
    
    for (let s = 0; s < samplesPerBit; s++) {
      const val = Math.sin(2 * Math.PI * freq * s / sampleRate) * amplitude;
      dataView.setInt16(44 + (currentPos + s) * 2, Math.floor(val), true);
      phase += 2 * Math.PI * freq / sampleRate; // ★ここが重要：周波数が変わっても波を繋げる
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
  const freqZero = options?.freqZero || 18000;
  const freqOne = options?.freqOne || 19000;
  const freqSync = options?.freqSync || 17000;

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
    const magSync = goertzel(windowData, 17000, sampleRate);
    const mag0 = goertzel(windowData, 18000, sampleRate);
    const mag1 = goertzel(windowData, 19000, sampleRate);
    
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
    
    // スキャン設定：タイミングを前後15ms、ビット位置を0〜7ビットずらして全探索
    const timeShifts = [-10, -5, 0, 5, 10, 15]; // ms単位の候補
    let finalPayload: string | null = null;
    const rsDec = new ReedSolomon(8);

    console.log("=== 超堅牢スキャニング・デコード開始 ===");

    outerLoop: for (const tShift of timeShifts) {
      const marginMs = 100;
      const adjustedStart = syncStart + Math.floor(sampleRate * ((tShift + marginMs) / 1000));
      if (adjustedStart < 0) continue;

      // 1. まずビットの生配列（0/1の羅列）を作る
      const rawBits: number[] = [];
      for (let i = adjustedStart; i < channelData.length - samplesPerBit && rawBits.length < 240; i += samplesPerBit) {
        const windowSize = Math.floor(samplesPerBit * 0.5);
        const offset = Math.floor(samplesPerBit * 0.25);
        const windowData = channelData.slice(i + offset, i + offset + windowSize);
        
        const mag0 = goertzel(windowData, 18000, sampleRate);
        const mag1 = goertzel(windowData, 19000, sampleRate);
        rawBits.push(mag1 > mag0 ? 1 : 0);
      }

      // 2. ビットの読み出し開始位置（0〜7ビット）をずらしながらRSデコードを試す
      for (let bShift = 0; bShift < 8; bShift++) {
        const shiftedBytes = new Uint8Array(30);
        for (let b = 0; b < 240 - bShift; b++) {
          const byteIdx = Math.floor(b / 8);
          const bitIdx = b % 8;
          if (byteIdx < 30) {
            shiftedBytes[byteIdx] |= (rawBits[b + bShift] << (7 - bitIdx));
          }
        }

        const tryDecode = (targetBytes: Uint8Array) => {
          let d = rsDec.decode(targetBytes);
          if (!d) d = rsDec.decode(targetBytes.map(b => b ^ 0xFF)); // 反転試行
          return d;
        };

        const decoded = tryDecode(shiftedBytes);
        if (decoded) {
          let res = '';
          for (let j = 0; j < decoded.length; j++) {
            if (decoded[j] === 0) break;
            res += String.fromCharCode(decoded[j]);
          }
          
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
