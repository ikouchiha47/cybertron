declare module "react-native-udp" {
  import { EventEmitter } from "events";

  class UdpSocket extends EventEmitter {
    bind(port?: number, callback?: () => void): this;
    send(msg: Buffer | string, offset: number, length: number, port: number, address: string, callback?: (err: Error | null) => void): void;
    close(callback?: () => void): void;
    setBroadcast(flag: boolean): void;
    on(event: "message", listener: (msg: Buffer, rinfo: { address: string; port: number }) => void): this;
    on(event: "error", listener: (err: Error) => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }

  class UdpSockets {
    static createSocket(options: { type: "udp4" | "udp6"; reusePort?: boolean }): UdpSocket;
  }

  export default UdpSockets;
}
