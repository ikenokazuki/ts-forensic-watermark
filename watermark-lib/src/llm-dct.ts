/**
 * LLM (Loeffler–Ligtenberg–Moschytz) DCT-domain video watermark.
 *
 * パフォーマンス最適化（TypeScript向け推奨事項に準拠）：
 *  - 1-D バタフライ演算を完全展開（for ループゼロ）
 *  - 回転定数は private static readonly 相当のモジュール定数として事前計算
 *    （実行時に Math.cos / Math.sqrt を一切呼び出さない）
 *  - 8×8 ブロックは Float32Array(64) の1次元バッファ；
 *    インデックスは (row << 3) | col のビットシフトで計算
 */

import { ReedSolomonGF64, base64urlToSymbols, symbolsToBase64url } from './rs-gf64';
import type { ImageDataLike } from './forensic';

// ─── 事前計算済み LLM 定数（実行時演算なし） ──────────────────────────────────
// 順変換バタフライ
const LLM_C4      = 0.7071067811865476;  // cos(4π/16) = 1/√2
const LLM_C6      = 0.3826834323650898;  // cos(6π/16)
const LLM_C2mC6   = 0.5411961001341842;  // cos(2π/16) − cos(6π/16)
const LLM_C2pC6   = 1.3065629648763766;  // cos(2π/16) + cos(6π/16)
// 逆変換バタフライ
const LLM_SQRT2   = 1.4142135623730951;  // √2 = 2·cos(4π/16)
const LLM_2C2     = 1.8477590650225735;  // 2·cos(2π/16)
const LLM_2C2m2C6 = 1.0823922002683685;  // 2·(cos(2π/16) − cos(6π/16))
const LLM_2C2p2C6 = 2.6131259297527527;  // 2·(cos(2π/16) + cos(6π/16))
// idct2d(fdct2d(x)) = x * IDCT_SCALE を補正するスカラー (= 1/(8×8))
const IDCT_SCALE  = 1 / 64;

// ─── 1-D 8 点順変換 LLM DCT（完全展開：乗算 5 回、加減算 29 回） ─────────────
// b: Float32Array, o: 先頭オフセット, s: 要素間ストライド
function fdct1d(b: Float32Array, o: number, s: number): void {
  const i0=o,   i1=o+s,   i2=o+2*s, i3=o+3*s,
        i4=o+4*s, i5=o+5*s, i6=o+6*s, i7=o+7*s;
  // ステージ 1：加減算のみ
  const t0=b[i0]+b[i7], t7=b[i0]-b[i7];
  const t1=b[i1]+b[i6], t6=b[i1]-b[i6];
  const t2=b[i2]+b[i5], t5=b[i2]-b[i5];
  const t3=b[i3]+b[i4], t4=b[i3]-b[i4];
  // 偶数部
  const e0=t0+t3, e3=t0-t3, e1=t1+t2, e2=t1-t2;
  b[i0]=e0+e1; b[i4]=e0-e1;
  const z1=(e2+e3)*LLM_C4;                      // 乗算 ×1
  b[i2]=e3+z1; b[i6]=e3-z1;
  // 奇数部（乗算 ×4）
  const oo0=t4+t5, oo1=t5+t6, oo2=t6+t7;
  const z5=(oo0-oo2)*LLM_C6;
  const z2=LLM_C2mC6*oo0+z5, z4=LLM_C2pC6*oo2+z5, z3=oo1*LLM_C4;
  const z11=t7+z3, z13=t7-z3;
  b[i5]=z13+z2; b[i3]=z13-z2; b[i1]=z11+z4; b[i7]=z11-z4;
}

