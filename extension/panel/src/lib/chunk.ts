// Splitting a chat into small pieces ("chunks") so code can pick the relevant ones.
import type { PageMessage } from '../../../../shared/types';

export interface Chunk {
  /** Position in the whole chat, 0-based. */
  id: number;
  /** Index of the message this chunk came from. */
  msg: number;
  role: PageMessage['role'];
  /** 1-based part number within its message, and how many parts that message has. */
  part: number;
  parts: number;
  text: string;
}

export const CHUNK_TARGET = 900;
export const CHUNK_MAX = 1400;

export const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Cuts text at paragraph breaks, then sentences, then (last resort) mid-text. */
export function splitText(text: string, target = CHUNK_TARGET, max = CHUNK_MAX): string[] {
  const pieces: string[] = [];
  for (const para of text.split(/\n\s*\n/)) {
    const p = para.trim();
    if (!p) continue;
    if (p.length <= max) {
      pieces.push(p);
      continue;
    }
    // Paragraph too long: sentences (or lines), then hard cuts.
    for (const s of p.split(/(?<=[.!?])\s+|\n/)) {
      let rest = s.trim();
      while (rest.length > max) {
        pieces.push(rest.slice(0, max));
        rest = rest.slice(max);
      }
      if (rest) pieces.push(rest);
    }
  }

  // Pack small pieces together until a chunk is about `target` long.
  const out: string[] = [];
  let current = '';
  for (const piece of pieces) {
    if (current && current.length + piece.length + 2 > max) {
      out.push(current);
      current = '';
    }
    current = current ? `${current}\n\n${piece}` : piece;
    if (current.length >= target) {
      out.push(current);
      current = '';
    }
  }
  if (current) out.push(current);
  return out;
}

export function chunkChat(messages: PageMessage[]): Chunk[] {
  const chunks: Chunk[] = [];
  messages.forEach((m, msg) => {
    const parts = splitText(m.text);
    parts.forEach((text, i) => {
      chunks.push({ id: chunks.length, msg, role: m.role, part: i + 1, parts: parts.length, text });
    });
  });
  return chunks;
}

/** Shortens text by cutting the middle: the start and the end usually matter most. */
export function trimMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = '\n…[middle left out]…\n';
  const keep = Math.max(0, max - marker.length);
  const head = Math.ceil(keep * 0.6);
  return text.slice(0, head) + marker + text.slice(text.length - (keep - head));
}

/** Small stable hash, used as the cache key for a chunk's embedding. */
export function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(36)}-${text.length.toString(36)}`;
}

export const roleName = (role: PageMessage['role']) =>
  role === 'user' ? 'User' : role === 'assistant' ? 'Assistant' : 'Page text';
