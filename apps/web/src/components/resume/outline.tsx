import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { newLineId, type ResumeContent, type Section, type SectionType } from '@sidedoor/shared/resume'
import { Button } from '~/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '~/components/ui/dropdown-menu'
import { Input } from '~/components/ui/input'
import { Switch } from '~/components/ui/switch'
import { Textarea } from '~/components/ui/textarea'
import { cn } from '~/lib/utils'

/**
 * The resume as a structured outline: every section, company, role and bullet as a field. Edits
 * here re-render the preview; small text edits can also happen directly on the page.
 */

type Update = (fn: (c: ResumeContent) => void) => void

const move = <T,>(list: T[], i: number, d: -1 | 1) => {
  const j = i + d
  if (j < 0 || j >= list.length) return
  const [x] = list.splice(i, 1)
  list.splice(j, 0, x!)
}

function Field({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={cn('block space-y-1', className)}>
      <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}

function RowTools({ onUp, onDown, onDelete, label }: { onUp?: () => void; onDown?: () => void; onDelete?: () => void; label: string }) {
  return (
    <div className="flex shrink-0 items-center opacity-60 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
      {onUp && (
        <Button type="button" variant="ghost" size="icon" className="size-7" onClick={onUp} aria-label={`Move ${label} up`}>
          <ArrowUp className="size-3.5" />
        </Button>
      )}
      {onDown && (
        <Button type="button" variant="ghost" size="icon" className="size-7" onClick={onDown} aria-label={`Move ${label} down`}>
          <ArrowDown className="size-3.5" />
        </Button>
      )}
      {onDelete && (
        <Button type="button" variant="ghost" size="icon" className="size-7 hover:text-destructive" onClick={onDelete} aria-label={`Delete ${label}`}>
          <Trash2 className="size-3.5" />
        </Button>
      )}
    </div>
  )
}

/** A textarea that grows with its text; bullets are usually one or two lines. */
function AutoText({ value, onChange, placeholder, onFocus, className }: { value: string; onChange: (v: string) => void; placeholder?: string; onFocus?: () => void; className?: string }) {
  return (
    <Textarea
      value={value}
      placeholder={placeholder}
      onFocus={onFocus}
      onChange={(e) => onChange(e.target.value)}
      rows={1}
      className={cn('field-sizing-content min-h-8 resize-none py-1.5 text-sm leading-snug', className)}
    />
  )
}

const SECTION_TYPES: Array<{ type: SectionType; label: string; title: string }> = [
  { type: 'summary', label: 'Summary', title: 'Summary' },
  { type: 'experience', label: 'Experience', title: 'Experience' },
  { type: 'skills', label: 'Skills', title: 'Skills' },
  { type: 'education', label: 'Education', title: 'Education' },
  { type: 'list', label: 'List (projects, certifications, awards…)', title: 'Projects' },
]

const blankSection = (type: SectionType, title: string): Section => {
  const id = newLineId('sec')
  switch (type) {
    case 'summary':
      return { id, type, title, text: { id: newLineId('sum'), text: '' } }
    case 'experience':
      return { id, type, title, companies: [] }
    case 'skills':
      return { id, type, title, groups: [{ id: newLineId('sk'), label: '', text: '' }] }
    case 'education':
      return { id, type, title, items: [{ id: newLineId('ed'), school: '', degree: '' }] }
    case 'list':
      return { id, type, title, items: [{ id: newLineId('li'), text: '' }] }
  }
}

export function Outline({ content, update, onFocusLine }: { content: ResumeContent; update: Update; onFocusLine: (id: string) => void }) {
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const isOpen = (id: string, dflt = true) => open[id] ?? dflt
  const toggle = (id: string, dflt = true) => setOpen((o) => ({ ...o, [id]: !(o[id] ?? dflt) }))
  const b = content.basics

  return (
    <div className="space-y-5 p-4">
      <section className="space-y-3">
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Header</h3>
        <Field label="Name">
          <Input value={b.name} onChange={(e) => update((c) => void (c.basics.name = e.target.value))} placeholder="Your name" />
        </Field>
        <Field label="Headline">
          <Input
            value={b.headline?.text ?? ''}
            onFocus={() => b.headline && onFocusLine(b.headline.id)}
            onChange={(e) =>
              update((c) => {
                c.basics.headline = { id: c.basics.headline?.id ?? newLineId('h'), text: e.target.value }
              })
            }
            placeholder="e.g. Senior Product Designer · Fintech and payments"
          />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Location">
            <Input value={b.location} onChange={(e) => update((c) => void (c.basics.location = e.target.value))} placeholder="City, Country" />
          </Field>
          <Field label="Phone">
            <Input value={b.phone} onChange={(e) => update((c) => void (c.basics.phone = e.target.value))} />
          </Field>
          <Field label="Email" className="col-span-2">
            <Input type="email" value={b.email} onChange={(e) => update((c) => void (c.basics.email = e.target.value))} />
          </Field>
        </div>
        <div className="space-y-1.5">
          <span className="text-[11px] font-medium text-muted-foreground">Links</span>
          {b.links.map((l, i) => (
            <div key={i} className="group flex gap-1.5">
              <Input className="w-28" value={l.label} placeholder="Label" onChange={(e) => update((c) => void (c.basics.links[i]!.label = e.target.value))} />
              <Input className="flex-1" value={l.url} placeholder="https://" onChange={(e) => update((c) => void (c.basics.links[i]!.url = e.target.value))} />
              <RowTools label="link" onDelete={() => update((c) => void c.basics.links.splice(i, 1))} />
            </div>
          ))}
          <Button type="button" variant="ghost" size="sm" onClick={() => update((c) => void c.basics.links.push({ label: '', url: '' }))}>
            <Plus /> Link
          </Button>
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Highlights</h3>
        <p className="text-xs text-muted-foreground">Optional row of headline numbers under your name, e.g. “$40M / ARR grown”.</p>
        {content.highlights.map((h, i) => (
          <div key={h.id} className="group flex gap-1.5">
            <Input className="w-24" value={h.value} placeholder="$40M" onFocus={() => onFocusLine(h.id)} onChange={(e) => update((c) => void (c.highlights[i]!.value = e.target.value))} />
            <Input className="flex-1" value={h.label} placeholder="ARR grown" onChange={(e) => update((c) => void (c.highlights[i]!.label = e.target.value))} />
            <RowTools label="highlight" onUp={() => update((c) => move(c.highlights, i, -1))} onDelete={() => update((c) => void c.highlights.splice(i, 1))} />
          </div>
        ))}
        {content.highlights.length < 6 && (
          <Button type="button" variant="ghost" size="sm" onClick={() => update((c) => void c.highlights.push({ id: newLineId('s'), value: '', label: '' }))}>
            <Plus /> Highlight
          </Button>
        )}
      </section>

      {content.sections.map((s, si) => (
        <section key={s.id} className="rounded-lg border bg-card/50">
          <div className="group flex items-center gap-1 px-2 py-1.5">
            <button type="button" className="rounded p-1 text-muted-foreground hover:text-foreground" onClick={() => toggle(s.id)} aria-label={isOpen(s.id) ? 'Collapse' : 'Expand'}>
              {isOpen(s.id) ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
            </button>
            <Input
              value={s.title}
              onChange={(e) => update((c) => void (c.sections[si]!.title = e.target.value))}
              className="h-8 flex-1 border-transparent bg-transparent px-1.5 text-sm font-semibold shadow-none hover:border-input focus-visible:border-input"
            />
            <RowTools
              label="section"
              onUp={si > 0 ? () => update((c) => move(c.sections, si, -1)) : undefined}
              onDown={si < content.sections.length - 1 ? () => update((c) => move(c.sections, si, 1)) : undefined}
              onDelete={() => confirm(`Remove the “${s.title}” section?`) && update((c) => void c.sections.splice(si, 1))}
            />
          </div>
          {isOpen(s.id) && (
            <div className="space-y-3 border-t px-3 py-3">
              <SectionBody s={s} si={si} update={update} onFocusLine={onFocusLine} isOpen={isOpen} toggle={toggle} />
            </div>
          )}
        </section>
      ))}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" size="sm">
            <Plus /> Add section
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {SECTION_TYPES.map((t) => (
            <DropdownMenuItem key={t.type} onSelect={() => update((c) => void c.sections.push(blankSection(t.type, t.title)))}>
              {t.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function SectionBody({ s, si, update, onFocusLine, isOpen, toggle }: { s: Section; si: number; update: Update; onFocusLine: (id: string) => void; isOpen: (id: string, d?: boolean) => boolean; toggle: (id: string, d?: boolean) => void }) {
  const sec = <T extends Section['type']>(c: ResumeContent) => c.sections[si] as Extract<Section, { type: T }>
  switch (s.type) {
    case 'summary':
      return <AutoText value={s.text.text} onFocus={() => onFocusLine(s.text.id)} onChange={(v) => update((c) => void (sec<'summary'>(c).text.text = v))} placeholder="Two or three sentences: who you are, what you're best at, and the proof." className="min-h-20" />
    case 'skills':
      return (
        <div className="space-y-2">
          {s.groups.map((g, gi) => (
            <div key={g.id} className="group flex items-start gap-1.5">
              <Input className="w-28" value={g.label} placeholder="Label" onFocus={() => onFocusLine(g.id)} onChange={(e) => update((c) => void (sec<'skills'>(c).groups[gi]!.label = e.target.value))} />
              <AutoText value={g.text} onFocus={() => onFocusLine(g.id)} onChange={(v) => update((c) => void (sec<'skills'>(c).groups[gi]!.text = v))} placeholder="TypeScript, React, Postgres" className="flex-1" />
              <RowTools label="skill group" onUp={gi > 0 ? () => update((c) => move(sec<'skills'>(c).groups, gi, -1)) : undefined} onDelete={() => update((c) => void sec<'skills'>(c).groups.splice(gi, 1))} />
            </div>
          ))}
          <Button type="button" variant="ghost" size="sm" onClick={() => update((c) => void sec<'skills'>(c).groups.push({ id: newLineId('sk'), label: '', text: '' }))}>
            <Plus /> Skill group
          </Button>
        </div>
      )
    case 'education':
      return (
        <div className="space-y-3">
          {s.items.map((e, ei) => (
            <div key={e.id} className="group space-y-1.5 rounded-md border p-2">
              <div className="flex gap-1.5">
                <Input className="flex-1" value={e.degree} placeholder="Degree" onFocus={() => onFocusLine(e.id)} onChange={(x) => update((c) => void (sec<'education'>(c).items[ei]!.degree = x.target.value))} />
                <RowTools label="education" onUp={ei > 0 ? () => update((c) => move(sec<'education'>(c).items, ei, -1)) : undefined} onDelete={() => update((c) => void sec<'education'>(c).items.splice(ei, 1))} />
              </div>
              <div className="flex gap-1.5">
                <Input className="flex-1" value={e.school} placeholder="School" onChange={(x) => update((c) => void (sec<'education'>(c).items[ei]!.school = x.target.value))} />
                <Input className="w-32" value={e.dates ?? ''} placeholder="2014 – 2018" onChange={(x) => update((c) => void (sec<'education'>(c).items[ei]!.dates = x.target.value))} />
              </div>
              <Input value={e.detail ?? ''} placeholder="Detail (optional)" onChange={(x) => update((c) => void (sec<'education'>(c).items[ei]!.detail = x.target.value))} />
            </div>
          ))}
          <Button type="button" variant="ghost" size="sm" onClick={() => update((c) => void sec<'education'>(c).items.push({ id: newLineId('ed'), school: '', degree: '' }))}>
            <Plus /> Education
          </Button>
        </div>
      )
    case 'list':
      return (
        <div className="space-y-1.5">
          {s.items.map((it, ii) => (
            <div key={it.id} className="group flex items-start gap-1.5">
              <AutoText value={it.text} onFocus={() => onFocusLine(it.id)} onChange={(v) => update((c) => void (sec<'list'>(c).items[ii]!.text = v))} className="flex-1" />
              <RowTools label="item" onUp={ii > 0 ? () => update((c) => move(sec<'list'>(c).items, ii, -1)) : undefined} onDelete={() => update((c) => void sec<'list'>(c).items.splice(ii, 1))} />
            </div>
          ))}
          <Button type="button" variant="ghost" size="sm" onClick={() => update((c) => void sec<'list'>(c).items.push({ id: newLineId('li'), text: '' }))}>
            <Plus /> Item
          </Button>
        </div>
      )
    case 'experience':
      return (
        <div className="space-y-3">
          {s.companies.map((co, ci) => (
            <div key={co.id} className="rounded-md border">
              <div className="group flex items-center gap-1 p-1.5">
                <button type="button" className="rounded p-1 text-muted-foreground hover:text-foreground" onClick={() => toggle(co.id, ci < 2)} aria-label="Toggle">
                  {isOpen(co.id, ci < 2) ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                </button>
                <Input className="h-8 flex-1" value={co.name} placeholder="Company" onFocus={() => onFocusLine(co.id)} onChange={(e) => update((c) => void (sec<'experience'>(c).companies[ci]!.name = e.target.value))} />
                <RowTools
                  label="company"
                  onUp={ci > 0 ? () => update((c) => move(sec<'experience'>(c).companies, ci, -1)) : undefined}
                  onDown={ci < s.companies.length - 1 ? () => update((c) => move(sec<'experience'>(c).companies, ci, 1)) : undefined}
                  onDelete={() => confirm(`Remove ${co.name || 'this company'} and its roles?`) && update((c) => void sec<'experience'>(c).companies.splice(ci, 1))}
                />
              </div>
              {isOpen(co.id, ci < 2) && (
                <div className="space-y-3 border-t p-2.5">
                  <div className="flex items-center gap-2">
                    <Input className="flex-1" value={co.location ?? ''} placeholder="Location (optional)" onChange={(e) => update((c) => void (sec<'experience'>(c).companies[ci]!.location = e.target.value))} />
                    <label className="flex items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground">
                      <Switch checked={!!co.pageBreakBefore} onCheckedChange={(v) => update((c) => void (sec<'experience'>(c).companies[ci]!.pageBreakBefore = v))} />
                      New page
                    </label>
                  </div>
                  {co.roles.map((r, ri) => (
                    <div key={r.id} className="space-y-1.5 rounded-md bg-muted/40 p-2">
                      <div className="group flex gap-1.5">
                        <Input className="flex-1" value={r.title} placeholder="Title" onFocus={() => onFocusLine(r.id)} onChange={(e) => update((c) => void (sec<'experience'>(c).companies[ci]!.roles[ri]!.title = e.target.value))} />
                        <Input className="w-40" value={r.dates} placeholder="2021 – Present" onChange={(e) => update((c) => void (sec<'experience'>(c).companies[ci]!.roles[ri]!.dates = e.target.value))} />
                        <RowTools label="role" onUp={ri > 0 ? () => update((c) => move(sec<'experience'>(c).companies[ci]!.roles, ri, -1)) : undefined} onDelete={() => update((c) => void sec<'experience'>(c).companies[ci]!.roles.splice(ri, 1))} />
                      </div>
                      {r.bullets.map((bl, bi) => (
                        <div key={bl.id} className="group flex items-start gap-1">
                          <span className="mt-2 text-muted-foreground">•</span>
                          <AutoText
                            value={bl.text}
                            onFocus={() => onFocusLine(bl.id)}
                            onChange={(v) => update((c) => void (sec<'experience'>(c).companies[ci]!.roles[ri]!.bullets[bi]!.text = v))}
                            placeholder="What you did, and what changed because of it"
                            className="flex-1"
                          />
                          <RowTools
                            label="bullet"
                            onUp={bi > 0 ? () => update((c) => move(sec<'experience'>(c).companies[ci]!.roles[ri]!.bullets, bi, -1)) : undefined}
                            onDown={bi < r.bullets.length - 1 ? () => update((c) => move(sec<'experience'>(c).companies[ci]!.roles[ri]!.bullets, bi, 1)) : undefined}
                            onDelete={() => update((c) => void sec<'experience'>(c).companies[ci]!.roles[ri]!.bullets.splice(bi, 1))}
                          />
                        </div>
                      ))}
                      <Button type="button" variant="ghost" size="sm" onClick={() => update((c) => void sec<'experience'>(c).companies[ci]!.roles[ri]!.bullets.push({ id: newLineId('b'), text: '' }))}>
                        <Plus /> Bullet
                      </Button>
                    </div>
                  ))}
                  <Button type="button" variant="ghost" size="sm" onClick={() => update((c) => void sec<'experience'>(c).companies[ci]!.roles.push({ id: newLineId('r'), title: '', dates: '', bullets: [{ id: newLineId('b'), text: '' }] }))}>
                    <Plus /> Role at {co.name || 'this company'}
                  </Button>
                </div>
              )}
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => update((c) => void sec<'experience'>(c).companies.unshift({ id: newLineId('co'), name: '', roles: [{ id: newLineId('r'), title: '', dates: '', bullets: [{ id: newLineId('b'), text: '' }] }] }))}
          >
            <Plus /> Company
          </Button>
        </div>
      )
  }
}
