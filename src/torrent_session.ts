import DHT from "bittorrent-dht";
import Tracker from "bittorrent-tracker";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { createWire } from "./protocol.ts";
import type { Torrent } from "./feed_reader.ts";
import { Metrics } from "./metrics.ts";

export class TorrentSession {
  private peerId = Buffer.concat([Buffer.from("-PN0001-"), randomBytes(12)]);
  private active = new Map<string, InstanceType<typeof Tracker> | undefined>();
  private sockets = new Map<Socket, string | undefined>();
  private dht = new DHT();
  private server = createServer((socket) => this.accept(socket));
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(
    private port: number,
    private onError: (error: Error) => void,
    private metrics = new Metrics(),
  ) {
    this.server.on("error", (error) => this.onError(error));
    this.dht.on("error", (error: Error) => this.warn("DHT", error));
    this.dht.on("warning", (error: Error) => this.warn("DHT", error));
  }

  async start() {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, () => {
        this.server.removeListener("error", reject);
        resolve();
      });
    });
    if (this.closed) return;
    await new Promise<void>((resolve, reject) => {
      this.dht.once("error", reject);
      this.dht.listen(this.port, () => {
        this.dht.removeListener("error", reject);
        resolve();
      });
    });
    if (this.closed) return;
    this.timer = setInterval(() => {
      for (const hash of this.active.keys()) this.announce(hash);
    }, 20 * 60_000);
  }

  private accept(socket: Socket) {
    if (this.sockets.size >= 32 || this.closed) {
      socket.destroy();
      return;
    }
    this.sockets.set(socket, undefined);
    this.metrics.connections.set(this.sockets.size);
    const wire = createWire(this.peerId, (hash) => {
      this.sockets.set(socket, hash);
      const accepted = this.active.has(hash);
      this.metrics.handshakes.inc({
        result: accepted ? "accepted" : "rejected",
      });
      return accepted;
    });
    const deadline = setTimeout(() => socket.destroy(), 30_000);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      clearTimeout(deadline);
      this.sockets.delete(socket);
      this.metrics.connections.set(this.sockets.size);
      wire.destroy();
    });
    wire.on("close", () => socket.destroy());
    socket.pipe(wire).pipe(socket);
  }

  private announce(hash: string) {
    this.dht.announce(hash, this.port, (error?: Error) => {
      if (this.closed) return;
      this.metrics.dhtAnnounces.inc({ result: error ? "error" : "success" });
      if (error) this.warn("DHT", error);
    });
  }

  private remove(hash: string) {
    const tracker = this.active.get(hash);
    tracker?.stop();
    tracker?.destroy();
    this.active.delete(hash);
    this.metrics.activeTorrents.set(this.active.size);
    for (const [socket, infoHash] of this.sockets) {
      if (infoHash === hash) socket.destroy();
    }
  }

  sync(torrents: Torrent[]) {
    if (this.closed) return;
    const desired = new Map(
      torrents.map((torrent) => [torrent.infoHash, torrent]),
    );
    for (const hash of this.active.keys()) {
      if (!desired.has(hash)) this.remove(hash);
    }
    for (const [hash, torrent] of desired) {
      if (this.active.has(hash)) continue;
      try {
        // Magnets lack a reliable size: never invent tracker stats.
        const tracker = torrent.length && torrent.announce.length
          ? new Tracker({
            infoHash: hash,
            peerId: this.peerId,
            port: this.port,
            announce: torrent.announce,
            wrtc: false,
            getAnnounceOpts: () => ({
              uploaded: 0,
              downloaded: 0,
              left: torrent.length,
            }),
          })
          : undefined;
        this.active.set(hash, tracker);
        this.metrics.activeTorrents.set(this.active.size);
        tracker?.on("update", () => this.metrics.trackerResponses.inc());
        tracker?.on(
          "error",
          (error: Error) => this.warn(`tracker ${hash}`, error),
        );
        tracker?.on(
          "warning",
          (error: Error) => this.warn(`tracker ${hash}`, error),
        );
        tracker?.start();
        this.announce(hash);
        console.log(
          `+ ${hash}  ${torrent.name}${tracker ? "" : " [DHT only]"}`,
        );
      } catch (error) {
        this.remove(hash);
        this.warn(hash, error);
      }
    }
    console.log(
      `Active: ${this.active.size}. TCP/UDP: ${this.port}. No file blocks requested.`,
    );
  }

  private warn(source: string, error: unknown) {
    if (!this.closed) {
      this.metrics.networkWarnings.inc({
        source: source.startsWith("tracker ")
          ? "tracker"
          : source === "DHT"
          ? "dht"
          : "session",
      });
      console.warn(
        `[${source}] ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.server.close();
    for (const socket of this.sockets.keys()) socket.destroy();
    for (const hash of this.active.keys()) this.remove(hash);
    this.dht.destroy();
  }
}