// ─── 1-D 8 点逆変換 LLM DCT（完全展開：乗算 5 回） ─────────────────────────
function idct1d(b: Float32Array, o: number, s: number): void {
  const i0=o,   i1=o+s,   i2=o+2*s, i3=o+3*s,
        i4=o+4*s, i5=o+5*s, i6=o+6*s, i7=o+7*s;
  // 偶数部（乗算 ×1）
  const e10=b[i0]+b[i4], e11=b[i0]-b[i4];
  const e13=b[i2]+b[i6], e12=(b[i2]-b[i6])*LLM_SQRT2-e13;
  const p0=e10+e13, p3=e10-e13, p1=e11+e12, p2=e11-e12;
  // 奇数部（乗算 ×4）
  const z13=b[i5]+b[i3], z10=b[i5]-b[i3];
  const z11=b[i1]+b[i7], z12=b[i1]-b[i7];
  const q7=z11+z13, q11=(z11-z13)*LLM_SQRT2;
  const z5=(z10+z12)*LLM_2C2;
  const q10=z12*LLM_2C2m2C6-z5, q12=z10*(-LLM_2C2p2C6)+z5;
  const q6=q12-q7, q5=q11-q6, q4=q10+q5;
  b[i0]=p0+q7; b[i7]=p0-q7;
  b[i1]=p1+q6; b[i6]=p1-q6;
  b[i2]=p2+q5; b[i5]=p2-q5;
  b[i4]=p3+q4; b[i3]=p3-q4;
}

// ─── 2-D 8×8 順変換 DCT（全 16 呼び出しをアンロール） ───────────────────────
// 行 → 列 の順
function fdct2d(b: Float32Array): void {
  fdct1d(b, 0,1); fdct1d(b, 8,1); fdct1d(b,16,1); fdct1d(b,24,1);
  fdct1d(b,32,1); fdct1d(b,40,1); fdct1d(b,48,1); fdct1d(b,56,1);
  fdct1d(b,0,8);  fdct1d(b,1,8);  fdct1d(b,2,8);  fdct1d(b,3,8);
  fdct1d(b,4,8);  fdct1d(b,5,8);  fdct1d(b,6,8);  fdct1d(b,7,8);
}

// ─── 2-D 8×8 逆変換 DCT（全 16 呼び出しをアンロール） ───────────────────────
// 列 → 行 の順（順変換の逆）
function idct2d(b: Float32Array): void {
  idct1d(b,0,8);  idct1d(b,1,8);  idct1d(b,2,8);  idct1d(b,3,8);
  idct1d(b,4,8);  idct1d(b,5,8);  idct1d(b,6,8);  idct1d(b,7,8);
  idct1d(b, 0,1); idct1d(b, 8,1); idct1d(b,16,1); idct1d(b,24,1);
  idct1d(b,32,1); idct1d(b,40,1); idct1d(b,48,1); idct1d(b,56,1);
}

// ─── 共通定数（forensic.ts と同一仕様） ───────────────────────────────────────
const MARKER = [1,0,1,0,1,0,1,0,0,1,0,1,0,1,0,1] as const;
const ARNOLD_DIM = 20;
const TOTAL_BITS = ARNOLD_DIM * ARNOLD_DIM; // 400
const BITS_PER_SYM = 6;
const DEFAULT_PAYLOAD_SYMBOLS = 22;

function applyArnold(bits: Uint8Array, iter: number): Uint8Array {
  let curr = new Uint8Array(bits), next = new Uint8Array(TOTAL_BITS);
  for (let i = 0; i < iter; i++) {
    for (let y = 0; y < ARNOLD_DIM; y++) for (let x = 0; x < ARNOLD_DIM; x++)
      next[((x + 2*y) % ARNOLD_DIM) * ARNOLD_DIM + ((x + y) % ARNOLD_DIM)] = curr[y * ARNOLD_DIM + x];
    curr.set(next);
  }
  return curr;
}

function inverseArnold(bits: Uint8Array, iter: number): Uint8Array {
  let curr = new Uint8Array(bits), next = new Uint8Array(TOTAL_BITS);
  for (let i = 0; i < iter; i++) {
    for (let y = 0; y < ARNOLD_DIM; y++) for (let x = 0; x < ARNOLD_DIM; x++) {
      let nx = (2*x - y) % ARNOLD_DIM; if (nx < 0) nx += ARNOLD_DIM;
      let ny = (-x + y) % ARNOLD_DIM;  if (ny < 0) ny += ARNOLD_DIM;
      next[ny * ARNOLD_DIM + nx] = curr[y * ARNOLD_DIM + x];
    }
    curr.set(next);
  }
  return curr;
}

