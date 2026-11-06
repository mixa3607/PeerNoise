import { parse } from "yaml";

export interface FeedConfig {
  url: string;
  proxy?: string;
  count: number;
}

function integer(value: unknown, name: string, min: number, max: number) {
  if (
    typeof value !== "number" || !Number.isInteger(value) || value < min ||
    value > max
  ) {
    throw new Error(`${name}: expected integer ${min}..${max}`);
  }
  return value;
}

function httpUrl(value: unknown, name: string) {
  if (typeof value !== "string" || !/^https?:\/\//.test(value)) {
    throw new Error(`${name}: expected http(s) URL`);
  }
  return new URL(value).href;
}

export function parseConfig(text: string) {
  const raw = parse(text);
  if (!raw || !Array.isArray(raw.feeds) || !raw.feeds.length) {
    throw new Error("config: feeds must be a non-empty list");
  }
  const count = integer(raw.count ?? 5, "count", 1, 100);
  const feeds: FeedConfig[] = raw.feeds.map(
    (feed: Record<string, unknown>, i: number) => {
      if (!feed || typeof feed !== "object") {
        throw new Error(`feeds[${i}]: expected object`);
      }
      return {
        url: httpUrl(feed.url, `feeds[${i}].url`),
        proxy: feed.proxy == null
          ? undefined
          : httpUrl(feed.proxy, `feeds[${i}].proxy`),
        count: integer(feed.count ?? count, `feeds[${i}].count`, 1, 100),
      };
    },
  );
  return {
    metrics: {
      host: typeof raw.metrics?.host === "string"
        ? raw.metrics.host
        : "127.0.0.1",
      port: integer(raw.metrics?.port ?? 9090, "metrics.port", 1024, 65535),
    },
    port: integer(raw.port ?? 6881, "port", 1024, 65535),
    refreshMinutes: integer(
      raw.refresh_minutes ?? 30,
      "refresh_minutes",
      1,
      1440,
    ),
    feeds,
  };
}
