import parseTorrent from "parse-torrent";
import { Buffer } from "node:buffer";
import type { FeedConfig } from "./config.ts";
import { type Entry, pageLinks, parseFeed } from "./feed_parser.ts";
export interface Torrent {
  infoHash: string;
  name: string;
  announce: string[];
  length?: number;
}

export class FeedReader {
  private client: Deno.HttpClient;
  constructor(readonly config: FeedConfig, private signal?: AbortSignal) {
    this.client = Deno.createHttpClient({
      proxy: config.proxy ? { url: config.proxy } : undefined,
    });
  }

  async get(url: string, maxBytes = 4_000_000) {
    const response = await fetch(url, {
      client: this.client,
      signal: AbortSignal.any([
        AbortSignal.timeout(20_000),
        ...(this.signal ? [this.signal] : []),
      ]),
      headers: { "User-Agent": "PeerNoise/0.2" },
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status}: ${url}`);
    }
    const chunks: Uint8Array[] = [];
    let length = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > maxBytes) throw new Error(`Response too large: ${url}`);
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    return { body: Buffer.concat(chunks), url: response.url };
  }

  async entries() {
    const response = await this.get(this.config.url, 8_000_000);
    return parseFeed(response.body.toString("utf8"), response.url);
  }

  async resolve(entry: Entry): Promise<Torrent> {
    let input: string | Uint8Array = entry.url;
    if (!entry.url.startsWith("magnet:")) {
      const response = await this.get(entry.url);
      if (response.body[0] === 0x64) {
        input = response.body;
      } else {
        const links = pageLinks(response.body.toString("utf8"), response.url);
        const target = links.find((v) => v.startsWith("magnet:")) ?? links[0];
        if (!target) {
          throw new Error(
            "Page has no magnet or .torrent link (login may be required)",
          );
        }
        input = target.startsWith("magnet:")
          ? target
          : (await this.get(target)).body;
      }
    }
    const torrent = await parseTorrent(input);
    if (!torrent.infoHash || !/^[0-9a-f]{40}$/i.test(torrent.infoHash)) {
      throw new Error("No BitTorrent v1 infohash");
    }
    if (torrent.private) throw new Error("Private torrent skipped");
    return {
      infoHash: torrent.infoHash.toLowerCase(),
      name: torrent.name || entry.title,
      announce: (torrent.announce ?? []).filter((url: string) =>
        /^(https?|udp):\/\//.test(url)
      ),
      length: typeof torrent.length === "number" ? torrent.length : undefined,
    };
  }

  close() {
    this.client.close();
  }
}
