import Wire from "bittorrent-protocol";
import { Buffer } from "node:buffer";
import { createWire } from "../protocol.ts";

Deno.test("handshake works, but unchoking never triggers a block request", async () => {
  const hash = Buffer.alloc(20, 1);
  const local = createWire(
    Buffer.alloc(20, 2),
    (id) => id === hash.toString("hex"),
  );
  const remote = new Wire();
  let requested = false;
  let interested = false;
  remote.on("request", () => requested = true);
  remote.on("interested", () => interested = true);
  local.pipe(remote).pipe(local);
  try {
    const handshake = new Promise<void>((resolve) => {
      remote.once("handshake", () => resolve());
    });
    remote.handshake(hash, Buffer.alloc(20, 3));
    await handshake;
    remote.have(0);
    remote.unchoke();
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (requested || interested) {
      throw new Error("Unexpected download activity");
    }
    if (!remote.peerChoking) throw new Error("Should remain choked");
  } finally {
    local.destroy();
    remote.destroy();
  }
});

Deno.test("unknown torrent is rejected", async () => {
  const local = createWire(Buffer.alloc(20, 2), () => false);
  const remote = new Wire();
  local.pipe(remote).pipe(local);
  try {
    const closed = new Promise<void>((resolve) => local.once("close", resolve));
    remote.handshake(Buffer.alloc(20, 1), Buffer.alloc(20, 3));
    await closed;
  } finally {
    local.destroy();
    remote.destroy();
  }
});
