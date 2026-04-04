import { useEffect, useRef, useState } from 'react';

export interface MjpegFrame {
  bytes: Uint8Array;
  seq: number;
  uri: string; // data:image/jpeg;base64,...
}

function bytesToBase64(bytes: Uint8Array): string {
  // Process in chunks to avoid call-stack overflow on large frames
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...(bytes.subarray(i, Math.min(i + CHUNK, bytes.length)) as unknown as number[]));
  }
  return btoa(binary);
}

export function useMjpegStream(ip: string | null) {
  const [frame, setFrame] = useState<MjpegFrame | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    if (!ip) return;

    const abort = new AbortController();

    (async () => {
      try {
        const res = await fetch(`http://${ip}:81/stream`, {
          signal: abort.signal,
        });

        if (!res.body) {
          console.warn('[DoorCam] stream: no readable body');
          return;
        }

        const reader = res.body.getReader();
        // Accumulate raw bytes; scan for JPEG SOI (FF D8) / EOI (FF D9) markers
        let buf = new Uint8Array(0);

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          // Append chunk
          const next = new Uint8Array(buf.length + value.length);
          next.set(buf);
          next.set(value, buf.length);
          buf = next;

          // Extract all complete JPEG frames from the buffer
          let offset = 0;
          while (offset < buf.length - 1) {
            // Find SOI
            let soi = -1;
            for (let i = offset; i < buf.length - 1; i++) {
              if (buf[i] === 0xff && buf[i + 1] === 0xd8) { soi = i; break; }
            }
            if (soi === -1) break;

            // Find EOI after SOI
            let eoi = -1;
            for (let i = soi + 2; i < buf.length - 1; i++) {
              if (buf[i] === 0xff && buf[i + 1] === 0xd9) { eoi = i + 1; break; }
            }
            if (eoi === -1) {
              // Incomplete frame — keep from SOI onward, wait for more data
              buf = buf.slice(soi);
              offset = 0;
              break;
            }

            const jpeg = buf.slice(soi, eoi + 1);
            const seq = ++seqRef.current;
            const b64 = bytesToBase64(jpeg);
            setFrame({ bytes: jpeg, seq, uri: `data:image/jpeg;base64,${b64}` });

            offset = eoi + 1;
          }

          // Discard already-processed bytes; guard against unbounded growth
          if (offset > 0) buf = buf.slice(offset);
          if (buf.length > 300_000) buf = new Uint8Array(0);
        }
      } catch (e: unknown) {
        if (e instanceof Error && e.name !== 'AbortError') {
          console.warn('[DoorCam] stream error:', e.message);
        }
      }
    })();

    return () => abort.abort();
  }, [ip]);

  return frame;
}
