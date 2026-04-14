// 1. 彫りの深さ
const DEFAULT_DELTA = 120; 

// 2. 埋め込む面積の広さ
const DEFAULT_VARIANCE_THRESHOLD = 25; 

// 3. Arnold変換の反復回数 (空間スクランブルの強度)
const DEFAULT_ARNOLD_ITER = 7;

export interface ForensicOptions {
  /** 彫りの深さ (デフォルト: 120)。高くすると圧縮に強くなりますがノイズが増えます。 */
  delta?: number;
  /** 埋め込む面積の広さ (デフォルト: 25)。低くすると平坦な部分にも埋め込みますがノイズが目立ちます。 */
  varianceThreshold?: number;
  /** Arnold変換の反復回数 (デフォルト: 7)。空間スクランブルの強度。抽出時も同じ値が必要です。 */
  arnoldIterations?: number;
  /** 強制埋め込み/抽出フラグ (分散やSVDの閾値を無視します) */
  force?: boolean;
}

// ==========================================

export class ReedSolomon {
  private eccLen: number;
  private exp = new Uint8Array(512);
  private log = new Uint8Array(256);
  private genPoly: Uint8Array;

  constructor(eccLen: number) {
    this.eccLen = eccLen;
    let x = 1;
    for (let i = 0; i < 255; i++) {
      this.exp[i] = x; this.log[x] = i;
      x <<= 1; if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) this.exp[i] = this.exp[i - 255];
    this.genPoly = new Uint8Array([1]);
    for (let i = 0; i < eccLen; i++) this.genPoly = this.polyMul(this.genPoly, new Uint8Array([1, this.exp[i]]));
  }

  private mul(x: number, y: number) { return (x === 0 || y === 0) ? 0 : this.exp[this.log[x] + this.log[y]]; }
  private div(x: number, y: number) { return x === 0 ? 0 : this.exp[this.log[x] + 255 - this.log[y]]; }
  private polyAdd(p: Uint8Array, q: Uint8Array) {
    let r = new Uint8Array(Math.max(p.length, q.length));
    r.set(p, r.length - p.length);
    for (let i = 0; i < q.length; i++) r[i + r.length - q.length] ^= q[i];
    return r;
  }
  private polyMul(p: Uint8Array, q: Uint8Array) {
    let r = new Uint8Array(p.length + q.length - 1);
    for (let j = 0; j < q.length; j++) for (let i = 0; i < p.length; i++) r[i + j] ^= this.mul(p[i], q[j]);
    return r;
  }
  private polyEval(p: Uint8Array, x: number) {
    let y = p[0];
    for (let i = 1; i < p.length; i++) y = this.mul(y, x) ^ p[i];
    return y;
  }

  public encode(msg: Uint8Array): Uint8Array {
    let padded = new Uint8Array(msg.length + this.eccLen);
    padded.set(msg);
    for (let i = 0; i < msg.length; i++) {
      let coef = padded[i];
      if (coef !== 0) for (let j = 0; j < this.genPoly.length; j++) padded[i + j] ^= this.mul(this.genPoly[j], coef);
    }
    let result = new Uint8Array(msg.length + this.eccLen);
    result.set(msg); result.set(padded.subarray(msg.length), msg.length);
    return result;
  }

