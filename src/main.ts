import { parseConfig } from "./config.ts";
import { FeedScheduler } from "./feed_scheduler.ts";
import { TorrentSession } from "./torrent_session.ts";
import { Metrics } from "./metrics.ts";

const config = parseConfig(
  await Deno.readTextFile(Deno.args[0] ?? "config.yaml"),
);
let stopping = false;
const metrics = new Metrics();
const session = new TorrentSession(config.port, (error) => {
  console.error(`[TCP] ${error.message}`);
  Deno.exitCode = 1;
  shutdown();
}, metrics);
const scheduler = new FeedScheduler(
  config.feeds,
  config.refreshMinutes,
  (torrents) => session.sync(torrents),
  metrics,
);

function shutdown() {
  if (stopping) return;
  stopping = true;
  scheduler.close();
  session.close();
  metrics.close().catch(console.error);
}

Deno.addSignalListener("SIGINT", shutdown);
Deno.addSignalListener("SIGTERM", shutdown);

try {
  metrics.start(config.metrics.host, config.metrics.port);
  await session.start();
  if (!stopping) await scheduler.refresh();
} catch (error) {
  if (!stopping) {
    console.error(error);
    Deno.exitCode = 1;
    shutdown();
  }
}
