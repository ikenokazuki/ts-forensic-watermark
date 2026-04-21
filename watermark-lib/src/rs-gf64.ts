// Reed-Solomon over GF(64) for Base64url payloads
//
// Motivation: the HMAC payload uses Base64url characters (A-Za-z0-9-_), each of
// which maps to a 6-bit value (0–63). GF(2^6) has exactly 64 elements, so one
// GF(64) symbol = one Base64url character. This eliminates the symbol-boundary
// mismatch present in the GF(256) (8-bit) variant and yields the same correction
// capability with fewer overhead symbols.
//
// Primitive polynomial: x^6 + x + 1 = 0x43 (verified primitive over GF(2))
// Multiplicative group order: 63 (= 2^6 - 1)
// Maximum codeword length:   63 symbols (= 63 Base64url characters)

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const GF_SIZE = 64;   // 2^6
const GF_MAX  = 63;   // 2^6 - 1 (multiplicative group order)
const PRIM_POLY = 0x43; // x^6 + x + 1

/** Convert a Base64url string to a Uint8Array of GF(64) symbols (0–63). */
export function base64urlToSymbols(s: string): Uint8Array {
  const result = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const idx = BASE64URL.indexOf(s[i]);
    if (idx < 0) throw new Error(`Invalid Base64url character: '${s[i]}' at index ${i}`);
    result[i] = idx;
  }
  return result;
}

/** Convert a Uint8Array of GF(64) symbols (0–63) back to a Base64url string. */
export function symbolsToBase64url(syms: Uint8Array): string {
  return Array.from(syms, s => BASE64URL[s]).join('');
}

/**
 * Reed-Solomon codec over GF(2^6).
 *
 * Usage (raw symbols):
 *   const rs = new ReedSolomonGF64(eccLen);
 *   const encoded = rs.encode(dataSymbols);   // Uint8Array, length = data.length + eccLen
 *   const decoded = rs.decode(encodedSymbols); // Uint8Array | null
 *
 * Usage (Base64url strings, convenience):
 *   const encoded = rs.encodeString("TX9901SGVsbG8hV29ybGQ-");
 *   const decoded = rs.decodeString(encoded); // original string or null
 *
 * Constraints:
 *   - All symbol values must be in [0, 63]
 *   - data.length + eccLen ≤ 63 (max GF(64) codeword length)
 *   - Corrects up to floor(eccLen / 2) symbol errors
 */
export class ReedSolomonGF64 {
  private readonly eccLen: number;
  private readonly exp = new Uint8Array(GF_MAX * 2); // wrap-around table (126 entries)
  private readonly log = new Uint8Array(GF_SIZE);    // log table (64 entries)
  private readonly genPoly: Uint8Array;

  constructor(eccLen: number) {
    if (eccLen < 1 || eccLen > GF_MAX - 1) {
      throw new Error(`eccLen must be between 1 and ${GF_MAX - 1}, got ${eccLen}`);
    }
    this.eccLen = eccLen;

    // Build GF(64) exp/log tables using primitive element α = 2
    let x = 1;
    for (let i = 0; i < GF_MAX; i++) {
      this.exp[i] = x;
      this.log[x] = i;
      x <<= 1;
      if (x & GF_SIZE) x ^= PRIM_POLY; // reduce mod x^6 + x + 1
    }
    for (let i = GF_MAX; i < GF_MAX * 2; i++) this.exp[i] = this.exp[i - GF_MAX];

    // Generator polynomial g(x) = ∏_{i=0}^{eccLen-1} (x - α^i)
    this.genPoly = new Uint8Array([1]);
    for (let i = 0; i < eccLen; i++) {
      this.genPoly = this.polyMul(this.genPoly, new Uint8Array([1, this.exp[i]]));
    }
  }

  // --- GF(64) arithmetic ---

  private mul(x: number, y: number): number {
    return (x === 0 || y === 0) ? 0 : this.exp[this.log[x] + this.log[y]];
  }

  private div(x: number, y: number): number {
    return x === 0 ? 0 : this.exp[this.log[x] + GF_MAX - this.log[y]];
  }

  // --- Polynomial operations (big-endian coefficient order, XOR arithmetic) ---

  private polyAdd(p: Uint8Array, q: Uint8Array): Uint8Array {
    const r = new Uint8Array(Math.max(p.length, q.length));
    r.set(p, r.length - p.length);
    for (let i = 0; i < q.length; i++) r[i + r.length - q.length] ^= q[i];
    return r;
  }

  private polyMul(p: Uint8Array, q: Uint8Array): Uint8Array {
    const r = new Uint8Array(p.length + q.length - 1);
    for (let j = 0; j < q.length; j++)
      for (let i = 0; i < p.length; i++)
        r[i + j] ^= this.mul(p[i], q[j]);
    return r;
  }

  private polyEval(p: Uint8Array, x: number): number {
    let y = p[0];
    for (let i = 1; i < p.length; i++) y = this.mul(y, x) ^ p[i];
    return y;
  }