  public decode(msg: Uint8Array): Uint8Array | null {
    let synd = new Uint8Array(this.eccLen), hasErr = false;
    for (let i = 0; i < this.eccLen; i++) {
      synd[i] = this.polyEval(msg, this.exp[i]);
      if (synd[i] !== 0) hasErr = true;
    }
    if (!hasErr) return msg.subarray(0, msg.length - this.eccLen);

    let C = new Uint8Array([1]), B = new Uint8Array([1]), L = 0, m = 1, b = 1;
    for (let i = 0; i < this.eccLen; i++) {
      let d = synd[i];
      for (let j = 1; j <= L; j++) d ^= this.mul(C[C.length - 1 - j], synd[i - j]);
      if (d === 0) m++;
      else {
        let B_s = new Uint8Array(B.length + m); B_s.set(B);
        let T = this.polyAdd(C, this.mul(d, this.div(1, b)) === 0 ? new Uint8Array(0) : this.polyScale(B_s, this.mul(d, this.div(1, b))));
        if (2 * L <= i) { L = i + 1 - L; B = C; b = d; m = 1; } else m++;
        C = T;
      }
    }
    let errPos: number[] = [];
    for (let i = 0; i < 255; i++) if (this.polyEval(C, this.exp[i]) === 0) errPos.push(255 - i);
    if (errPos.length !== L) return null;

    let syndR = new Uint8Array(synd).reverse(), omega = this.polyMul(syndR, C).subarray(C.length - 1);
    let C_d = new Uint8Array(Math.max(1, C.length - 1));
    for(let i=0; i<C.length-1; i+=2) C_d[C_d.length - 1 - i] = C[C.length - 2 - i];

    let corrected = new Uint8Array(msg);
    for (let i = 0; i < errPos.length; i++) {
      let rootInv = this.exp[255 - errPos[i]], pos = corrected.length - 1 - errPos[i];
      if (pos < 0 || pos >= corrected.length) return null; 
      corrected[pos] ^= this.mul(this.polyEval(omega, rootInv), this.div(1, this.polyEval(C_d, rootInv)));
    }
    return corrected.subarray(0, corrected.length - this.eccLen);
  }
  private polyScale(p: Uint8Array, x: number) {
    let r = new Uint8Array(p.length);
    for (let i = 0; i < p.length; i++) r[i] = this.mul(p[i], x);
    return r;
  }
}

const MARKER = [1, 0, 1, 0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0, 1];
const ARNOLD_DIM = 20;
const TOTAL_BITS = ARNOLD_DIM * ARNOLD_DIM; // 400
const DATA_LEN = 22; 
const ECC_LEN = 26;  

const rs = new ReedSolomon(ECC_LEN);

function getTargetBitIndex(bx: number, by: number, blocksX: number): number {
  return (by * blocksX + bx) % TOTAL_BITS;
}

function applyArnold(bits: Uint8Array, iter: number): Uint8Array {
  let curr = new Uint8Array(bits), next = new Uint8Array(TOTAL_BITS);
  for (let i = 0; i < iter; i++) {
    for (let y = 0; y < ARNOLD_DIM; y++) for (let x = 0; x < ARNOLD_DIM; x++) {
      next[((x + 2 * y) % ARNOLD_DIM) * ARNOLD_DIM + ((x + y) % ARNOLD_DIM)] = curr[y * ARNOLD_DIM + x];
    }
    curr.set(next);
  }
  return curr;
}

function inverseArnold(bits: Uint8Array, iter: number): Uint8Array {
  let curr = new Uint8Array(bits), next = new Uint8Array(TOTAL_BITS);
  for (let i = 0; i < iter; i++) {
    for (let y = 0; y < ARNOLD_DIM; y++) for (let x = 0; x < ARNOLD_DIM; x++) {
      let nx = (2 * x - y) % ARNOLD_DIM; if (nx < 0) nx += ARNOLD_DIM;
      let ny = (-x + y) % ARNOLD_DIM; if (ny < 0) ny += ARNOLD_DIM;
      next[ny * ARNOLD_DIM + nx] = curr[y * ARNOLD_DIM + x];
    }
    curr.set(next);
  }
  return curr;
}

function dwt2(block: Float32Array) {
  const LL = new Float32Array(16), HL = new Float32Array(16), LH = new Float32Array(16), HH = new Float32Array(16);
  for(let y=0; y<4; y++) for(let x=0; x<4; x++){
    let a = block[(y*2)*8 + (x*2)], b = block[(y*2)*8 + (x*2+1)], c = block[(y*2+1)*8 + (x*2)], d = block[(y*2+1)*8 + (x*2+1)];
    LL[y*4+x] = (a+b+c+d)/2; HL[y*4+x] = (a-b+c-d)/2; LH[y*4+x] = (a+b-c-d)/2; HH[y*4+x] = (a-b-c+d)/2;
  }
  return { LL, HL, LH, HH };
}

