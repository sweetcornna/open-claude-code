/**
 * A deliberately small TOML reader for foreign-agent config files.
 *
 * WHY THIS EXISTS RATHER THAN A DEPENDENCY
 *
 * The official CLI calls `Bun.TOML.parse`. occ's default binary runs on Node
 * (see docs/zh — the `typeof Bun` else-branch is the production path), so that
 * is not available here, and this repository has five runtime dependencies in
 * total; adding a parser for one command is not worth the supply-chain surface
 * on a file whose whole point is that it comes from OUTSIDE occ.
 *
 * WHAT IT DOES NOT DO
 *
 * Datetimes are rejected, and so is anything else outside the subset below.
 * That is a feature, not a gap: an unparseable source file becomes an
 * "unmappable — review it manually" line in the import report, which is
 * exactly what the official implementation does with a TOML parse failure.
 * The subset covers everything Codex writes into `config.toml` and everything
 * Gemini writes into `commands/*.toml`:
 *
 *   - comments, bare and quoted keys, dotted key paths
 *   - `[table]` and `[[array of tables]]` headers
 *   - basic / literal strings, both single-line and triple-quoted
 *   - integers (dec/hex/oct/bin), floats, `inf`/`nan`, booleans
 *   - arrays and inline tables
 *
 * SAFETY
 *
 * The input is untrusted. Nothing here evaluates, requires or interpolates any
 * part of the source: it is a pure string -> plain-object transform. Nesting is
 * capped (`MAX_DEPTH`) so a hostile file of 100k open brackets cannot overflow
 * the stack, and duplicate keys are an error rather than a silent overwrite so
 * a crafted file cannot shadow an earlier value the report already showed.
 */

export type TomlValue =
  | string
  | number
  | boolean
  | TomlValue[]
  | { [key: string]: TomlValue }

export class TomlParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TomlParseError'
  }
}

const MAX_DEPTH = 32

const BARE_KEY_CHAR = /[A-Za-z0-9_-]/

type TomlTable = { [key: string]: TomlValue }

/**
 * Parse a TOML document into a plain object.
 *
 * @throws {TomlParseError} on anything outside the supported subset.
 */
export function parseToml(source: string): TomlTable {
  return new TomlReader(source).parseDocument()
}

class TomlReader {
  private readonly source: string
  private index = 0
  /** Tables created by a header, so a later duplicate header is an error. */
  private readonly definedTables = new Set<string>()
  /** Tables created implicitly by a dotted path; redefinable once. */
  private readonly implicitTables = new Set<string>()

  constructor(source: string) {
    // A BOM would otherwise be read as part of the first bare key.
    this.source = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source
  }

  parseDocument(): TomlTable {
    const root: TomlTable = {}
    let current = root
    let currentPath: string[] = []

    for (;;) {
      this.skipTrivia()
      if (this.eof()) break

      if (this.peek() === '[') {
        const header = this.parseTableHeader()
        currentPath = header.path
        current = header.isArrayOfTables
          ? this.enterArrayOfTables(root, header.path)
          : this.enterTable(root, header.path)
        this.expectLineEnd()
        continue
      }

      const path = this.parseKeyPath()
      this.skipInlineWhitespace()
      this.expect('=')
      this.skipInlineWhitespace()
      const value = this.parseValue(0)
      this.assignInto(current, path, value, [...currentPath, ...path].join('.'))
      this.expectLineEnd()
    }

    return root
  }

  // ---------------------------------------------------------------- cursor

  private eof(): boolean {
    return this.index >= this.source.length
  }

  private peek(offset = 0): string {
    return this.source[this.index + offset] ?? ''
  }

  private fail(message: string): never {
    // Line/column rather than offset: the message is shown to a human who is
    // about to open the foreign config file and look.
    const consumed = this.source.slice(0, this.index)
    const line = consumed.split('\n').length
    const column = this.index - (consumed.lastIndexOf('\n') + 1) + 1
    throw new TomlParseError(`${message} (line ${line}, column ${column})`)
  }

