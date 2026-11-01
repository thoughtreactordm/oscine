/**
 * The one-statement rule for `query_library` — **W24-5**, `oscine-mcp` → D36.4.
 *
 * `node:sqlite`'s `prepare` compiles the first statement and silently drops the
 * rest, so `SELECT 1; DELETE FROM x` would *look* like it ran as written. The
 * authorizer would refuse the second half if it were ever compiled, but an agent
 * told "done" about SQL that never ran has been misled, so a tail is refused
 * outright.
 *
 * This is a lexer, not a parser: it walks quotes, bracketed identifiers and
 * comments the way SQLite's tokenizer does, finds the first `;` outside them, and
 * requires that nothing but whitespace, comments and further `;` follow it.
 */
export type StatementShape = { ok: true; sql: string } | { ok: false; reason: 'empty' | 'multiple' }

export function singleStatement(input: string): StatementShape {
  const end = firstTerminator(input)
  const head = end === -1 ? input : input.slice(0, end)
  if (!hasContent(head)) return { ok: false, reason: 'empty' }
  if (end !== -1 && hasContent(input.slice(end + 1).replace(/;/g, ' '))) {
    return { ok: false, reason: 'multiple' }
  }
  return { ok: true, sql: head }
}

/** Index of the first `;` outside a literal, identifier or comment, or -1. */
function firstTerminator(sql: string): number {
  let i = 0
  while (i < sql.length) {
    const c = sql[i]!
    if (c === ';') return i
    i = skipToken(sql, i)
  }
  return -1
}

/** Whether anything but whitespace and comments remains. */
function hasContent(sql: string): boolean {
  let i = 0
  while (i < sql.length) {
    const c = sql[i]!
    if (/\s/.test(c)) {
      i += 1
      continue
    }
    if (startsComment(sql, i)) {
      i = skipToken(sql, i)
      continue
    }
    return true
  }
  return false
}

function startsComment(sql: string, i: number): boolean {
  return (sql[i] === '-' && sql[i + 1] === '-') || (sql[i] === '/' && sql[i + 1] === '*')
}

/** The index just past the token at `i` (one character for anything plain). */
function skipToken(sql: string, i: number): number {
  const c = sql[i]!
  if (c === '-' && sql[i + 1] === '-') {
    const nl = sql.indexOf('\n', i + 2)
    return nl === -1 ? sql.length : nl + 1
  }
  if (c === '/' && sql[i + 1] === '*') {
    // An unterminated block comment runs to the end, as in SQLite.
    const close = sql.indexOf('*/', i + 2)
    return close === -1 ? sql.length : close + 2
  }
  if (c === "'" || c === '"' || c === '`') return skipQuoted(sql, i, c)
  if (c === '[') {
    const close = sql.indexOf(']', i + 1)
    return close === -1 ? sql.length : close + 1
  }
  return i + 1
}

/** A quoted run where a doubled quote is an escaped one. */
function skipQuoted(sql: string, i: number, quote: string): number {
  let j = i + 1
  while (j < sql.length) {
    if (sql[j] === quote) {
      if (sql[j + 1] === quote) {
        j += 2
        continue
      }
      return j + 1
    }
    j += 1
  }
  return sql.length
}
