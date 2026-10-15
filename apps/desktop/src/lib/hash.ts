/** 32-bit FNV-1a of a string's UTF-16 code units: short, stable names, not security. */
export function fnv1a(text: string) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193)
  return hash >>> 0
}