function idwt2(LL: Float32Array, HL: Float32Array, LH: Float32Array, HH: Float32Array, out: Float32Array) {
  for(let y=0; y<4; y++) for(let x=0; x<4; x++){
    let ll = LL[y*4+x], hl = HL[y*4+x], lh = LH[y*4+x], hh = HH[y*4+x];
    out[(y*2)*8 + (x*2)] = (ll+hl+lh+hh)/2; out[(y*2)*8 + (x*2+1)] = (ll-hl+lh-hh)/2;
    out[(y*2+1)*8 + (x*2)] = (ll+hl-lh-hh)/2; out[(y*2+1)*8 + (x*2+1)] = (ll-hl-lh+hh)/2;
  }
}

function dct2(block: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let u = 0; u < 4; u++) {
    for (let v = 0; v < 4; v++) {
      let sum = 0;
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) {
          sum += block[y * 4 + x] * 
                 Math.cos(((2 * x + 1) * v * Math.PI) / 8) * 
                 Math.cos(((2 * y + 1) * u * Math.PI) / 8);
        }
      }
      const cu = u === 0 ? 1 / Math.SQRT2 : 1;
      const cv = v === 0 ? 1 / Math.SQRT2 : 1;
      out[u * 4 + v] = 0.5 * cu * cv * sum;
    }
  }
  return out;
}

function idct2(block: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      let sum = 0;
      for (let u = 0; u < 4; u++) {
        for (let v = 0; v < 4; v++) {
          const cu = u === 0 ? 1 / Math.SQRT2 : 1;
          const cv = v === 0 ? 1 / Math.SQRT2 : 1;
          sum += cu * cv * block[u * 4 + v] * 
                 Math.cos(((2 * x + 1) * v * Math.PI) / 8) * 
                 Math.cos(((2 * y + 1) * u * Math.PI) / 8);
        }
      }
      out[y * 4 + x] = 0.5 * sum;
    }
  }
  return out;
}

function jacobiSVD(A: Float32Array) {
  const n = 4; let V = new Float32Array(n * n), U = new Float32Array(A), S = new Float32Array(n);
  for (let i = 0; i < n; i++) V[i * n + i] = 1.0;
  for (let iter = 0; iter < 20; iter++) {
    let changed = false;
    for (let i = 0; i < n - 1; i++) for (let j = i + 1; j < n; j++) {
      let p = 0, q = 0, r = 0;
      for (let k = 0; k < n; k++) { p += U[k * n + i] * U[k * n + i]; q += U[k * n + j] * U[k * n + j]; r += U[k * n + i] * U[k * n + j]; }
      if (Math.abs(r) > 1e-5) {
        changed = true; let theta = 0.5 * Math.atan2(2 * r, p - q), c = Math.cos(theta), s = Math.sin(theta);
        for (let k = 0; k < n; k++) {
          let u_ki = U[k * n + i], u_kj = U[k * n + j];
          U[k * n + i] = c * u_ki + s * u_kj; U[k * n + j] = -s * u_ki + c * u_kj;
          let v_ki = V[k * n + i], v_kj = V[k * n + j];
          V[k * n + i] = c * v_ki + s * v_kj; V[k * n + j] = -s * v_ki + c * v_kj;
        }
      }
    }
    if (!changed) break;
  }
  for (let i = 0; i < n; i++) {
    let norm = 0; for (let k = 0; k < n; k++) norm += U[k * n + i] * U[k * n + i];
    S[i] = Math.sqrt(norm);
    if (S[i] > 1e-6) for (let k = 0; k < n; k++) U[k * n + i] /= S[i];
    else { S[i] = 0; for (let k = 0; k < n; k++) U[k * n + i] = (k === i) ? 1 : 0; }
  }
  for (let i = 0; i < n - 1; i++) for (let j = i + 1; j < n; j++) if (S[i] < S[j]) {
    let temp = S[i]; S[i] = S[j]; S[j] = temp;
    for (let k = 0; k < n; k++) {
      temp = U[k * n + i]; U[k * n + i] = U[k * n + j]; U[k * n + j] = temp;
      temp = V[k * n + i]; V[k * n + i] = V[k * n + j]; V[k * n + j] = temp;
    }
  }
  return { U, S, V };
}

