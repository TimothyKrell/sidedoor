export type DiffPart = { type: 'same' | 'add' | 'del'; text: string }

/** Word-level diff (LCS over words and whitespace runs). Fine for emails and cover letters. */
export function wordDiff(a: string, b: string): DiffPart[] {
  const A = a.split(/(\s+)/).filter((t) => t !== '')
  const B = b.split(/(\s+)/).filter((t) => t !== '')
  const n = A.length
  const m = B.length
  if (n * m > 4_000_000) return [{ type: 'del', text: a }, { type: 'add', text: b }]
  const w = m + 1
  const L = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) L[i * w + j] = A[i] === B[j] ? L[(i + 1) * w + j + 1]! + 1 : Math.max(L[(i + 1) * w + j]!, L[i * w + j + 1]!)
  const out: DiffPart[] = []
  const push = (type: DiffPart['type'], text: string) => {
    const last = out[out.length - 1]
    if (last?.type === type) last.text += text
    else out.push({ type, text })
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      push('same', A[i]!)
      i++
      j++
    } else if (L[(i + 1) * w + j]! >= L[i * w + j + 1]!) push('del', A[i++]!)
    else push('add', B[j++]!)
  }
  while (i < n) push('del', A[i++]!)
  while (j < m) push('add', B[j++]!)
  return out
}
