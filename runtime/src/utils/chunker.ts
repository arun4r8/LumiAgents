// Recursive character text splitter — no Node deps, pure string ops.

export interface Chunk {
  index: number;
  content: string;
}

const SEPARATORS = ["\n\n", "\n", ". ", " ", ""];

export function chunkText(
  text: string,
  chunkSize = 1200,
  overlap = 200,
): Chunk[] {
  const chunks: string[] = splitRecursive(text, chunkSize, SEPARATORS);
  const overlapped = applyOverlap(chunks, overlap);
  return overlapped.map((content, index) => ({ index, content: content.trim() })).filter((c) => c.content.length > 50);
}

function splitRecursive(text: string, maxSize: number, separators: string[]): string[] {
  if (text.length <= maxSize) return [text];

  const [sep, ...restSeps] = separators;

  if (sep === undefined || sep === "") {
    // Force split at maxSize
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += maxSize) {
      chunks.push(text.slice(i, i + maxSize));
    }
    return chunks;
  }

  const parts = text.split(sep);
  const merged: string[] = [];
  let current = "";

  for (const part of parts) {
    const candidate = current ? current + sep + part : part;
    if (candidate.length <= maxSize) {
      current = candidate;
    } else {
      if (current) merged.push(current);
      // If single part is still too large, recurse with next separator
      if (part.length > maxSize) {
        merged.push(...splitRecursive(part, maxSize, restSeps));
        current = "";
      } else {
        current = part;
      }
    }
  }

  if (current) merged.push(current);
  return merged;
}

function applyOverlap(chunks: string[], overlap: number): string[] {
  if (overlap <= 0 || chunks.length <= 1) return chunks;

  return chunks.map((chunk, i) => {
    if (i === 0) return chunk;
    const prev = chunks[i - 1] ?? "";
    const suffix = prev.slice(-overlap);
    return suffix + " " + chunk;
  });
}