function reconstructSVD(U: Float32Array, S: Float32Array, V: Float32Array, out: Float32Array) {
  for(let y=0; y<4; y++) for(let x=0; x<4; x++){
    let sum = 0; for(let k=0; k<4; k++) sum += U[y*4+k] * S[k] * V[x*4+k];
    out[y*4+x] = sum;
  }
}

export interface ImageDataLike {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

export function embedForensic(imageData: ImageDataLike, payload: string, options?: ForensicOptions) {
  const { data, width, height } = imageData;
  
  const delta = options?.delta ?? DEFAULT_DELTA;
  const varianceThreshold = options?.varianceThreshold ?? DEFAULT_VARIANCE_THRESHOLD;
  const arnoldIter = options?.arnoldIterations ?? DEFAULT_ARNOLD_ITER;
  const force = options?.force ?? false;
  
  // ペイロードをDATA_LENバイトに固定
  const rawBytes = new Uint8Array(DATA_LEN);
  for (let i = 0; i < Math.min(payload.length, DATA_LEN); i++) {
    rawBytes[i] = payload.charCodeAt(i);
  }
  
  const encodedBytes = rs.encode(rawBytes); 

  const bitMatrix = new Uint8Array(TOTAL_BITS); bitMatrix.set(MARKER, 0);
  for (let i = 0; i < encodedBytes.length; i++) for (let j = 0; j < 8; j++) bitMatrix[MARKER.length + i * 8 + j] = (encodedBytes[i] >> (7 - j)) & 1;
  
  const scrambledBits = applyArnold(bitMatrix, arnoldIter);
  const blocksX = Math.floor(width / 8), blocksY = Math.floor(height / 8), totalBlocks = blocksX * blocksY;
  const blockIn = new Float32Array(64);

  for (let bitIdx = 0; bitIdx < totalBlocks; bitIdx++) {
    const bx = bitIdx % blocksX, by = Math.floor(bitIdx / blocksX);
    let sumY = 0, sumY2 = 0;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const idx = ((by * 8 + y) * width + (bx * 8 + x)) * 4;
      const yVal = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
      blockIn[y * 8 + x] = yVal; sumY += yVal; sumY2 += yVal * yVal;
    }
    const meanY = sumY / 64, variance = (sumY2 / 64) - (meanY * meanY);
    
    // ★ ここでvarianceThresholdを使用 (forceがtrueの場合はスキップしない)
    if (!force && (meanY > 240 || meanY < 15 || variance < varianceThreshold)) continue; 

    const bit = scrambledBits[getTargetBitIndex(bx, by, blocksX)];
    const { LL, HL, LH, HH } = dwt2(blockIn);
    
    // Apply DCT to HL and LH
    const DCT_HL = dct2(HL);
    const DCT_LH = dct2(LH);
    
    // Embed in HL
    const { U: U_HL, S: S_HL, V: V_HL } = jacobiSVD(DCT_HL);
    if (force || S_HL[0] >= 5) {
      const d = bit === 1 ? delta * 0.75 : delta * 0.25;
      let s0 = Math.round((S_HL[0] - d) / delta) * delta + d;
      if (s0 < 0) s0 = d;
      S_HL[0] = s0;
      if (S_HL[1] > S_HL[0]) {
        let scale = Math.max(0, S_HL[0] - 0.1) / (S_HL[1] + 1e-5);
        S_HL[1] *= scale; S_HL[2] *= scale; S_HL[3] *= scale;
      }
      reconstructSVD(U_HL, S_HL, V_HL, DCT_HL);
    }

    // Embed in LH (Dual-Band QIM for extreme JPEG robustness)
    const { U: U_LH, S: S_LH, V: V_LH } = jacobiSVD(DCT_LH);
    if (force || S_LH[0] >= 5) {
      const d = bit === 1 ? delta * 0.75 : delta * 0.25;
      let s0 = Math.round((S_LH[0] - d) / delta) * delta + d;
      if (s0 < 0) s0 = d;
      S_LH[0] = s0;
      if (S_LH[1] > S_LH[0]) {
        let scale = Math.max(0, S_LH[0] - 0.1) / (S_LH[1] + 1e-5);
        S_LH[1] *= scale; S_LH[2] *= scale; S_LH[3] *= scale;
      }
      reconstructSVD(U_LH, S_LH, V_LH, DCT_LH);
    }

    // Inverse DCT
    const iDCT_HL = idct2(DCT_HL);
    const iDCT_LH = idct2(DCT_LH);

    idwt2(LL, iDCT_HL, iDCT_LH, HH, blockIn);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const idx = ((by * 8 + y) * width + (bx * 8 + x)) * 4;
      const deltaY = blockIn[y * 8 + x] - (0.299 * data[idx] + 0.587 * data[idx+1] + 0.114 * data[idx+2]);
      data[idx] = Math.max(0, Math.min(255, Math.round(data[idx] + deltaY)));
      data[idx+1] = Math.max(0, Math.min(255, Math.round(data[idx+1] + deltaY)));
      data[idx+2] = Math.max(0, Math.min(255, Math.round(data[idx+2] + deltaY)));
    }
  }
}