// ─── 公開インターフェース ─────────────────────────────────────────────────────
export interface LlmVideoOptions {
  /**
   * QIM 量子化ステップ (デフォルト: 300)。
   * 大きいほど H.264/H.265 圧縮への耐性が上がりますが、輝度変化が大きくなります。
   * 目安: 圧縮なし=100, 中程度=300（推奨）, 強圧縮対策=500
   */
  quantStep?: number;
  /**
   * 埋め込み先の DCT 係数位置（行, デフォルト: 2）。
   * 0=DC, 1〜3=低周波, 4〜6=中周波（推奨）, 7=高周波（非推奨）
   */
  coeffRow?: number;
  /**
   * 埋め込み先の DCT 係数位置（列, デフォルト: 1）。
   */
  coeffCol?: number;
  /**
   * Arnold 変換の反復回数 (デフォルト: 7)。
   * 埋め込み時と抽出時で必ず同じ値を使用してください。
   */
  arnoldIterations?: number;
  /**
   * データシンボル数 (デフォルト: 22、範囲: 1〜62)。
   * GF(64) コードワード 63 シンボルから残りが ECC になります。
   * ForensicOptions の payloadSymbols と同じトレードオフです。
   */
  payloadSymbols?: number;
  /**
   * analyzeLlmImageWatermarks 使用時に試行する回転角度リスト（デフォルト: [0]）。
   * 各角度で画像を回転させて抽出を試み、最初に成功した結果を返します。
   * ForensicOptions の robustAngles と同様に機能します。
   * 例: [0, 90, 180, 270, 0.5, -0.5]
   */
  robustAngles?: number[];
}

// ─── 埋め込み ─────────────────────────────────────────────────────────────────
/**
 * LLM DCT ドメインで動画フレーム（ImageDataLike）に透かしを埋め込みます。
 * Y チャンネルの 8×8 ブロック DCT 係数に QIM を適用し、
 * 全ブロックにビットを循環埋め込み（多重冗長）します。
 *
 * @param imageData 書き込み可能な RGBA フレームデータ
 * @param payload   埋め込むペイロード文字列（Base64url）
 * @param options   LlmVideoOptions
 */
export function embedLlmVideoFrame(
  imageData: ImageDataLike,
  payload: string,
  options?: LlmVideoOptions
): void {
  const { data, width, height } = imageData;
  const Q          = options?.quantStep        ?? 300;
  const coeffRow   = options?.coeffRow         ?? 2;
  const coeffCol   = options?.coeffCol         ?? 1;
  const arnoldIter = options?.arnoldIterations ?? 7;
  const dataLen    = Math.max(1, Math.min(62, options?.payloadSymbols ?? DEFAULT_PAYLOAD_SYMBOLS));
  const eccLen     = 63 - dataLen;
  const rsInst     = new ReedSolomonGF64(eccLen);
  const coeffIdx   = (coeffRow << 3) | coeffCol; // ビットシフトインデックス

  // ペイロード → RS符号化 → Arnold スクランブル → ビット配列
  const padded = payload.length >= dataLen
    ? payload.slice(0, dataLen)
    : payload + 'A'.repeat(dataLen - payload.length);
  const encoded = rsInst.encode(base64urlToSymbols(padded));
  const bitMatrix = new Uint8Array(TOTAL_BITS);
  bitMatrix.set(MARKER, 0);
  for (let i = 0; i < encoded.length; i++)
    for (let j = 0; j < BITS_PER_SYM; j++)
      bitMatrix[MARKER.length + i * BITS_PER_SYM + j] = (encoded[i] >> (BITS_PER_SYM - 1 - j)) & 1;
  const scrambled = applyArnold(bitMatrix, arnoldIter);

  const blocksX = width  >> 3; // Math.floor(width / 8)
  const blocksY = height >> 3;
  const block   = new Float32Array(64);

  for (let blockIdx = 0, total = blocksX * blocksY; blockIdx < total; blockIdx++) {
    const bx  = blockIdx % blocksX;
    const by  = (blockIdx / blocksX) | 0;
    const bit = scrambled[blockIdx % TOTAL_BITS];

    // Y チャンネルを Float32Array(64) に取り込む（ビットシフトインデックス使用）
    for (let r = 0; r < 8; r++) {
      const rowBase = ((by << 3) + r) * width + (bx << 3);
      for (let c = 0; c < 8; c++) {
        const px = (rowBase + c) << 2;
        block[(r << 3) | c] = 0.299 * data[px] + 0.587 * data[px+1] + 0.114 * data[px+2];
      }
    }

    // 順変換 LLM 2D DCT
    fdct2d(block);

    // QIM 埋め込み（指定係数位置）
    const raw = block[coeffIdx];
    const q   = Math.round(raw / Q);
    block[coeffIdx] = q * Q + (bit === 1 ? Q * 0.75 : Q * 0.25);

    // 逆変換 LLM 2D DCT + スケール補正（÷64）
    idct2d(block);

    // 差分を RGB に加算してクランプ
    for (let r = 0; r < 8; r++) {
      const rowBase = ((by << 3) + r) * width + (bx << 3);
      for (let c = 0; c < 8; c++) {
        const px   = (rowBase + c) << 2;
        const origY = 0.299 * data[px] + 0.587 * data[px+1] + 0.114 * data[px+2];
        const newY  = Math.max(0, Math.min(255, block[(r << 3) | c] * IDCT_SCALE));
        const dY    = newY - origY;
        data[px]   = Math.max(0, Math.min(255, (data[px]   + dY + 0.5) | 0));
        data[px+1] = Math.max(0, Math.min(255, (data[px+1] + dY + 0.5) | 0));
        data[px+2] = Math.max(0, Math.min(255, (data[px+2] + dY + 0.5) | 0));
      }
    }
  }
}

