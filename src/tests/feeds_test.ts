import { parseConfig } from "../config.ts";
import { FeedReader } from "../feed_reader.ts";
import { parseFeed } from "../feed_parser.ts";
import { FeedScheduler } from "../feed_scheduler.ts";
import { Metrics } from "../metrics.ts";
import { createServer } from "node:http";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

Deno.test("RSS: prefer enclosure, decode query parameters, deduplicate", () => {
  const items =
    `<item><title>Linux</title><link>https://example.org/topic/1</link>
    <enclosure url="https://example.org/download?id=1&amp;pass=2" type="application/x-bittorrent"/>
    </item>`;
  equal(
    parseFeed(
      `<rss><channel>${items}${items}</channel></rss>`,
      "https://example.org/rss",
    ),
    [
      { title: "Linux", url: "https://example.org/download?id=1&pass=2" },
    ],
  );
});

Deno.test("Atom: topic link and magnet in escaped content", () => {
  const hash = "ab".repeat(20);
  const entries = parseFeed(
    `<feed xmlns="http://www.w3.org/2005/Atom">
    <entry><title>Topic</title><link href="/forum/viewtopic.php?t=1"/></entry>
    <entry><title>Magnet</title><link href="/topic/2"/>
    <content>&lt;a href=&quot;magnet:?xt=urn:btih:${hash}&amp;dn=Linux&quot;&gt;magnet&lt;/a&gt;</content>
    </entry></feed>`,
    "https://example.org/feed",
  );
  equal(entries[0].url, "https://example.org/forum/viewtopic.php?t=1");
  equal(entries[1].url, `magnet:?xt=urn:btih:${hash}&dn=Linux`);
});

Deno.test("YAML: per-feed proxy/count and invalid refresh rejected", () => {
  const config = parseConfig(`count: 7
feeds:
  - url: https://example.org/rss
    proxy: http://192.168.1.200:2080
    count: 2
  - url: https://example.org/atom
`);
  equal(config.feeds.map((feed) => [feed.count, feed.proxy]), [
    [2, "http://192.168.1.200:2080/"],
    [7, undefined],
  ]);
  let rejected = false;
  try {
    parseConfig("refresh_minutes: 0\nfeeds:\n  - url: https://example.org/rss");
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("Invalid interval accepted");
});

Deno.test("refresh replaces selection, preserves it on failure, and does not overlap", async () => {
  let hash = "ab".repeat(20);
  let failed = false;
  let requests = 0;
  let selected: string[] = [];
  const metrics = new Metrics();
  const server = createServer((_req, res) => {
    requests++;
    if (failed) {
      res.writeHead(503).end();
      return;
    }
    res.end(`<rss><channel><item><title>Test</title>
      <link>magnet:?xt=urn:btih:${hash}</link></item></channel></rss>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const scheduler = new FeedScheduler(
    [{
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/rss`,
      count: 1,
    }],
    30,
    (torrents) => selected = torrents.map((torrent) => torrent.infoHash),
    metrics,
  );
  try {
    await Promise.all([scheduler.refresh(), scheduler.refresh()]);
    equal(requests, 1);
    equal(selected, [hash]);
    hash = "cd".repeat(20);
    await scheduler.refresh();
    equal(selected, [hash]);
    failed = true;
    await scheduler.refresh();
    equal(selected, [hash]);
    const response = await metrics.handle(
      new Request("http://localhost/metrics"),
    );
    const body = await response.text();
    for (
      const sample of [
        'peernoise_rss_selected{feed="0"} 1',
        'peernoise_rss_refreshes_total{feed="0",result="success"} 2',
        'peernoise_rss_refreshes_total{feed="0",result="error"} 1',
      ]
    ) {
      if (!body.includes(sample)) throw new Error(`Missing sample: ${sample}`);
    }
  } finally {
    scheduler.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
});

Deno.test("feed, topic page and torrent use the configured proxy; magnets need no payload", async () => {
  const hash = "ab".repeat(20);
  const seen: string[] = [];
  // A local HTTP proxy: target.invalid must never be resolved or contacted directly.
  const respond = (path: string) => {
    seen.push(path);
    if (path === "/rss") {
      return "<rss><channel><item><title>Test</title><link>http://target.invalid/topic</link></item></channel></rss>";
    }
    if (path === "/topic") return '<a href="/file.torrent">torrent</a>';
    return `d4:infod6:lengthi123e4:name4:test12:piece lengthi16384e6:pieces20:aaaaaaaaaaaaaaaaaaaaee`;
  };
  const proxy = createServer((req, res) =>
    res.end(respond(new URL(req.url!).pathname))
  );
  // Deno's client tunnels HTTP requests through CONNECT as well as HTTPS.
  const tunnelServer = createServer((req, res) => res.end(respond(req.url!)));
  await new Promise<void>((resolve) =>
    tunnelServer.listen(0, "127.0.0.1", resolve)
  );
  proxy.on("connect", (_req, socket, head) => {
    const upstream = connect(
      (tunnelServer.address() as AddressInfo).port,
      "127.0.0.1",
      () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      },
    );
    socket.on("error", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
    upstream.on("close", () => socket.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const reader = new FeedReader({
    url: "http://target.invalid/rss",
    proxy: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
    count: 1,
  });
  try {
    const [entry] = await reader.entries();
    const torrent = await reader.resolve(entry);
    equal(torrent.length, 123);
    equal(seen, ["/rss", "/topic", "/file.torrent"]);
    const magnet = await reader.resolve({
      title: "Magnet",
      url: `magnet:?xt=urn:btih:${hash}`,
    });
    equal(magnet.infoHash, hash);
    equal(magnet.length, undefined);
    equal(seen.length, 3);
  } finally {
    reader.close();
    await Promise.all(
      [proxy, tunnelServer].map((server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        })
      ),
    );
  }
});