  private expect(character: string): void {
    if (this.peek() !== character) {
      this.fail(`expected \`${character}\``)
    }
    this.index++
  }

  private skipInlineWhitespace(): void {
    while (this.peek() === ' ' || this.peek() === '\t') this.index++
  }

  /** Whitespace, comments and newlines — everything with no semantic value. */
  private skipTrivia(): void {
    for (;;) {
      const character = this.peek()
      if (
        character === ' ' ||
        character === '\t' ||
        character === '\n' ||
        character === '\r'
      ) {
        this.index++
        continue
      }
      if (character === '#') {
        while (!this.eof() && this.peek() !== '\n') this.index++
        continue
      }
      return
    }
  }

  /** After a value or header: only a comment and a newline may follow. */
  private expectLineEnd(): void {
    this.skipInlineWhitespace()
    if (this.peek() === '#') {
      while (!this.eof() && this.peek() !== '\n') this.index++
    }
    if (this.eof()) return
    if (this.peek() === '\r') this.index++
    if (this.peek() === '\n') {
      this.index++
      return
    }
    this.fail('expected end of line')
  }

  // ----------------------------------------------------------------- keys

  private parseKeyPath(): string[] {
    const path: string[] = [this.parseKey()]
    for (;;) {
      this.skipInlineWhitespace()
      if (this.peek() !== '.') return path
      this.index++
      this.skipInlineWhitespace()
      path.push(this.parseKey())
    }
  }

  private parseKey(): string {
    const character = this.peek()
    if (character === '"') return this.parseBasicString()
    if (character === "'") return this.parseLiteralString()
    let key = ''
    while (BARE_KEY_CHAR.test(this.peek())) {
      key += this.peek()
      this.index++
    }
    if (key === '') this.fail('expected a key')
    return key
  }

  // --------------------------------------------------------------- tables

  private parseTableHeader(): { path: string[]; isArrayOfTables: boolean } {
    this.expect('[')
    const isArrayOfTables = this.peek() === '['
    if (isArrayOfTables) this.index++
    this.skipInlineWhitespace()
    const path = this.parseKeyPath()
    this.skipInlineWhitespace()
    this.expect(']')
    if (isArrayOfTables) this.expect(']')
    return { path, isArrayOfTables }
  }

  private descend(root: TomlTable, path: string[]): TomlTable {
    let node = root
    for (const [depth, segment] of path.entries()) {
      if (depth >= MAX_DEPTH) this.fail('table nesting too deep')
      const existing = node[segment]
      if (existing === undefined) {
        const created: TomlTable = {}
        node[segment] = created
        this.implicitTables.add(path.slice(0, depth + 1).join('.'))
        node = created
        continue
      }
      if (Array.isArray(existing)) {
        // Walking THROUGH an array of tables targets its last element.
        const last = existing[existing.length - 1]
        if (!isPlainTable(last)) this.fail(`cannot redefine \`${segment}\``)
        node = last
        continue
      }
      if (!isPlainTable(existing)) this.fail(`cannot redefine \`${segment}\``)
      node = existing
    }
    return node
  }

  private enterTable(root: TomlTable, path: string[]): TomlTable {
    const key = path.join('.')
    if (this.definedTables.has(key)) this.fail(`duplicate table \`${key}\``)
    const table = this.descend(root, path)
    this.definedTables.add(key)
    this.implicitTables.delete(key)
    return table
  }

  private enterArrayOfTables(root: TomlTable, path: string[]): TomlTable {
    const parentPath = path.slice(0, -1)
    const name = path[path.length - 1]
    if (name === undefined) this.fail('empty table header')
    const parent = this.descend(root, parentPath)
    const existing = parent[name]
    const entry: TomlTable = {}
    if (existing === undefined) {
      parent[name] = [entry]
      return entry
    }
    if (!Array.isArray(existing))
      this.fail(`cannot redefine \`${path.join('.')}\``)
    existing.push(entry)
    return entry
  }

