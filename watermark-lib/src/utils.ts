export const WATERMARK_UUID_HEX = "d41d8cd98f00b204e9800998ecf8427e";

/**
 * Creates an MP4 UUID box containing the watermark data.
 * This is dependency-free and uses standard Uint8Array.
 */
export function createMp4UuidBox(data: Uint8Array): Uint8Array {
  const size = 8 + 16 + data.length;
  const box = new Uint8Array(size);
  const view = new DataView(box.buffer);
  
  // size (4 bytes)
  view.setUint32(0, size, false);
  
  // 'uuid' (4 bytes)
  box[4] = 'u'.charCodeAt(0);
  box[5] = 'u'.charCodeAt(0);
  box[6] = 'i'.charCodeAt(0);
  box[7] = 'd'.charCodeAt(0);
  
  // uuid hex to bytes (16 bytes)
  for (let i = 0; i < 16; i++) {
    box[8 + i] = parseInt(WATERMARK_UUID_HEX.substring(i * 2, i * 2 + 2), 16);
  }
  
  // data
  box.set(data, 24);
  
  return box;
}

/**
 * Generates a payload string formatted for H.264 SEI (Supplemental Enhancement Information) user_data_unregistered.
 * This string can be passed to FFmpeg's h264_metadata bitstream filter.
 * 
 * @param uuidHex A 32-character hex string representing the UUID (e.g., '086f3693b7b34f2c965321492feee5b8')
 * @param payload The string payload (e.g., JSON metadata) to embed
 * @returns A formatted string ready for FFmpeg (e.g., '086f3693b7b34f2c965321492feee5b8+eyJ1c2VySWQi...=')
 */
export function generateH264SeiPayload(uuidHex: string, payload: string): string {
  const cleanUuid = uuidHex.replace(/-/g, '').toLowerCase();
  if (cleanUuid.length !== 32) {
    throw new Error("UUID must be a 32-character hex string");
  }
  
  // Base64url encode the payload without using Node's Buffer
  const encoder = new TextEncoder();
  const payloadBytes = encoder.encode(payload);
  
  // Convert Uint8Array to binary string
  let binaryString = "";
  for (let i = 0; i < payloadBytes.length; i++) {
    binaryString += String.fromCharCode(payloadBytes[i]);
  }
  
  // Standard base64
  const base64 = btoa(binaryString);
  
  // Convert to base64url format
  const base64url = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  
  return `${cleanUuid}+${base64url}`;
}

/**
 * Appends a text watermark to the End Of File (EOF/EOE).
 * Useful for appending JSON metadata to images or audio files.
 */
export function appendEofWatermark(fileBuffer: Uint8Array, payload: string): Uint8Array {
  const encoder = new TextEncoder();
  const wmBuf = encoder.encode(`\n---WATERMARK_START---\n${payload}\n---WATERMARK_END---\n`);
  const result = new Uint8Array(fileBuffer.length + wmBuf.length);
  result.set(fileBuffer);
  result.set(wmBuf, fileBuffer.length);
  return result;
}

/**
 * Extracts a text watermark from the End Of File (EOF/EOE).
 */
export function extractEofWatermark(fileBuffer: Uint8Array): string | null {
  const decoder = new TextDecoder();
  // Decode only the last 4096 bytes for performance if the file is large
  const tailLength = Math.min(fileBuffer.length, 4096);
  const tailBuffer = fileBuffer.subarray(fileBuffer.length - tailLength);
  const text = decoder.decode(tailBuffer);
  
  const startMarker = '\n---WATERMARK_START---\n';
  const endMarker = '\n---WATERMARK_END---\n';
  
  const startIdx = text.lastIndexOf(startMarker);
  const endIdx = text.lastIndexOf(endMarker);
  
  if (startIdx !== -1 && endIdx !== -1 && startIdx < endIdx) {
    return text.substring(startIdx + startMarker.length, endIdx);
  }
  return null;
}

/**
 * Helper to get the Web Crypto API subtle object in both Browser and Node.js environments.
 */
function getSubtleCrypto(): SubtleCrypto {
  if (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle) {
    return globalThis.crypto.subtle;
  }
  throw new Error("Web Crypto API is not available in this environment.");
}

/**
 * Generates an HMAC-SHA256 hex string for a given message and secret.
 * Uses native Web Crypto API (Zero Dependency).
 */
export async function generateHmacSha256(message: string, secret: string): Promise<string> {
  const subtle = getSubtleCrypto();
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const messageData = encoder.encode(message);
  
  const cryptoKey = await subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  
  const signature = await subtle.sign('HMAC', cryptoKey, messageData);
  return Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Generates a 22-byte secure payload (ID + HMAC).
 * Used for highly constrained forensic watermarks.
 * @param id The ID to embed
 * @param secret The secret key for HMAC
 * @param idLength The length of the ID (default: 6). The remaining bytes (22 - idLength) will be used for HMAC.
 */
export async function generateSecurePayload(id: string, secret: string, idLength: number = 6): Promise<string> {
  const idStr = id.substring(0, idLength).padEnd(idLength, '0');
  const fullHmac = await generateHmacSha256(idStr, secret);
  const hmacLength = 22 - idLength;
  const shortHmac = fullHmac.substring(0, hmacLength);
  return `${idStr}${shortHmac}`;
}

/**
 * Verifies a 22-byte secure payload (ID + HMAC).
 * @param payload The 22-byte payload to verify
 * @param secret The secret key for HMAC
 * @param idLength The length of the ID (default: 6).
 */
export async function verifySecurePayload(payload: string, secret: string, idLength: number = 6): Promise<boolean> {
  if (payload.length !== 22) return false;
  
  const id = payload.substring(0, idLength);
  const providedHmac = payload.substring(idLength);
  
  const fullHmac = await generateHmacSha256(id, secret);
  const expectedHmac = fullHmac.substring(0, 22 - idLength);
    
  return providedHmac === expectedHmac;
}

/**
 * Signs a JSON metadata object by generating an HMAC over specified fields.
 * Returns a new object with the 'signature' field appended.
 */
export async function signJsonMetadata(
  metadata: Record<string, any>, 
  secret: string, 
  signFields: string[] = ['userId', 'sessionId', 'prizeId', 'timestamp']
): Promise<Record<string, any>> {
  const signData = signFields.map(f => metadata[f]).join(':');
  const signature = await generateHmacSha256(signData, secret);
  return { ...metadata, signature };
}

/**
 * Verifies the signature of a JSON metadata object.
 */
export async function verifyJsonSignature(
  metadata: Record<string, any>, 
  secret: string, 
  signFields: string[] = ['userId', 'sessionId', 'prizeId', 'timestamp']
): Promise<boolean> {
  if (!metadata || !metadata.signature) return false;
  const signData = signFields.map(f => metadata[f]).join(':');
  const expectedSignature = await generateHmacSha256(signData, secret);
  return metadata.signature === expectedSignature;
}
