// Apply the saved theme before first paint so there's no flash (a file, so the CSP needs no inline scripts).
try {
  const t = localStorage.getItem('sidedoor-theme') || 'system'
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
} catch {}
