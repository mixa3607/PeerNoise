import { Metrics } from "../metrics.ts";

Deno.test("/metrics exports Prometheus values without sharing registries", async () => {
  const metrics = new Metrics();
  metrics.initFeeds(1);
  metrics.activeTorrents.set(3);
  metrics.rssRefreshes.inc({ feed: "0", result: "error" });
  metrics.handshakes.inc({ result: "accepted" });
  const server = metrics.start("127.0.0.1", 0);
  try {
    const base = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
    const response = await fetch(`${base}/metrics`);
    const body = await response.text();
    if (
      response.status !== 200 ||
      !response.headers.get("content-type")?.startsWith("text/plain")
    ) {
      throw new Error("Invalid Prometheus HTTP response");
    }
    for (
      const sample of [
        "peernoise_active_torrents 3",
        'peernoise_rss_refreshes_total{feed="0",result="error"} 1',
        'peernoise_handshakes_total{result="accepted"} 1',
        'peernoise_rss_last_success_timestamp_seconds{feed="0"} 0',
      ]
    ) {
      if (!body.includes(sample)) throw new Error(`Missing sample: ${sample}`);
    }
    const missing = await fetch(`${base}/other`);
    await missing.body?.cancel();
    if (missing.status !== 404) {
      throw new Error("Unknown path should return 404");
    }
    const other = new Metrics();
    const clean = await other.handle(new Request(`${base}/metrics`));
    if (!(await clean.text()).includes("peernoise_active_torrents 0")) {
      throw new Error("Metric instances leaked state");
    }
  } finally {
    await metrics.close();
  }
});
