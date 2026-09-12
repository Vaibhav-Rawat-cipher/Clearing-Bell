export function shortAddress(value: string | null | undefined) {
  return value ? `${value.slice(0, 6)}…${value.slice(-4)}` : 'Not connected'
}

export function amount(value: string | number, digits = 4) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '—'
  if (number > 0 && number < 10 ** -digits) return `<${10 ** -digits}`
  return number.toLocaleString('en-US', { maximumFractionDigits: digits })
}

export function dateTime(seconds: number) {
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }).format(seconds * 1000) + ' UTC'
}

export function exportCsv(filename: string, rows: (string | number)[][]) {
  const escape = (value: string | number) => `"${String(value).replace(/^[=+@-]/, "'$&").replaceAll('"', '""')}"`
  const url = URL.createObjectURL(new Blob([rows.map(row => row.map(escape).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8;' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