  private assignInto(
    table: TomlTable,
    path: string[],
    value: TomlValue,
    displayPath: string,
  ): void {
    let node = table
    for (const [depth, segment] of path.slice(0, -1).entries()) {
      if (depth >= MAX_DEPTH) this.fail('key nesting too deep')
      const existing = node[segment]
      if (existing === undefined) {
        const created: TomlTable = {}
        node[segment] = created
        node = created
        continue
      }
      if (!isPlainTable(existing))
        this.fail(`cannot redefine \`${displayPath}\``)
      node = existing
    }
    const leaf = path[path.length - 1]
    if (leaf === undefined) this.fail('empty key')
    if (Object.hasOwn(node, leaf)) this.fail(`duplicate key \`${displayPath}\``)
    node[leaf] = value
  }

  // --------------------------------------------------------------- values

  private parseValue(depth: number): TomlValue {
    if (depth >= MAX_DEPTH) this.fail('value nesting too deep')
    const character = this.peek()
    if (character === '"') {
      return this.peek(1) === '"' && this.peek(2) === '"'
        ? this.parseMultilineBasicString()
        : this.parseBasicString()
    }
    if (character === "'") {
      return this.peek(1) === "'" && this.peek(2) === "'"
        ? this.parseMultilineLiteralString()
        : this.parseLiteralString()
    }
    if (character === '[') return this.parseArray(depth)
    if (character === '{') return this.parseInlineTable(depth)
    return this.parseAtom()
  }

  private parseArray(depth: number): TomlValue[] {
    this.expect('[')
    const values: TomlValue[] = []
    for (;;) {
      this.skipTrivia()
      if (this.eof()) this.fail('unterminated array')
      if (this.peek() === ']') {
        this.index++
        return values
      }
      values.push(this.parseValue(depth + 1))
      this.skipTrivia()
      if (this.peek() === ',') {
        this.index++
        continue
      }
      if (this.peek() === ']') {
        this.index++
        return values
      }
      this.fail('expected `,` or `]` in array')
    }
  }

  private parseInlineTable(depth: number): TomlTable {
    this.expect('{')
    const table: TomlTable = {}
    this.skipInlineWhitespace()
    if (this.peek() === '}') {
      this.index++
      return table
    }
    for (;;) {
      this.skipInlineWhitespace()
      const path = this.parseKeyPath()
      this.skipInlineWhitespace()
      this.expect('=')
      this.skipInlineWhitespace()
      const value = this.parseValue(depth + 1)
      this.assignInto(table, path, value, path.join('.'))
      this.skipInlineWhitespace()
      if (this.peek() === ',') {
        this.index++
        continue
      }
      if (this.peek() === '}') {
        this.index++
        return table
      }
      this.fail('expected `,` or `}` in inline table')
    }
  }

  /** Booleans and numbers. Datetimes are explicitly out of the subset. */
  private parseAtom(): TomlValue {
    let raw = ''
    while (!this.eof() && !',]}#\n\r \t'.includes(this.peek())) {
      raw += this.peek()
      this.index++
    }
    if (raw === '') this.fail('expected a value')
    if (raw === 'true') return true
    if (raw === 'false') return false

    const sign = raw.startsWith('-') ? -1 : 1
    const unsigned = raw.replace(/^[+-]/, '')
    if (unsigned === 'inf') return sign * Number.POSITIVE_INFINITY
    if (unsigned === 'nan') return Number.NaN

    if (/^0x[0-9A-Fa-f](_?[0-9A-Fa-f])*$/.test(unsigned)) {
      return sign * Number.parseInt(unsigned.slice(2).replaceAll('_', ''), 16)
    }
    if (/^0o[0-7](_?[0-7])*$/.test(unsigned)) {
      return sign * Number.parseInt(unsigned.slice(2).replaceAll('_', ''), 8)
    }
    if (/^0b[01](_?[01])*$/.test(unsigned)) {
      return sign * Number.parseInt(unsigned.slice(2).replaceAll('_', ''), 2)
    }
    if (/^\d(_?\d)*(\.\d(_?\d)*)?([eE][+-]?\d(_?\d)*)?$/.test(unsigned)) {
      const parsed = Number(unsigned.replaceAll('_', ''))
      if (!Number.isFinite(parsed)) this.fail(`unsupported number \`${raw}\``)
      return sign * parsed
    }
    this.fail(`unsupported value \`${raw}\` (datetimes are not supported)`)
  }

