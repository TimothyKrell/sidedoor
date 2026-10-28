import { htmlToText } from '../text'

/** Plain text from an uploaded resume: PDF (text layer), DOCX, HTML, Markdown or text. */
export const extractText = async (name: string, buf: Buffer): Promise<string> => {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  const isPdf = ext === 'pdf' || buf.subarray(0, 5).toString('latin1') === '%PDF-'
  if (isPdf) {
    const { extractText: pdfText, getDocumentProxy } = await import('unpdf')
    const doc = await getDocumentProxy(new Uint8Array(buf))
    const { text } = await pdfText(doc, { mergePages: true })
    const t = (Array.isArray(text) ? text.join('\n') : text).trim()
    if (t.length < 50) throw new Error('That PDF has no readable text (it may be a scan). Export it again as a text PDF, or paste the text.')
    return t
  }
  if (ext === 'docx') {
    const mammoth = (await import('mammoth')).default
    return (await mammoth.extractRawText({ buffer: buf })).value.trim()
  }
  if (ext === 'doc') throw new Error('Old .doc files are not supported. Save it as .docx or PDF first.')
  const s = buf.toString('utf8')
  return ext === 'html' || ext === 'htm' || /^\s*<(!doctype|html)/i.test(s) ? htmlToText(s) : s.trim()
}