// --- Video Spread Spectrum ---
// A robust spatial spread spectrum method for video

function getPseudoRandomPattern(width: number, height: number, cellSize: number = 2): Float32Array {
  const pattern = new Float32Array(width * height);
  let seed = 123456789;
  const cellsX = Math.ceil(width / cellSize);
  const cellsY = Math.ceil(height / cellSize);
  
  for (let cy = 0; cy < cellsY; cy++) {
    for (let cx = 0; cx < cellsX; cx++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const val = (seed & 0x80000000) ? 1 : -1;
      
      for (let y = 0; y < cellSize; y++) {
        for (let x = 0; x < cellSize; x++) {
          const px = cx * cellSize + x;
          const py = cy * cellSize + y;
          if (px < width && py < height) {
            pattern[py * width + px] = val;
          }
        }
      }
    }
  }
  return pattern;
}

export function generateVideoPattern(width: number, height: number, payload: string, strength: number = 4.0, options?: ForensicOptions): { data: Uint8ClampedArray, width: number, height: number } {
  const arnoldIter = options?.arnoldIterations ?? DEFAULT_ARNOLD_ITER;
  
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 128; data[i+1] = 128; data[i+2] = 128; data[i+3] = 255;
  }

  const rawBytes = new Uint8Array(DATA_LEN);
  for (let i = 0; i < Math.min(payload.length, DATA_LEN); i++) {
    rawBytes[i] = payload.charCodeAt(i);
  }
  const encodedBytes = rs.encode(rawBytes); 
  const bitMatrix = new Uint8Array(TOTAL_BITS); bitMatrix.set(MARKER, 0);
  for (let i = 0; i < encodedBytes.length; i++) for (let j = 0; j < 8; j++) bitMatrix[MARKER.length + i * 8 + j] = (encodedBytes[i] >> (7 - j)) & 1;
  const scrambledBits = applyArnold(bitMatrix, arnoldIter);

  const blocksX = 20, blocksY = 20;
  const blockW = Math.floor(width / blocksX);
  const blockH = Math.floor(height / blocksY);
  
  const fullPattern = getPseudoRandomPattern(width, height, 4);

  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const bitIdx = by * blocksX + bx;
      const bit = scrambledBits[bitIdx];
      const sign = bit === 1 ? 1 : -1;
      
      for (let y = 0; y < blockH; y++) {
        for (let x = 0; x < blockW; x++) {
          const px = bx * blockW + x;
          const py = by * blockH + y;
          const idx = (py * width + px) * 4;
          
          // ブロックの境界を目立たなくするための滑らかなウィンドウ関数 (Sine window)
          const wx = Math.sin(Math.PI * x / blockW);
          const wy = Math.sin(Math.PI * y / blockH);
          const window = wx * wy;
          
          const val = sign * fullPattern[py * width + px] * strength * window;
          
          data[idx] = Math.max(0, Math.min(255, Math.round(128 + val)));
          data[idx+1] = Math.max(0, Math.min(255, Math.round(128 + val)));
          data[idx+2] = Math.max(0, Math.min(255, Math.round(128 + val)));
        }
      }
    }
  }
  
  return { data, width, height };
}

