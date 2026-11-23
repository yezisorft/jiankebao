/**
 * 简课表查看 · 发送课表 / 导入副本（版本化压缩编码与 #schedule= 链接）
 * - JKB1:<base64url>  使用原生 deflate-raw 压缩的 Schema v1 JSON
 * - JKB1U:<base64url> 未压缩 UTF-8 降级编码
 * - 接收端严格限制字符数、压缩输入大小、流式解压累计字节（防解压炸弹），
 *   并在解码后通过 validateRawBackupPayload 严格校验版本与结构。
 */

import { LIMITS, normalizeScheduleData, validateRawBackupPayload } from './model.js';

export const CODE_PREFIX_DEFLATE = 'JKB1:';
export const CODE_PREFIX_PLAIN = 'JKB1U:';
export const LONG_URL_WARN_CHARS = 3500;

function bytesToBase64Url(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const sub = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...sub);
  }
  const base64 = typeof btoa === 'function'
    ? btoa(binary)
    : Buffer.from(bytes).toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(b64url) {
  if (!/^[A-Za-z0-9_-]+$/.test(b64url)) {
    throw new Error('导入码包含非法 Base64URL 字符。');
  }
  const padded = b64url.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64url.length + 3) % 4);
  if (typeof atob === 'function') {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
  return new Uint8Array(Buffer.from(padded, 'base64'));
}

