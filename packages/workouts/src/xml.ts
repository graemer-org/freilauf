/**
 * A small, strict, non-validating XML reader for untrusted input. Supports elements, attributes,
 * text, comments, CDATA, processing instructions (skipped), the five predefined entities and
 * numeric character references. Rejects DOCTYPE (and therefore any entity declaration), unknown
 * entities, mismatched tags and anything outside one root element. No entity expansion, no
 * external resources. Internal to this package.
 */

export interface XmlElement {
  name: string;
  attrs: Map<string, string>;
  children: XmlElement[];
  /** Concatenated text and CDATA directly inside this element (not trimmed). */
  text: string;
}

export type XmlResult = { ok: true; root: XmlElement } | { ok: false; error: string };

export const XML_LIMITS = { maxDepth: 32, maxElements: 20_000, maxAttributes: 32 } as const;

const NAME = /[A-Za-z_:][-A-Za-z0-9_.:]*/y;
const WS = /[ \t\r\n]*/y;
const ENTITY = /&(amp|lt|gt|quot|apos|#[0-9]{1,7}|#x[0-9A-Fa-f]{1,6});/y;
const PREDEFINED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

class XmlError extends Error {}

function isXmlChar(cp: number): boolean {
  return (
    cp === 0x9 ||
    cp === 0xa ||
    cp === 0xd ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

function lineOf(src: string, pos: number): number {
  let line = 1;
  for (let i = 0; i < pos && i < src.length; i++) if (src.charCodeAt(i) === 10) line++;
  return line;
}

export function decodeEntities(raw: string): string {
  if (!raw.includes('&')) return raw;
  let out = '';
  let i = 0;
  while (i < raw.length) {
    const amp = raw.indexOf('&', i);
    if (amp === -1) {
      out += raw.slice(i);
      break;
    }
    out += raw.slice(i, amp);
    ENTITY.lastIndex = amp;
    const m = ENTITY.exec(raw);
    if (!m) throw new XmlError('unknown or malformed entity reference');
    const body = m[1] as string;
    if (body.startsWith('#')) {
      const cp = body.startsWith('#x') ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!isXmlChar(cp)) throw new XmlError('invalid character reference');
      out += String.fromCodePoint(cp);
    } else {
      out += PREDEFINED[body] as string;
    }
    i = amp + m[0].length;
  }
  return out;
}

export function parseXml(input: string): XmlResult {
  let src = input;
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  let pos = 0;
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  let elements = 0;

  const fail = (msg: string): never => {
    throw new XmlError(`${msg} (line ${lineOf(src, pos)})`);
  };
  const skipWs = () => {
    WS.lastIndex = pos;
    WS.exec(src);
    pos = WS.lastIndex;
  };
  const readName = (): string => {
    NAME.lastIndex = pos;
    const m = NAME.exec(src);
    if (!m) fail('expected a name');
    pos = NAME.lastIndex;
    return (m as RegExpExecArray)[0];
  };

  try {
    while (pos < src.length) {
      const lt = src.indexOf('<', pos);
      if (lt !== pos) {
        const end = lt === -1 ? src.length : lt;
        const raw = src.slice(pos, end);
        const top = stack[stack.length - 1];
        if (top) top.text += decodeEntities(raw);
        else if (raw.trim() !== '') fail('text outside the root element');
        pos = end;
        continue;
      }
      if (src.startsWith('<!--', pos)) {
        const end = src.indexOf('-->', pos + 4);
        if (end === -1) fail('unterminated comment');
        pos = end + 3;
      } else if (src.startsWith('<![CDATA[', pos)) {
        const end = src.indexOf(']]>', pos + 9);
        if (end === -1) fail('unterminated CDATA section');
        const top = stack[stack.length - 1];
        if (!top) fail('CDATA outside the root element');
        (top as XmlElement).text += src.slice(pos + 9, end);
        pos = end + 3;
      } else if (src.startsWith('<!', pos)) {
        fail('DOCTYPE and other declarations are not allowed');
      } else if (src.startsWith('<?', pos)) {
        const end = src.indexOf('?>', pos + 2);
        if (end === -1) fail('unterminated processing instruction');
        const target = src.slice(pos + 2, end).split(/[ \t\r\n]/, 1)[0] ?? '';
        if (target.toLowerCase() === 'xml' && pos !== 0) fail('XML declaration not at the start');
        pos = end + 2;
      } else if (src.startsWith('</', pos)) {
        pos += 2;
        const name = readName();
        skipWs();
        if (src[pos] !== '>') fail(`expected '>' after </${name}`);
        pos++;
        const open = stack.pop();
        if (!open) fail(`unexpected </${name}>`);
        if ((open as XmlElement).name !== name) {
          fail(`mismatched tag: <${(open as XmlElement).name}> closed by </${name}>`);
        }
      } else {
        pos++;
        if (root && stack.length === 0) fail('more than one root element');
        const el: XmlElement = { name: readName(), attrs: new Map(), children: [], text: '' };
        if (++elements > XML_LIMITS.maxElements) fail('too many elements');
        let selfClosing = false;
        for (;;) {
          const before = pos;
          skipWs();
          if (src.startsWith('/>', pos)) {
            pos += 2;
            selfClosing = true;
            break;
          }
          if (src[pos] === '>') {
            pos++;
            break;
          }
          if (pos === before) fail(`expected whitespace, '>' or '/>' in <${el.name}>`);
          const attr = readName();
          skipWs();
          if (src[pos] !== '=') fail(`expected '=' after attribute ${attr}`);
          pos++;
          skipWs();
          const quote = src[pos];
          if (quote !== '"' && quote !== "'") fail(`attribute ${attr} value must be quoted`);
          const end = src.indexOf(quote as string, pos + 1);
          if (end === -1) fail(`unterminated attribute ${attr}`);
          const raw = src.slice(pos + 1, end);
          if (raw.includes('<')) fail(`'<' in attribute ${attr}`);
          if (el.attrs.has(attr)) fail(`duplicate attribute ${attr}`);
          if (el.attrs.size >= XML_LIMITS.maxAttributes) fail('too many attributes');
          el.attrs.set(attr, decodeEntities(raw));
          pos = end + 1;
        }
        const parent = stack[stack.length - 1];
        if (parent) parent.children.push(el);
        else root = el;
        if (!selfClosing) {
          if (stack.length >= XML_LIMITS.maxDepth) fail('nesting too deep');
          stack.push(el);
        }
      }
    }
    if (stack.length > 0)
      fail(`unclosed element <${(stack[stack.length - 1] as XmlElement).name}>`);
    if (!root) fail('no root element');
    return { ok: true, root: root as XmlElement };
  } catch (e) {
    if (e instanceof XmlError) return { ok: false, error: `Malformed XML: ${e.message}` };
    return { ok: false, error: 'Malformed XML' };
  }
}
