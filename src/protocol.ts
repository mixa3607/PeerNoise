import Wire from "bittorrent-protocol";
import { Buffer } from "node:buffer";

// No download engine: never send interested/request, and never claim pieces.
export function createWire(
  peerId: Buffer,
  accepts: (infoHash: string) => boolean,
) {
  const wire = new Wire();
  wire.once("handshake", (hash: Buffer) => {
    if (!accepts(hash.toString("hex"))) {
      wire.destroy();
      return;
    }
    wire.handshake(hash, peerId);
  });
  wire.on("error", () => wire.destroy());
  return wire;
}
