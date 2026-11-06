import type { FeedConfig } from "./config.ts";
import { FeedReader, type Torrent } from "./feed_reader.ts";
import { Metrics } from "./metrics.ts";

function shuffle<T>(values: T[]): T[] {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export class FeedScheduler {
  private abort = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private feeds;

  constructor(
    feeds: FeedConfig[],
    private refreshMinutes: number,
    private onUpdate: (torrents: Torrent[]) => void,
    private metrics = new Metrics(),
  ) {
    this.metrics.initFeeds(feeds.length);
    this.feeds = feeds.map((config) => ({
      reader: new FeedReader(config, this.abort.signal),
      selected: new Map<string, Torrent>(),
    }));
  }

  // Sharing the in-flight promise also prevents manual overlapping refreshes.
  refresh(): Promise<void> {
    if (this.abort.signal.aborted) return Promise.resolve();
    if (this.running) return this.running;
    clearTimeout(this.timer);
    this.running = this.update().finally(() => {
      this.running = undefined;
      if (!this.abort.signal.aborted) {
        this.timer = setTimeout(
          () => this.refresh(),
          this.refreshMinutes * 60_000,
        );
      }
    });
    return this.running;
  }

  private async update() {
    await Promise.all(this.feeds.map(async (feed, index) => {
      const { reader } = feed;
      const label = String(index);
      const end = this.metrics.rssDuration.startTimer({ feed: label });
      let result = "error";
      try {
        const entries = shuffle(await reader.entries());
        this.metrics.rssEntries.set({ feed: label }, entries.length);
        if (!entries.length) {
          throw new Error("No usable entries; keeping previous selection");
        }
        const next = new Map<string, Torrent>();
        const hashes = new Set<string>();
        for (const entry of entries.slice(0, reader.config.count * 3)) {
          if (this.abort.signal.aborted || next.size >= reader.config.count) {
            break;
          }
          try {
            const torrent = feed.selected.get(entry.url) ??
              await reader.resolve(entry);
            if (hashes.has(torrent.infoHash)) continue;
            hashes.add(torrent.infoHash);
            next.set(entry.url, torrent);
          } catch (error) {
            if (!this.abort.signal.aborted) {
              this.metrics.rssResolveErrors.inc({ feed: label });
            }
            this.warn(`${reader.config.url} → ${entry.url}`, error);
          }
        }
        if (this.abort.signal.aborted) return;
        if (!next.size) {
          throw new Error("No torrents resolved; keeping previous selection");
        }
        feed.selected = next;
        result = "success";
        this.metrics.rssSelected.set({ feed: label }, next.size);
        this.metrics.rssLastSuccess.set({ feed: label }, Date.now() / 1000);
        console.log(
          `[RSS ${reader.config.url}] ${entries.length} entries, selected ${next.size}`,
        );
      } catch (error) {
        this.warn(reader.config.url, error);
      } finally {
        if (!this.abort.signal.aborted) {
          this.metrics.rssRefreshes.inc({ feed: label, result });
          end();
        }
      }
    }));
    if (this.abort.signal.aborted) return;
    const desired = new Map(
      this.feeds.flatMap((feed) =>
        [...feed.selected.values()].map((torrent) =>
          [torrent.infoHash, torrent] as const
        )
      ),
    );
    this.onUpdate([...desired.values()]);
    console.log(`Next RSS refresh in ${this.refreshMinutes} min.`);
  }

  private warn(source: string, error: unknown) {
    if (!this.abort.signal.aborted) {
      console.warn(
        `[${source}] ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  close() {
    this.abort.abort();
    clearTimeout(this.timer);
    for (const feed of this.feeds) feed.reader.close();
  }
}