  private polyScale(p: Uint8Array, x: number): Uint8Array {
    const r = new Uint8Array(p.length);
    for (let i = 0; i < p.length; i++) r[i] = this.mul(p[i], x);
    return r;
  }

  // --- Public API ---

  /**
   * Encode: appends eccLen parity symbols to msg.
   * Returns a Uint8Array of length msg.length + eccLen.
   */
  public encode(msg: Uint8Array): Uint8Array {
    if (msg.length + this.eccLen > GF_MAX) {
      throw new Error(`Codeword length ${msg.length + this.eccLen} exceeds GF(64) max of ${GF_MAX}`);
    }
    const padded = new Uint8Array(msg.length + this.eccLen);
    padded.set(msg);
    for (let i = 0; i < msg.length; i++) {
      const coef = padded[i];
      if (coef !== 0) {
        for (let j = 0; j < this.genPoly.length; j++) {
          padded[i + j] ^= this.mul(this.genPoly[j], coef);
        }
      }
    }
    const result = new Uint8Array(msg.length + this.eccLen);
    result.set(msg);
    result.set(padded.subarray(msg.length), msg.length);
    return result;
  }

  /**
   * Decode: corrects up to floor(eccLen/2) symbol errors.
   * Returns the original data symbols (without parity), or null if uncorrectable.
   */
  public decode(msg: Uint8Array): Uint8Array | null {
    // Step 1: Compute syndromes
    const synd = new Uint8Array(this.eccLen);
    let hasErr = false;
    for (let i = 0; i < this.eccLen; i++) {
      synd[i] = this.polyEval(msg, this.exp[i]);
      if (synd[i] !== 0) hasErr = true;
    }
    if (!hasErr) return msg.subarray(0, msg.length - this.eccLen);

    // Step 2: Berlekamp-Massey — find error locator polynomial Λ(x)
    let C = new Uint8Array([1]), B = new Uint8Array([1]), L = 0, m = 1, b = 1;
    for (let i = 0; i < this.eccLen; i++) {
      let d = synd[i];
      for (let j = 1; j <= L; j++) d ^= this.mul(C[C.length - 1 - j], synd[i - j]);
      if (d === 0) {
        m++;
      } else {
        const Bs = new Uint8Array(B.length + m);
        Bs.set(B);
        const scale = this.mul(d, this.div(1, b));
        const T = this.polyAdd(C, scale === 0 ? new Uint8Array(0) : this.polyScale(Bs, scale));
        if (2 * L <= i) { L = i + 1 - L; B = C; b = d; m = 1; } else m++;
        C = T;
      }
    }

    // Step 3: Chien search — find roots of Λ(x) in GF(64)
    const errPos: number[] = [];
    for (let i = 0; i < GF_MAX; i++) {
      if (this.polyEval(C, this.exp[i]) === 0) {
        errPos.push((GF_MAX - i) % GF_MAX);
      }
    }
    if (errPos.length !== L) return null;

    // Step 4: Forney algorithm — compute error magnitudes
    // Generator roots start at α^0 (b=0), so the Forney formula requires
    // multiplying by X_k = α^{errPos}: e_k = X_k · Ω(X_k⁻¹) / Λ'(X_k⁻¹)
    const syndR = new Uint8Array(synd).reverse();
    const omega = this.polyMul(syndR, C).subarray(C.length - 1);
    const Cd = new Uint8Array(Math.max(1, C.length - 1));
    for (let i = 0; i < C.length - 1; i += 2) Cd[Cd.length - 1 - i] = C[C.length - 2 - i];

    const corrected = new Uint8Array(msg);
    for (let i = 0; i < errPos.length; i++) {
      const rootInv = this.exp[errPos[i] === 0 ? 0 : GF_MAX - errPos[i]];
      const pos = corrected.length - 1 - errPos[i];
      if (pos < 0 || pos >= corrected.length) return null;
      const Xk = this.exp[errPos[i]];
      const magnitude = this.mul(
        this.polyEval(omega, rootInv),
        this.div(1, this.polyEval(Cd, rootInv))
      );
      corrected[pos] ^= this.mul(Xk, magnitude);
    }
    return corrected.subarray(0, corrected.length - this.eccLen);
  }

  /**
   * Encode a Base64url string.
   * Returns a longer Base64url string with ECC characters appended.
   *
   * Example (eccLen=8, data length=22):
   *   input:  "TX9901SGVsbG8hV29ybGQ-" (22 chars)
   *   output: "TX9901SGVsbG8hV29ybGQ-XXXXXXXX" (30 chars)
   */
  public encodeString(data: string): string {
    return symbolsToBase64url(this.encode(base64urlToSymbols(data)));
  }

  /**
   * Decode and error-correct a Base64url string (data + ECC).
   * Returns the original data string, or null if the errors are uncorrectable.
   */
  public decodeString(data: string): string | null {
    const decoded = this.decode(base64urlToSymbols(data));
    return decoded !== null ? symbolsToBase64url(decoded) : null;
  }
}
