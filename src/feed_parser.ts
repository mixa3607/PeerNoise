import { XMLParser, XMLValidator } from "fast-xml-parser";

export interface Entry {
  title: string;
  url: string;
}

const xml = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  parseTagValue: false,
  processEntities: false,
});

function list(value: unknown): unknown[] {
  return value == null ? [] : Array.isArray(value) ? value : [value];
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
}
function text(value: unknown): string {
  return typeof value === "string"
    ? value
    : String(object(value)["#text"] ?? "");
}
function unescape(value: string) {
  return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
function link(value: string, base: string): string | undefined {
  try {
    const url = new URL(unescape(value.trim()), base);
    if (["http:", "https:", "magnet:"].includes(url.protocol)) return url.href;
  } catch { /* Ignore invalid links in a feed. */ }
}

export function pageLinks(html: string, base: string): string[] {
  return [...unescape(html).matchAll(/href\s*=\s*["']([^"']+)["']/gi)]
    .map((m) => link(m[1], base))
    .filter((url): url is string =>
      !!url &&
      (url.startsWith("magnet:") || /\.torrent(?:[?#]|$)/i.test(url))
    );
}

export function parseFeed(body: string, base: string): Entry[] {
  const valid = XMLValidator.validate(body);
  if (valid !== true) throw new Error(`Invalid RSS/Atom: ${valid.err.msg}`);
  const doc = xml.parse(body);
  const items = doc.rss?.channel?.item ?? doc.feed?.entry;
  if (!doc.rss && !doc.feed) {
    throw new Error("Expected RSS or Atom, not an HTML page");
  }
  const entries = list(items).flatMap((value) => {
    const item = object(value);
    const links = [
      ...list(item.enclosure).map((v) => text(object(v)["@_url"])),
      ...list(item.link).map((v) => text(object(v)["@_href"]) || text(v)),
      ...pageLinks(
        text(item.description) + text(item.content) + text(item.summary),
        base,
      ),
    ].map((v) => v ? link(v, base) : undefined).filter((v): v is string => !!v);
    // Prefer explicit magnets/torrent enclosures over a topic page.
    const url = links.find((v) => v.startsWith("magnet:")) ??
      links.find((v) => /\.torrent(?:[?#]|$)/i.test(v)) ?? links[0];
    return url ? [{ title: unescape(text(item.title)), url }] : [];
  });
  return [...new Map(entries.map((entry) => [entry.url, entry])).values()];
}
