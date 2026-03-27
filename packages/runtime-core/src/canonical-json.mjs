import { Buffer } from 'node:buffer';

const textEncoder = new TextEncoder();

function syntaxError(message, index) {
  return new SyntaxError(`${message} at character ${index}`);
}

class JsonTextParser {
  constructor(text) {
    this.text = text;
    this.index = 0;
  }

  parse() {
    this.skipWhitespace();
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.index !== this.text.length) {
      throw syntaxError('Unexpected trailing content', this.index);
    }
    return value;
  }

  parseValue() {
    const char = this.text[this.index];
    if (char === '"') {
      return this.parseString();
    }
    if (char === '{') {
      return this.parseObject();
    }
    if (char === '[') {
      return this.parseArray();
    }
    if (char === 't') {
      this.expectKeyword('true');
      return true;
    }
    if (char === 'f') {
      this.expectKeyword('false');
      return false;
    }
    if (char === 'n') {
      this.expectKeyword('null');
      return null;
    }
    if (char === '-' || (char >= '0' && char <= '9')) {
      return this.parseNumber();
    }
    throw syntaxError('Unexpected token', this.index);
  }

  parseObject() {
    const object = {};
    const seenKeys = new Set();
    this.index += 1;
    this.skipWhitespace();

    if (this.text[this.index] === '}') {
      this.index += 1;
      return object;
    }

    while (this.index < this.text.length) {
      const key = this.parseString();
      if (seenKeys.has(key)) {
        throw syntaxError(`Duplicate key "${key}"`, this.index);
      }
      seenKeys.add(key);
      this.skipWhitespace();
      this.expectCharacter(':');
      this.skipWhitespace();
      object[key] = this.parseValue();
      this.skipWhitespace();

      const char = this.text[this.index];
      if (char === '}') {
        this.index += 1;
        return object;
      }
      this.expectCharacter(',');
      this.skipWhitespace();
    }

    throw syntaxError('Unterminated object literal', this.index);
  }

  parseArray() {
    const array = [];
    this.index += 1;
    this.skipWhitespace();

    if (this.text[this.index] === ']') {
      this.index += 1;
      return array;
    }

    while (this.index < this.text.length) {
      array.push(this.parseValue());
      this.skipWhitespace();

      const char = this.text[this.index];
      if (char === ']') {
        this.index += 1;
        return array;
      }
      this.expectCharacter(',');
      this.skipWhitespace();
    }

    throw syntaxError('Unterminated array literal', this.index);
  }

  parseString() {
    let result = '';
    this.expectCharacter('"');

    while (this.index < this.text.length) {
      const char = this.text[this.index];
      this.index += 1;

      if (char === '"') {
        return result;
      }
      if (char === '\\') {
        result += this.parseEscapeSequence();
        continue;
      }
      if (char < ' ') {
        throw syntaxError('Unescaped control character in string', this.index - 1);
      }
      result += char;
    }

    throw syntaxError('Unterminated string literal', this.index);
  }

  parseEscapeSequence() {
    const char = this.text[this.index];
    this.index += 1;

    switch (char) {
      case '"':
      case '\\':
      case '/':
        return char;
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case 'u': {
        const hex = this.text.slice(this.index, this.index + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          throw syntaxError('Invalid unicode escape sequence', this.index);
        }
        this.index += 4;
        return String.fromCharCode(Number.parseInt(hex, 16));
      }
      default:
        throw syntaxError('Invalid escape sequence', this.index - 1);
    }
  }

  parseNumber() {
    const startIndex = this.index;
    const remaining = this.text.slice(this.index);
    const match = remaining.match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!match) {
      throw syntaxError('Invalid number', this.index);
    }
    const raw = match[0];
    this.index += raw.length;
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      throw syntaxError('Non-finite numbers are not allowed', startIndex);
    }
    return value;
  }

  expectKeyword(keyword) {
    if (this.text.slice(this.index, this.index + keyword.length) !== keyword) {
      throw syntaxError(`Expected ${keyword}`, this.index);
    }
    this.index += keyword.length;
  }

  expectCharacter(char) {
    if (this.text[this.index] !== char) {
      throw syntaxError(`Expected "${char}"`, this.index);
    }
    this.index += 1;
  }

  skipWhitespace() {
    while (this.index < this.text.length) {
      const char = this.text[this.index];
      if (char === ' ' || char === '\n' || char === '\r' || char === '\t') {
        this.index += 1;
        continue;
      }
      break;
    }
  }
}

function isPlainObject(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertCanonicalCompatible(value, path) {
  if (value === null) {
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw new TypeError(`Sparse arrays are not allowed at ${path}[${index}]`);
      }
      assertCanonicalCompatible(value[index], `${path}[${index}]`);
    }
    return;
  }
  const valueType = typeof value;
  if (valueType === 'boolean' || valueType === 'string') {
    return;
  }
  if (valueType === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Non-finite numbers are not allowed at ${path}`);
    }
    return;
  }
  if (!isPlainObject(value)) {
    throw new TypeError(`Unsupported JSON value at ${path}`);
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    assertCanonicalCompatible(nestedValue, `${path}.${key}`);
  }
}

function renderCanonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => renderCanonicalJson(item)).join(',')}]`;
  }

  const sortedEntries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${renderCanonicalJson(value[key])}`);
  return `{${sortedEntries.join(',')}}`;
}

export function parseJsonTextWithDuplicateKeyCheck(text) {
  if (typeof text !== 'string') {
    throw new TypeError('JSON text input must be a string');
  }
  return new JsonTextParser(text).parse();
}

export function canonicalizeJsonValue(value) {
  assertCanonicalCompatible(value, '$');
  return renderCanonicalJson(value);
}

export function canonicalizeJsonText(text) {
  return canonicalizeJsonValue(parseJsonTextWithDuplicateKeyCheck(text));
}

export function canonicalJsonBytes(input) {
  if (typeof input === 'string') {
    return textEncoder.encode(canonicalizeJsonText(input));
  }
  if (input instanceof Uint8Array || Buffer.isBuffer(input)) {
    throw new TypeError('Byte arrays cannot be canonicalized as JSON directly');
  }
  return textEncoder.encode(canonicalizeJsonValue(input));
}
