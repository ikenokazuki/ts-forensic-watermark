import express from "express";
import crypto from "crypto";
import Jimp from "jimp";
// @ts-ignore
import { embedForensic, extractForensic, extractVideoForensic } from "../src/forensic";
// @ts-ignore
import { createMp4UuidBox } from "../src/utils";

/**
 * This is an example of how to use the ts-forensic-watermark library
 * in an Express.js application, integrating with Jimp and FFmpeg.
 * 
 * Note: This file is just an example and is not part of the core library
 * to keep the library dependency-free.
 */

export const extractWatermarkHandler = async (req: express.Request, res: express.Response) => {
  const isVideo = req.body.isVideo === 'true';
  // @ts-ignore
  let buffer = req.file!.buffer;

  // Remove text watermark appended at the end to prevent Jimp read errors
  const marker = Buffer.from('\n---WATERMARK_START---');
  const markerIdx = buffer.indexOf(marker);
  if (markerIdx !== -1) {
    buffer = buffer.subarray(0, markerIdx);
  }

  const image = await Jimp.read(buffer);
  
  let result = null;
  
  // The library expects an object with { data, width, height }
  // Jimp's image.bitmap perfectly matches this interface!
  const imageData = {
    data: new Uint8ClampedArray(image.bitmap.data),
    width: image.bitmap.width,
    height: image.bitmap.height
  };

  if (isVideo) {
    result = extractVideoForensic(imageData);
  } else {
    result = extractForensic(imageData, 120);
    
    if (!result || result.payload === 'RECOVERY_FAILED' || result.payload === '') {
      const fallbackResult = extractForensic(imageData, 60);
      if (fallbackResult && fallbackResult.confidence > (result?.confidence || 0)) {
        result = fallbackResult;
      }
    }
  }

  const isSuccess = result && result.payload !== 'RECOVERY_FAILED' && result.payload !== '';
  res.json({ 
    success: isSuccess, 
    watermark: isSuccess ? { 
      type: 'FORENSIC', 
      data: { sessionId: result.payload }, 
      confidence: result.confidence 
    } : null 
  });
};
