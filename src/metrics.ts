import { Counter, Gauge, Histogram, Registry } from "prometheus-client";

export class Metrics {
  private registry = new Registry();
  private server?: Deno.HttpServer;
  private registers = [this.registry];

  readonly activeTorrents = new Gauge({
    name: "peernoise_active_torrents",
    help:
      "Number of locally active unique torrents (not proof of observation).",
    registers: this.registers,
  });
  readonly connections = new Gauge({
    name: "peernoise_connections",
    help: "Current incoming BitTorrent TCP connections.",
    registers: this.registers,
  });
  readonly handshakes = new Counter({
    name: "peernoise_handshakes_total",
    help: "Incoming handshakes by acceptance result.",
    labelNames: ["result"],
    registers: this.registers,
  });
  readonly dhtAnnounces = new Counter({
    name: "peernoise_dht_announces_total",
    help: "Completed DHT announce calls by result, not third-party sightings.",
    labelNames: ["result"],
    registers: this.registers,
  });
  readonly trackerResponses = new Counter({
    name: "peernoise_tracker_responses_total",
    help: "Successful tracker update responses.",
    registers: this.registers,
  });
  readonly networkWarnings = new Counter({
    name: "peernoise_network_warnings_total",
    help: "Network warnings and errors by subsystem.",
    labelNames: ["source"],
    registers: this.registers,
  });
  readonly rssRefreshes = new Counter({
    name: "peernoise_rss_refreshes_total",
    help: "Completed per-feed refresh attempts by result.",
    labelNames: ["feed", "result"],
    registers: this.registers,
  });
  readonly rssEntries = new Gauge({
    name: "peernoise_rss_entries",
    help: "Entries found in the last fetched feed.",
    labelNames: ["feed"],
    registers: this.registers,
  });
  readonly rssSelected = new Gauge({
    name: "peernoise_rss_selected",
    help: "Current selection size per feed, retained after failed refreshes.",
    labelNames: ["feed"],
    registers: this.registers,
  });
  readonly rssLastSuccess = new Gauge({
    name: "peernoise_rss_last_success_timestamp_seconds",
    help: "Unix time of the last successful per-feed selection refresh.",
    labelNames: ["feed"],
    registers: this.registers,
  });
  readonly rssResolveErrors = new Counter({
    name: "peernoise_rss_resolve_errors_total",
    help: "Failed entry resolution attempts per feed.",
    labelNames: ["feed"],
    registers: this.registers,
  });
  readonly rssDuration = new Histogram({
    name: "peernoise_rss_refresh_duration_seconds",
    help: "Per-feed refresh duration including entry resolution.",
    labelNames: ["feed"],
    buckets: [0.1, 1, 5, 20, 60, 300],
    registers: this.registers,
  });

  initFeeds(count: number) {
    for (let i = 0; i < count; i++) {
      const feed = String(i);
      this.rssSelected.set({ feed }, 0);
      this.rssLastSuccess.set({ feed }, 0);
    }
  }

  start(hostname: string, port: number) {
    this.server = Deno.serve(
      { hostname, port },
      (request) => this.handle(request),
    );
    return this.server;
  }

  async handle(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== "/metrics") {
      return new Response("Not found\n", { status: 404 });
    }
    if (request.method !== "GET") {
      return new Response("Method not allowed\n", {
        status: 405,
        headers: { Allow: "GET" },
      });
    }
    return new Response(await this.registry.metrics(), {
      headers: { "Content-Type": this.registry.contentType },
    });
  }

  close(): Promise<void> {
    return this.server?.shutdown() ?? Promise.resolve();
  }
}