async function compressDeflateRaw(bytes) {
  if (typeof CompressionStream === 'undefined') return null;
  const cs = new CompressionStream('deflate-raw');
  const writer = cs.writable.getWriter();
  const writePromise = writer.write(bytes).then(() => writer.close());
  const chunks = [];
  const reader = cs.readable.getReader();
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  await writePromise;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * 流式解压并实时限制累计输出字节，超过 maxBytes 立即取消读取并报错（防御 deflate 解压炸弹）
 */
async function decompressDeflateRawWithLimit(bytes, maxBytes = LIMITS.MAX_DECOMPRESSED_BYTES) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('当前浏览器不支持 deflate-raw 解压，请改用 JSON 备份文件恢复。');
  }
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();

  // 并发写入与流式读取，避免大流背压死锁
  const writePromise = (async () => {
    try {
      await writer.write(bytes);
      await writer.close();
    } catch {
      // 当 reader 因超限主动 cancel 时，writer 报错属正常中止
    }
  })();

  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel('decompressed_limit_exceeded');
        throw new Error(`导入码解压后体积超过安全上限（最大 ${Math.round(maxBytes / 1024)} KB），已中止解析。`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
    await writePromise;
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export async function encodeTransferCode(data, options = {}) {
  const { forceUncompressed = false } = options;
  const normalized = normalizeScheduleData(data);
  const json = JSON.stringify(normalized);
  const rawBytes = new TextEncoder().encode(json);

  // 发送端采用与接收端完全一致的硬上限，避免生成接收端必定拒收的导入码
  if (rawBytes.length > LIMITS.MAX_DECOMPRESSED_BYTES) {
    return {
      ok: false,
      reason: 'payload_too_large',
      rawBytes: rawBytes.length,
      encodedChars: 0,
      error: `当前课表体积（${Math.ceil(rawBytes.length / 1024)} KB）超过导入码上限（${Math.round(LIMITS.MAX_DECOMPRESSED_BYTES / 1024)} KB），请改用「导出完整 JSON 备份」文件传输。`
    };
  }

  let code = '';
  let compressed = false;

  if (!forceUncompressed) {
    try {
      const compBytes = await compressDeflateRaw(rawBytes);
      if (compBytes && compBytes.length < rawBytes.length) {
        code = `${CODE_PREFIX_DEFLATE}${bytesToBase64Url(compBytes)}`;
        compressed = true;
      }
    } catch {
      // 降级到未压缩格式
    }
  }

  if (!code) {
    code = `${CODE_PREFIX_PLAIN}${bytesToBase64Url(rawBytes)}`;
    compressed = false;
  }

  if (code.length > LIMITS.MAX_TRANSFER_CODE_CHARS) {
    return {
      ok: false,
      reason: 'code_too_long',
      compressed,
      rawBytes: rawBytes.length,
      encodedChars: code.length,
      error: `生成的导入码长度（${code.length} 字符）超过接收端安全上限（${LIMITS.MAX_TRANSFER_CODE_CHARS} 字符），无法通过导入码恢复，请直接导出完整 JSON 备份文件。`
    };
  }

  return {
    ok: true,
    code,
    compressed,
    rawBytes: rawBytes.length,
    encodedChars: code.length,
    warnLongUrl: code.length > LONG_URL_WARN_CHARS
  };
}

export function extractScheduleCode(input) {
  if (typeof input !== 'string') return null;
  if (input.length > LIMITS.MAX_TRANSFER_CODE_CHARS + 1024) {
    return { tooLong: true };
  }
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith(CODE_PREFIX_DEFLATE) || trimmed.startsWith(CODE_PREFIX_PLAIN)) {
    return trimmed;
  }

  const hashMatch = trimmed.match(/#schedule=([A-Za-z0-9:%_-]+)/);
  if (hashMatch) {
    try {
      return decodeURIComponent(hashMatch[1]);
    } catch {
      return null;
    }
  }

  return null;
}

export async function decodeTransferCode(input, options = {}) {
  const maxDecompressedBytes = options.maxDecompressedBytes ?? LIMITS.MAX_DECOMPRESSED_BYTES;
  const extracted = extractScheduleCode(input);

  if (extracted && typeof extracted === 'object' && extracted.tooLong) {
    return {
      ok: false,
      error: `导入码或链接长度超过安全上限（最大 ${LIMITS.MAX_TRANSFER_CODE_CHARS} 字符），请改用 JSON 备份文件。`
    };
  }

  const code = extracted;
  if (!code) {
    return {
      ok: false,
      error: '未识别到有效的课表导入码（应以 JKB1: 或 JKB1U: 开头，或包含 #schedule=）。'
    };
  }

  if (code.length > LIMITS.MAX_TRANSFER_CODE_CHARS) {
    return {
      ok: false,
      error: `导入码字符数超过安全上限（${code.length} > ${LIMITS.MAX_TRANSFER_CODE_CHARS}），已拒绝解析。`
    };
  }

  try {
    let jsonBytes;
    if (code.startsWith(CODE_PREFIX_DEFLATE)) {
      const payload = code.slice(CODE_PREFIX_DEFLATE.length);
      const compressedBytes = base64UrlToBytes(payload);
      if (compressedBytes.byteLength > LIMITS.MAX_TRANSFER_CODE_CHARS) {
        return { ok: false, error: '压缩载荷大小超过安全上限，已中止解析。' };
      }
      jsonBytes = await decompressDeflateRawWithLimit(compressedBytes, maxDecompressedBytes);
    } else if (code.startsWith(CODE_PREFIX_PLAIN)) {
      const payload = code.slice(CODE_PREFIX_PLAIN.length);
      jsonBytes = base64UrlToBytes(payload);
      if (jsonBytes.byteLength > maxDecompressedBytes) {
        return {
          ok: false,
          error: `导入码体积超过安全上限（最大 ${Math.round(maxDecompressedBytes / 1024)} KB），已中止解析。`
        };
      }
    } else {
      return { ok: false, error: '不支持的导入码版本前缀。' };
    }

    const jsonText = new TextDecoder().decode(jsonBytes);
    const parsed = JSON.parse(jsonText);

    // 严格先校验原始备份 Schema 与版本，再交给统一导入管线
    const validation = validateRawBackupPayload(parsed);
    if (!validation.ok) {
      return { ok: false, error: validation.error };
    }

    return {
      ok: true,
      raw: parsed,
      data: validation.normalized,
      droppedIssues: validation.droppedIssues
    };
  } catch (err) {
    return {
      ok: false,
      error: `导入码解码失败：${err.message}`
    };
  }
}

export function buildScheduleShareUrl(currentHref, code) {
  const cleanBase = String(currentHref || '').split('#')[0];
  return `${cleanBase}#schedule=${code}`;
}