export function extractVideoForensic(imageData: ImageDataLike, options?: ForensicOptions): { payload: string, confidence: number, debug?: any } | null {
  const arnoldIter = options?.arnoldIterations ?? DEFAULT_ARNOLD_ITER;
  
  const { data, width, height } = imageData;
  const blocksX = 20, blocksY = 20;
  const blockW = Math.floor(width / blocksX);
  const blockH = Math.floor(height / blocksY);
  
  const fullPattern = getPseudoRandomPattern(width, height, 4);
  const extractedScrambled = new Uint8Array(TOTAL_BITS);
  let totalCorrelation = 0;

  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      let meanY = 0;
      let weightSum = 0;
      for (let y = 0; y < blockH; y++) {
        for (let x = 0; x < blockW; x++) {
          const px = bx * blockW + x;
          const py = by * blockH + y;
          const idx = (py * width + px) * 4;
          
          const wx = Math.sin(Math.PI * x / blockW);
          const wy = Math.sin(Math.PI * y / blockH);
          const window = wx * wy;
          
          meanY += (0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2]) * window;
          weightSum += window;
        }
      }
      meanY /= weightSum;

      let correlation = 0;
      for (let y = 0; y < blockH; y++) {
        for (let x = 0; x < blockW; x++) {
          const px = bx * blockW + x;
          const py = by * blockH + y;
          const idx = (py * width + px) * 4;
          const yVal = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
          
          const wx = Math.sin(Math.PI * x / blockW);
          const wy = Math.sin(Math.PI * y / blockH);
          const window = wx * wy;
          
          correlation += (yVal - meanY) * fullPattern[py * width + px] * window;
        }
      }
      const bitIdx = by * blocksX + bx;
      extractedScrambled[bitIdx] = correlation > 0 ? 1 : 0;
      totalCorrelation += Math.abs(correlation);
    }
  }

  const extractedBits = inverseArnold(extractedScrambled, arnoldIter);
  let markerMatch = 0;
  for (let i = 0; i < MARKER.length; i++) if (extractedBits[i] === MARKER[i]) markerMatch++;
  const markerScore = (markerMatch / MARKER.length) * 100;

  const extractedBytes = new Uint8Array(DATA_LEN + ECC_LEN);
  for (let i = 0; i < extractedBytes.length; i++) {
    let charCode = 0;
    for (let j = 0; j < 8; j++) charCode = (charCode << 1) | extractedBits[MARKER.length + i * 8 + j];
    extractedBytes[i] = charCode;
  }

  const decodedBytes = rs.decode(extractedBytes);
  if (!decodedBytes) return { payload: "RECOVERY_FAILED", confidence: markerScore, debug: { markerScore, extractedBytes: Array.from(extractedBytes), decodedBytes: null } };

  let result = '';
  for (let i = 0; i < decodedBytes.length; i++) {
    if (decodedBytes[i] === 0) break; 
    result += String.fromCharCode(decodedBytes[i]);
  }

  return { payload: result, confidence: Math.min(99.9, markerScore), debug: { markerScore, extractedBytes: Array.from(extractedBytes), decodedBytes: Array.from(decodedBytes) } };
}

export function generateSpreadSpectrumPattern(width: number, height: number, payload: string, strength: number = 0.2, options?: ForensicOptions): { data: Uint8ClampedArray, width: number, height: number } {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 128;
    data[i+1] = 128;
    data[i+2] = 128;
    data[i+3] = 255;
  }
  
  const imgData = { data, width, height };
  embedForensic(imgData, payload, { ...options, force: true }); // force=true
  
  // Scale the delta around 128 by the strength factor
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 128 + (data[i] - 128) * strength;
    data[i+1] = 128 + (data[i+1] - 128) * strength;
    data[i+2] = 128 + (data[i+2] - 128) * strength;
  }
  
  return imgData;
}

