// Terminal output → searchable text: drop escape sequences and control bytes,
// treat carriage returns as line breaks, collapse runs of blank lines.
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC (titles, hyperlinks)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '') // CSI (colours, cursor moves)
    .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, '') // DCS/SOS/PM/APC
    .replace(/\x1b[@-Z\\-_]/g, '') // other two-byte escapes
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .replace(/\n{3,}/g, '\n\n');
}