// ─── 抽出 ─────────────────────────────────────────────────────────────────────
/**
 * LLM DCT ドメインから透かしを抽出します。
 * 各ビット位置に対応する全ブロックの係数をソフト集計し、
 * Reed-Solomon で誤り訂正してペイロードを復元します。
 *
 * @returns payload と confidence（マーカー一致率 0〜100）、失敗時は null
 */
export function extractLlmVideoFrame(
  imageData: ImageDataLike,
  options?: LlmVideoOptions
): { payload: string; confidence: number } | null {
  const { data, width, height } = imageData;
  const Q          = options?.quantStep        ?? 300;
  const coeffRow   = options?.coeffRow         ?? 2;
  const coeffCol   = options?.coeffCol         ?? 1;
  const arnoldIter = options?.arnoldIterations ?? 7;
  const dataLen    = Math.max(1, Math.min(62, options?.payloadSymbols ?? DEFAULT_PAYLOAD_SYMBOLS));
  const eccLen     = 63 - dataLen;
  const rsInst     = new ReedSolomonGF64(eccLen);
  const coeffIdx   = (coeffRow << 3) | coeffCol;

  const blocksX  = width  >> 3;
  const blocksY  = height >> 3;
  const block    = new Float32Array(64);
  // ビットごとのソフト決定値を累積（正 → 1, 負 → 0）
  const softBits = new Float32Array(TOTAL_BITS);

  for (let blockIdx = 0, total = blocksX * blocksY; blockIdx < total; blockIdx++) {
    const bx = blockIdx % blocksX;
    const by = (blockIdx / blocksX) | 0;

    for (let r = 0; r < 8; r++) {
      const rowBase = ((by << 3) + r) * width + (bx << 3);
      for (let c = 0; c < 8; c++) {
        const px = (rowBase + c) << 2;
        block[(r << 3) | c] = 0.299 * data[px] + 0.587 * data[px+1] + 0.114 * data[px+2];
      }
    }

    fdct2d(block);

    // ソフト QIM 判定: mod を [-Q/2, Q/2) にマップして累積
    const val = block[coeffIdx];
    const mod = ((val % Q) + Q) % Q;
    softBits[blockIdx % TOTAL_BITS] += mod - Q * 0.5;
  }

  // ハード決定
  const scrambled = new Uint8Array(TOTAL_BITS);
  for (let i = 0; i < TOTAL_BITS; i++) scrambled[i] = softBits[i] > 0 ? 1 : 0;

  const bits = inverseArnold(scrambled, arnoldIter);

  // マーカー一致率（信頼度）
  let markerMatch = 0;
  for (let i = 0; i < MARKER.length; i++) if (bits[i] === MARKER[i]) markerMatch++;
  const confidence = (markerMatch / MARKER.length) * 100;

  // シンボル再構成
  const symbols = new Uint8Array(dataLen + eccLen);
  for (let i = 0; i < symbols.length; i++) {
    let sym = 0;
    for (let j = 0; j < BITS_PER_SYM; j++)
      sym = (sym << 1) | bits[MARKER.length + i * BITS_PER_SYM + j];
    symbols[i] = sym & 0x3F;
  }

  const decoded = rsInst.decode(symbols);
  if (!decoded) return null;

  return { payload: symbolsToBase64url(decoded), confidence };
}
