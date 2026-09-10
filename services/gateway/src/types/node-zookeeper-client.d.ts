declare module 'node-zookeeper-client' {
  namespace zookeeper {
    interface Stat {
      czxid: Buffer;
      mzxid: Buffer;
      version: number;
      dataLength: number;
      numChildren: number;
    }

    interface Event {
      getName(): string;
      getPath(): string;
      getType(): number;
    }

    type ClientEvent =
      | 'connected'
      | 'connectedReadOnly'
      | 'disconnected'
      | 'expired'
      | 'authenticationFailed'
      | 'state';

    interface State {
      name: string;
      code: number;
    }

    interface Client {
      connect(): void;
      close(): void;
      getState(): State;
      on(event: ClientEvent, listener: () => void): Client;
      getData(
        path: string,
        watcher: (event: Event) => void,
        callback: (error: Error | null, data: Buffer | undefined, stat: Stat | undefined) => void,
      ): void;
      exists(
        path: string,
        callback: (error: Error | null, stat: Stat | undefined) => void,
      ): void;
    }

    interface ClientOptions {
      sessionTimeout?: number;
      spinDelay?: number;
      retries?: number;
    }

    function createClient(connectionString: string, options?: ClientOptions): Client;
  }

  export = zookeeper;
}
