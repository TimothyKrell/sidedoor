// Resume themes. Every theme renders the same markup (so the editor, notes and match highlights
// work identically across themes); a theme is a stylesheet plus a little header decoration.
// Output is a complete HTML document sized for print (letter or A4), with `data-id` on each line
// and `data-edit` on lines that can be edited in place.
import type { Company, Highlight, ResumeContent, Section, ThemeOptions } from './resume'

export interface ResumeTheme {
  id: string
  name: string
  description: string
  /** Default accent color. */
  accent: string
  fonts?: string
  css: (accent: string) => string
  decoration?: string
}

const esc = (s: string | undefined | null) =>
  (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * Inline HTML allowlist for line text: strong/b/em/i/u/br/span(class)/a(href http(s)/mailto).
 * Works as a tokenizer, not a find-and-replace: every "<" that doesn't start a complete, allowed
 * tag is escaped, so an unclosed `<img src=x onerror=…` becomes text instead of an element.
 */
const ALLOWED = new Set(['strong', 'b', 'em', 'i', 'u', 'br', 'span', 'a'])
const TAG = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z-]+(?:\s*=\s*(?:"[^"<>]*"|'[^'<>]*'))?)*)\s*\/?>/
export function sanitizeInline(html: string): string {
  const src = html ?? ''
  let out = ''
  let i = 0
  while (i < src.length) {
    const lt = src.indexOf('<', i)
    if (lt === -1) {
      out += src.slice(i).replace(/>/g, '&gt;')
      break
    }
    out += src.slice(i, lt).replace(/>/g, '&gt;')
    const m = TAG.exec(src.slice(lt))
    if (!m) {
      out += '&lt;'
      i = lt + 1
      continue
    }
    i = lt + m[0].length
    const closing = m[1] === '/'
    const name = m[2]!.toLowerCase()
    const attrs = m[3] ?? ''
    if (!ALLOWED.has(name)) continue
    if (closing) {
      if (name !== 'br') out += `</${name}>`
      continue
    }
    if (name === 'a') {
      const href = attrs.match(/href\s*=\s*(?:"([^"]*)"|'([^']*)')/i)
      const url = (href?.[1] ?? href?.[2] ?? '').trim()
      out += /^(https?:|mailto:)/i.test(url) ? `<a href="${esc(url)}">` : '<a>'
    } else if (name === 'span') {
      const cls = attrs.match(/class\s*=\s*(?:"([^"]*)"|'([^']*)')/i)
      const c = (cls?.[1] ?? cls?.[2] ?? '').replace(/[^\w\s-]/g, '').trim()
      out += c ? `<span class="${c}">` : '<span>'
    } else out += name === 'br' ? '<br>' : `<${name}>`
  }
  return out
}

const line = (tag: string, id: string, html: string, cls = '', inline = true) =>
  `<${tag} data-id="${esc(id)}"${inline ? ' data-edit="inline"' : ''}${cls ? ` class="${cls}"` : ''}>${sanitizeInline(html)}</${tag}>`

/** Contact details on one line, links on a second: the reader sees the address, not a label. */
const contactLine = (c: ResumeContent, sep: string) => {
  const b = c.basics
  const join = (xs: string[]) => xs.filter(Boolean).join(`<span class="sep">${sep}</span>`)
  const shown = (l: { label: string; url: string }) => {
    const bare = l.url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')
    return /^(website|linkedin|github|portfolio|x|twitter|blog)$/i.test(l.label.trim()) || !l.label.trim() ? bare : l.label
  }
  const first = join([esc(b.location), esc(b.phone), b.email ? `<a href="mailto:${esc(b.email)}">${esc(b.email)}</a>` : ''])
  const links = join(b.links.filter((l) => l.url).map((l) => `<a href="${esc(/^https?:/.test(l.url) ? l.url : `https://${l.url}`)}">${esc(shown(l))}</a>`))
  return [first, links].filter(Boolean).join('<br>')
}

const highlights = (hs: Highlight[]) =>
  hs.length
    ? `<div class="stats">${hs.map((h) => `<div class="stat" data-id="${esc(h.id)}"><span class="stat-num">${esc(h.value)}</span><span class="stat-label">${esc(h.label)}</span></div>`).join('')}</div>`
    : ''

const company = (co: Company, sectionTitle: string) => `
<article class="company${co.pageBreakBefore ? ' page-break' : ''}">${co.pageBreakBefore ? `<h2 class="continued">${esc(sectionTitle)}, Continued</h2>` : ''}
  <div class="company-line">${line('span', co.id, co.name, 'company-name')}${co.location ? `<span class="location">${esc(co.location)}</span>` : ''}</div>
  ${co.roles
    .map(
      (r) => `<div class="role">
    <div class="role-line"><span data-id="${esc(r.id)}" class="role-title">${esc(r.title)}</span><span class="dates">${esc(r.dates)}</span></div>
    ${r.bullets.length ? `<ul>${r.bullets.map((b) => line('li', b.id, b.text)).join('')}</ul>` : ''}
  </div>`,
    )
    .join('')}
</article>`

const section = (s: Section) => {
  const h = `<h2 data-id="${esc(s.id)}">${esc(s.title)}</h2>`
  switch (s.type) {
    case 'summary':
      return `<section class="summary-section">${h}${line('p', s.text.id, s.text.text, 'summary')}</section>`
    case 'experience':
      return `<section class="experience">${h}${s.companies.map((co) => company(co, s.title)).join('')}</section>`
    case 'skills':
      return `<section class="skills">${h}${s.groups.map((g) => line('p', g.id, g.label ? `<strong>${esc(g.label)}:</strong> ${g.text}` : g.text)).join('')}</section>`
    case 'education':
      return `<section class="education">${h}${s.items
        .map(
          (e) =>
            `<div class="edu" data-id="${esc(e.id)}"><div class="edu-line"><span class="edu-degree">${esc(e.degree)}</span><span class="dates">${esc(e.dates)}</span></div><div class="edu-school">${esc(e.school)}${e.detail ? ` · ${esc(e.detail)}` : ''}</div></div>`,
        )
        .join('')}</section>`
    case 'list':
      return `<section class="list">${h}<ul>${s.items.map((i) => line('li', i.id, i.text)).join('')}</ul></section>`
  }
}

// ------------------------------------------------------------------------------------- base CSS

const base = (paper: string) => `
* { box-sizing: border-box; }
@page { size: ${paper}; margin: 0; }
html, body { margin: 0; padding: 0; }
body { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
p { margin: 0; }
a { color: inherit; text-decoration: none; }
ul { margin: 2px 0 0; padding: 0; list-style: none; }
li { position: relative; break-inside: avoid; }
.company { break-inside: auto; }
.role-line, .company-line, .edu-line { display: flex; justify-content: space-between; gap: 14px; align-items: baseline; }
.dates { white-space: nowrap; }
.page-break { break-before: page; }
.stats { display: flex; }
.stat { flex: 1; text-align: center; }
.stat-num, .stat-label { display: block; }
`

// ------------------------------------------------------------------------------------- themes

const classic: ResumeTheme = {
  id: 'classic',
  name: 'Classic',
  description: 'Serif, single column, quiet rules. Reads well everywhere and parses cleanly in applicant tracking systems.',
  accent: '#1f3a5f',
  css: (a) => `
body { font-family: "Charter", "Bitstream Charter", "Sitka Text", Cambria, Georgia, serif; color: #1d1d1f; font-size: 10pt; line-height: 1.38; padding: 0.5in 0.6in; }
header { text-align: center; margin-bottom: 10px; }
h1 { margin: 0; font-size: 22pt; font-weight: 600; letter-spacing: 0.5px; }
.headline { margin-top: 3px; font-size: 10.5pt; color: ${a}; font-style: italic; }
.contact { margin-top: 4px; font-size: 9pt; color: #555; }
.contact .sep { padding: 0 6px; color: #aaa; }
.stats { margin: 6px 0 10px; padding: 6px 0; border-top: 1px solid #ddd; border-bottom: 1px solid #ddd; }
.stat-num { font-size: 13pt; font-weight: 600; color: ${a}; }
.stat-label { font-size: 7.5pt; color: #666; text-transform: uppercase; letter-spacing: 0.4px; }
section { margin-top: 10px; }
h2 { margin: 0 0 5px; font-size: 10.5pt; font-weight: 700; text-transform: uppercase; letter-spacing: 1.2px; color: ${a}; border-bottom: 1px solid ${a}55; padding-bottom: 2px; }
.company { margin-top: 7px; }
.company-line { font-weight: 700; font-size: 10.5pt; }
.company-line .location, .company-line .note { font-weight: 400; color: #555; font-size: 9.5pt; }
.role-line { margin-top: 1px; font-style: italic; }
.role + .role { margin-top: 5px; }
.dates { color: #555; font-style: normal; font-size: 9.5pt; }
ul { margin-left: 14px; }
li { margin: 2px 0; padding-left: 2px; }
li::before { content: "•"; position: absolute; left: -11px; color: ${a}; }
.skills p { margin: 2px 0; }
.edu { margin: 3px 0; }
.edu-degree { font-weight: 600; }
.edu-school { color: #444; }
.page-break { padding-top: 0.5in; }
`,
}

const modern: ResumeTheme = {
  id: 'modern',
  name: 'Modern',
  description: 'Clean sans-serif with a color accent and a strong name. A good default for tech roles.',
  accent: '#2563eb',
  css: (a) => `
body { font-family: "Inter", "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif; color: #16181d; font-size: 9.6pt; line-height: 1.42; padding: 0.5in 0.6in; }
header { margin-bottom: 12px; }
h1 { margin: 0; font-size: 24pt; font-weight: 750; letter-spacing: -0.5px; color: #0b0d12; }
.headline { margin-top: 2px; font-size: 11pt; font-weight: 500; color: ${a}; }
.contact { margin-top: 5px; font-size: 8.8pt; color: #5b6170; }
.contact .sep { padding: 0 7px; color: #c3c7d0; }
.stats { gap: 8px; margin: 0 0 12px; }
.stat { background: ${a}0f; border-radius: 6px; padding: 6px 4px; }
.stat-num { font-size: 13pt; font-weight: 700; color: ${a}; }
.stat-label { font-size: 7.4pt; color: #5b6170; }
section { margin-top: 12px; }
h2 { margin: 0 0 6px; font-size: 9pt; font-weight: 700; text-transform: uppercase; letter-spacing: 1.6px; color: ${a}; }
.company { margin-top: 8px; }
.company-line { font-size: 10.5pt; font-weight: 650; }
.company-line .location { font-weight: 400; font-size: 9pt; color: #5b6170; }
.company-line .note { font-weight: 400; color: #5b6170; font-size: 9pt; }
.role-line { margin-top: 1px; font-weight: 500; color: #2b2f38; }
.role + .role { margin-top: 6px; }
.dates { font-size: 8.8pt; color: #5b6170; font-variant-numeric: tabular-nums; }
ul { margin-left: 13px; }
li { margin: 2.5px 0; padding-left: 3px; }
li::before { content: ""; position: absolute; left: -10px; top: 0.6em; width: 4px; height: 4px; border-radius: 50%; background: ${a}; }
.skills p { margin: 2.5px 0; }
.skills strong { font-weight: 650; }
.edu { margin: 4px 0; }
.edu-degree { font-weight: 600; }
.edu-school { color: #5b6170; }
.page-break { padding-top: 0.5in; }
`,
}

const compact: ResumeTheme = {
  id: 'compact',
  name: 'Compact',
  description: 'Tight spacing and small margins, for fitting a long history on one page.',
  accent: '#0f766e',
  css: (a) => `
body { font-family: "Source Sans 3", "Source Sans Pro", "Segoe UI", Helvetica, Arial, sans-serif; color: #1b1b1b; font-size: 9pt; line-height: 1.3; padding: 0.35in 0.45in; }
header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid ${a}; padding-bottom: 5px; margin-bottom: 6px; }
h1 { margin: 0; font-size: 18pt; font-weight: 700; }
.headline { font-size: 9.5pt; color: ${a}; font-weight: 600; }
.contact { text-align: right; font-size: 8.2pt; color: #444; max-width: 55%; }
.contact .sep { padding: 0 4px; color: #bbb; }
.stats { margin: 0 0 6px; }
.stat-num { font-size: 11pt; font-weight: 700; color: ${a}; }
.stat-label { font-size: 7pt; color: #555; }
section { margin-top: 6px; }
h2 { margin: 0 0 3px; font-size: 9pt; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: ${a}; }
.company { margin-top: 4px; }
.company-line { font-weight: 700; }
.company-line .location, .company-line .note { font-weight: 400; color: #555; }
.role-line { font-style: italic; }
.role + .role { margin-top: 3px; }
.dates { color: #555; font-style: normal; }
ul { margin-left: 11px; }
li { margin: 1px 0; padding-left: 1px; }
li::before { content: "–"; position: absolute; left: -10px; color: ${a}; }
.skills p { margin: 1px 0; }
.edu-degree { font-weight: 600; }
.page-break { padding-top: 0.35in; }
`,
}

const DECO_SUNBURST = `<svg class="sunburst" viewBox="0 0 360 70" aria-hidden="true"><line class="flank" x1="0" y1="62" x2="116" y2="62"/><line class="flank" x1="244" y1="62" x2="360" y2="62"/>${[
  [162, 62, 124, 62], [162.2, 59.2, 138.5, 55.4], [162.9, 56.4, 126.7, 44.7], [164, 53.8, 142.6, 42.9], [165.4, 51.4, 134.7, 29.1], [167.3, 49.3, 150.3, 32.3], [169.4, 47.4, 147.1, 16.7], [171.8, 46, 160.9, 24.6], [174.4, 44.9, 162.7, 8.7], [177.2, 44.2, 173.4, 20.5], [180, 44, 180, 6], [182.8, 44.2, 186.6, 20.5], [185.6, 44.9, 197.3, 8.7], [188.2, 46, 199.1, 24.6], [190.6, 47.4, 212.9, 16.7], [192.7, 49.3, 209.7, 32.3], [194.6, 51.4, 225.3, 29.1], [196, 53.8, 217.4, 42.9], [197.1, 56.4, 233.3, 44.7], [197.8, 59.2, 221.5, 55.4], [198, 62, 236, 62],
]
  .map(([x1, y1, x2, y2]) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`)
  .join('')}<path class="diamond" d="M180 55 L187 62 L180 69 L173 62 Z"/></svg>`

const deco: ResumeTheme = {
  id: 'deco',
  name: 'Deco',
  description: 'Art-deco display type, gold rules and an ivory page. Memorable; best when the design itself says something about you.',
  accent: '#a8862a',
  fonts: 'https://fonts.googleapis.com/css2?family=Josefin+Sans:ital,wght@0,400;0,600;0,700;1,400&family=Poiret+One&display=swap',
  decoration: DECO_SUNBURST,
  css: (a) => `
:root { --paper: #faf6ea; --ink: #1c1c24; --muted: #6f6650; --gold: ${a}; --gold-bright: color-mix(in srgb, ${a} 80%, #fff 20%); --rule: color-mix(in srgb, ${a} 45%, transparent); --display: 'Poiret One', 'Josefin Sans', sans-serif; --sans: 'Josefin Sans', ui-sans-serif, sans-serif; }
html { background: var(--paper); }
body { color: var(--ink); font-family: var(--sans); font-size: 9.4pt; line-height: 1.34; padding: 0.4in 0.55in; }
header { text-align: center; padding: 0 0 8px; margin-bottom: 8px; border-bottom: 1px solid var(--rule); position: relative; }
header::after { content: ''; position: absolute; left: 0; right: 0; bottom: 2px; border-bottom: 1px solid var(--rule); }
.sunburst { display: block; width: 360px; height: 34px; margin: 0 auto; stroke: var(--gold); overflow: visible; }
.sunburst line { stroke-width: 1.5; stroke-linecap: round; }
.sunburst .flank { stroke-width: 1; }
.sunburst .diamond { fill: var(--gold); stroke: none; }
h1 { margin: 4px 0 0; font-family: var(--display); font-weight: 400; font-size: 26pt; line-height: 1; letter-spacing: 3px; text-transform: uppercase; text-indent: 3px; }
.headline { display: flex; align-items: center; justify-content: center; gap: 10px; margin-top: 5px; color: var(--gold); font-size: 8.5pt; font-weight: 600; letter-spacing: 0.5px; text-transform: uppercase; }
.headline::before, .headline::after { content: '\\25c6'; font-size: 5pt; letter-spacing: 0; color: var(--gold-bright); }
.contact { margin-top: 4px; color: var(--muted); font-size: 8.5pt; letter-spacing: 0.4px; line-height: 1.5; }
.contact .sep { color: var(--gold-bright); padding: 0 5px; }
section { margin-top: 8px; }
h2 { display: flex; align-items: center; gap: 9px; margin: 0 0 5px; font-family: var(--display); font-weight: 400; font-size: 11pt; line-height: 1.2; letter-spacing: 3.2px; text-transform: uppercase; white-space: nowrap; }
h2::before { content: '\\25c6'; color: var(--gold); font-size: 6pt; letter-spacing: 0; }
h2::after { content: ''; flex: 1; border-top: 1px solid var(--rule); margin-top: 2px; }
.summary { font-size: 9.4pt; line-height: 1.38; }
.skills p { margin: 2px 0; }
.skills strong { color: var(--gold); font-weight: 700; letter-spacing: 0.6px; text-transform: uppercase; font-size: 8.8pt; }
.company { margin-top: 6px; }
.company-line { font-size: 10.8pt; font-weight: 700; letter-spacing: 1.4px; text-transform: uppercase; }
.company-line .co-note, .company-line .note { color: var(--muted); font-size: 8.8pt; font-weight: 400; font-style: italic; text-transform: none; letter-spacing: 0; }
.company-line .location { color: var(--muted); font-size: 8.8pt; font-weight: 400; letter-spacing: 0.4px; text-transform: none; }
.role-line { margin-top: 2px; font-weight: 600; letter-spacing: 0.3px; }
.dates { color: var(--gold); font-size: 8.8pt; font-weight: 600; letter-spacing: 0.6px; }
ul { margin: 2px 0 0 15px; }
li { margin: 2px 0; padding-left: 2px; }
li::before { content: '\\25c6'; position: absolute; left: -13px; top: 0.28em; color: var(--gold-bright); font-size: 5.5pt; }
.role + .role { margin-top: 6px; }
.page-break { position: relative; padding-top: calc(0.4in + 12px); }
.company.page-break .continued { margin-bottom: 6px; }
.page-break::before { content: ''; position: absolute; top: 0.4in; left: 0; right: 0; border-top: 1px solid var(--rule); box-shadow: 0 3px 0 -2px var(--rule); }
.stats { justify-content: space-between; margin: 0 0 8px; padding: 0 0 7px; border-bottom: 1px solid var(--rule); }
.stat + .stat { border-left: 1px solid var(--rule); }
.stat-num { font-family: var(--display); font-size: 17pt; line-height: 1.1; color: var(--gold); letter-spacing: 0.5px; }
.stat-label { margin-top: 1px; color: var(--muted); font-size: 7pt; font-weight: 600; letter-spacing: 0.3px; text-transform: uppercase; }
.edu-degree { font-weight: 600; }
.edu-school { color: var(--muted); }
`,
}

export const THEMES: ResumeTheme[] = [modern, classic, compact, deco]
export const themeById = (id: string | null | undefined) => THEMES.find((t) => t.id === id) ?? modern

/** Render a resume to a complete HTML document. */
export function renderResume(c: ResumeContent, themeId: string, opts: ThemeOptions = {}): string {
  const t = themeById(themeId)
  const accent = /^#[0-9a-f]{3,8}$/i.test(opts.accent ?? '') ? opts.accent! : t.accent
  const paper = opts.paper === 'a4' ? 'A4' : 'letter'
  const scale = Math.min(1.15, Math.max(0.8, opts.scale ?? 1))
  const showHighlights = opts.showHighlights ?? true
  const b = c.basics
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(b.name || 'Resume')}</title>
${t.fonts ? `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="${t.fonts}" rel="stylesheet">` : ''}
<style>${base(paper)}${t.css(accent)}
html { zoom: ${scale}; }
@media screen { html { background: transparent; } body { width: ${paper === 'A4' ? '210mm' : '8.5in'}; min-height: ${paper === 'A4' ? '297mm' : '11in'}; margin: 0 auto; background: ${t.id === 'deco' ? 'var(--paper)' : '#fff'}; } }
</style></head>
<body data-theme="${t.id}">
<header>${t.decoration ?? ''}
<h1>${esc(b.name)}</h1>
${b.headline ? line('div', b.headline.id, b.headline.text, 'headline') : ''}
<div class="contact">${contactLine(c, t.id === 'deco' ? '◆' : '·')}</div>
</header>
${showHighlights ? highlights(c.highlights) : ''}
${c.sections.map(section).join('\n')}
</body></html>`
}