export function extractForensic(imageData: ImageDataLike, options?: ForensicOptions): { payload: string, confidence: number, debug?: any } | null {
  const { data, width, height } = imageData;
  const blocksX = Math.floor(width / 8), blocksY = Math.floor(height / 8), totalBlocks = blocksX * blocksY;
  if (totalBlocks < TOTAL_BITS) return null;

  const effectiveDelta = options?.delta ?? DEFAULT_DELTA;
  const varianceThreshold = options?.varianceThreshold ?? DEFAULT_VARIANCE_THRESHOLD;
  const arnoldIter = options?.arnoldIterations ?? DEFAULT_ARNOLD_ITER;
  const force = options?.force ?? false;

  const bitSums = new Float32Array(TOTAL_BITS), blockIn = new Float32Array(64);
  let processedBlocks = 0;
  for (let bitIdx = 0; bitIdx < totalBlocks; bitIdx++) {
    const bx = bitIdx % blocksX, by = Math.floor(bitIdx / blocksX);
    let sumY = 0, sumY2 = 0;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const idx = ((by * 8 + y) * width + (bx * 8 + x)) * 4;
      const yVal = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
      blockIn[y * 8 + x] = yVal; sumY += yVal; sumY2 += yVal * yVal;
    }
    const meanY = sumY / 64, variance = (sumY2 / 64) - (meanY * meanY);
    
    // 抽出時はマージンを持たせるために少し緩い閾値を使用
    if (!force && (meanY > 245 || meanY < 10 || variance < Math.max(10, varianceThreshold - 20))) continue; 
    processedBlocks++;

    const { HL, LH } = dwt2(blockIn); 
    const DCT_HL = dct2(HL);
    const DCT_LH = dct2(LH);
    const { S: S_HL } = jacobiSVD(DCT_HL);
    const { S: S_LH } = jacobiSVD(DCT_LH);
    
    const weightHL = Math.min(1.0, S_HL[0] / (effectiveDelta * 0.5));
    const softValHL = -Math.sin(2 * Math.PI * S_HL[0] / effectiveDelta);

    const weightLH = Math.min(1.0, S_LH[0] / (effectiveDelta * 0.5));
    const softValLH = -Math.sin(2 * Math.PI * S_LH[0] / effectiveDelta);
    
    bitSums[getTargetBitIndex(bx, by, blocksX)] += (softValHL * weightHL) + (softValLH * weightLH);
  }

  const extractedScrambled = new Uint8Array(TOTAL_BITS);
  let totalStrength = 0;
  for (let i = 0; i < TOTAL_BITS; i++) {
    extractedScrambled[i] = bitSums[i] > 0 ? 1 : 0;
    totalStrength += Math.abs(bitSums[i]);
  }

  const extractedBits = inverseArnold(extractedScrambled, arnoldIter);
  let markerMatch = 0;
  for (let i = 0; i < MARKER.length; i++) if (extractedBits[i] === MARKER[i]) markerMatch++;
  const markerScore = (markerMatch / MARKER.length) * 100;
  
  // デバッグ用に、スコアが低くても抽出を試みる
  // if (markerScore < 45) return null; 

  const strengthScore = Math.min(100, ((totalStrength / TOTAL_BITS) / ((totalBlocks / TOTAL_BITS) * 0.15)) * 100);
  let confidence = (markerScore * 0.6) + (strengthScore * 0.4);
  if (markerScore < 100) confidence *= Math.pow(markerScore / 100, 3);

  const extractedBytes = new Uint8Array(DATA_LEN + ECC_LEN);
  for (let i = 0; i < extractedBytes.length; i++) {
    let charCode = 0;
    for (let j = 0; j < 8; j++) charCode = (charCode << 1) | extractedBits[MARKER.length + i * 8 + j];
    extractedBytes[i] = charCode;
  }

  const decodedBytes = rs.decode(extractedBytes);
  if (!decodedBytes) return { payload: "RECOVERY_FAILED", confidence: markerScore, debug: { markerScore, extractedBytes: Array.from(extractedBytes), decodedBytes: null } };

  let result = '';
  for (let i = 0; i < decodedBytes.length; i++) {
    if (decodedBytes[i] === 0) break; 
    result += String.fromCharCode(decodedBytes[i]);
  }

  return { payload: result, confidence: Math.min(99.9, markerScore), debug: { markerScore, processedBlocks, totalBlocks, extractedBytes: Array.from(extractedBytes), decodedBytes: Array.from(decodedBytes) } };
}
