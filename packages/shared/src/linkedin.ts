/** Their LinkedIn profile if we have it, otherwise a LinkedIn people search for "<name> <company>". */
export const linkedinUrl = (p: { name: string | null; companyName: string | null; linkedin: string | null } | null | undefined) => {
  if (!p?.name) return null
  if (p.linkedin?.trim()) return /^https?:/i.test(p.linkedin) ? p.linkedin : `https://${p.linkedin.replace(/^\/+/, '')}`
  return `https://www.linkedin.com/search/results/people/?${new URLSearchParams({ keywords: [p.name, p.companyName].filter(Boolean).join(' ') })}`
}