  // -------------------------------------------------------------- strings

  private parseBasicString(): string {
    this.expect('"')
    let out = ''
    for (;;) {
      if (this.eof()) this.fail('unterminated string')
      const character = this.peek()
      if (character === '\n') this.fail('unterminated string')
      this.index++
      if (character === '"') return out
      if (character === '\\') {
        out += this.readEscape()
        continue
      }
      out += character
    }
  }

  private parseMultilineBasicString(): string {
    this.index += 3
    // A newline immediately after the opening delimiter is not content.
    if (this.peek() === '\r') this.index++
    if (this.peek() === '\n') this.index++
    let out = ''
    for (;;) {
      if (this.eof()) this.fail('unterminated multi-line string')
      if (this.peek() === '"' && this.peek(1) === '"' && this.peek(2) === '"') {
        this.index += 3
        // Up to two extra quotes belong to the content, per the spec.
        while (this.peek() === '"' && out.length > 0) {
          out += '"'
          this.index++
        }
        return out
      }
      const character = this.peek()
      this.index++
      if (character === '\\') {
        // A backslash before a newline swallows the newline and the following
        // whitespace (line-ending backslash).
        let lookahead = this.index
        while (' \t'.includes(this.source[lookahead] ?? '')) lookahead++
        if (
          (this.source[lookahead] ?? '') === '\n' ||
          (this.source[lookahead] ?? '') === '\r'
        ) {
          this.index = lookahead
          this.skipTrivia()
          continue
        }
        out += this.readEscape()
        continue
      }
      out += character
    }
  }

  private parseLiteralString(): string {
    this.expect("'")
    let out = ''
    for (;;) {
      if (this.eof()) this.fail('unterminated string')
      const character = this.peek()
      if (character === '\n') this.fail('unterminated string')
      this.index++
      if (character === "'") return out
      out += character
    }
  }

  private parseMultilineLiteralString(): string {
    this.index += 3
    if (this.peek() === '\r') this.index++
    if (this.peek() === '\n') this.index++
    let out = ''
    for (;;) {
      if (this.eof()) this.fail('unterminated multi-line string')
      if (this.peek() === "'" && this.peek(1) === "'" && this.peek(2) === "'") {
        this.index += 3
        while (this.peek() === "'" && out.length > 0) {
          out += "'"
          this.index++
        }
        return out
      }
      out += this.peek()
      this.index++
    }
  }

  private readEscape(): string {
    const character = this.peek()
    this.index++
    switch (character) {
      case 'b':
        return '\b'
      case 't':
        return '\t'
      case 'n':
        return '\n'
      case 'f':
        return '\f'
      case 'r':
        return '\r'
      case '"':
        return '"'
      case '\\':
        return '\\'
      case 'u':
        return this.readUnicodeEscape(4)
      case 'U':
        return this.readUnicodeEscape(8)
      default:
        this.fail(`unsupported escape \`\\${character}\``)
    }
  }

  private readUnicodeEscape(length: number): string {
    const digits = this.source.slice(this.index, this.index + length)
    if (digits.length !== length || !/^[0-9A-Fa-f]+$/.test(digits)) {
      this.fail('malformed unicode escape')
    }
    this.index += length
    const codePoint = Number.parseInt(digits, 16)
    if (codePoint > 0x10ffff) this.fail('unicode escape out of range')
    return String.fromCodePoint(codePoint)
  }
}

function isPlainTable(value: unknown): value is TomlTable {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
