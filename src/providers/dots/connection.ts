import { z } from "zod";
import { GatewayError } from "../../contracts";
import { MAX_IMAGE_BYTES } from "../../images";

// Allow one 32 MiB image in base64 plus 1 MiB of JSON metadata per frame. These are local
// retention budgets, not provider limits: at most 256 queued and 4096 total notifications,
// one frame's worth queued and four frames' worth received over a job connection.
export const MAX_DOT_FRAME_BYTES = 4 * Math.ceil(MAX_IMAGE_BYTES / 3) + 1024 * 1024;
export const MAX_DOT_QUEUED_NOTIFICATIONS = 256;
export const MAX_DOT_NOTIFICATIONS = 4096;
export const MAX_DOT_RECEIVED_BYTES = 4 * MAX_DOT_FRAME_BYTES;

const responseSchema = z.object({
  id: z.number(),
  result: z.unknown().optional(),
  error: z.object({
    code: z.number(),
    message: z.string(),
    data: z.object({ grpcStatusCode: z.number().optional() }).optional(),
  }).optional(),
});
const notificationSchema = z.object({
  method: z.string(),
  params: z.unknown(),
});

export type Notification = z.infer<typeof notificationSchema>;

/** Only an explicit invalid-request / missing-thread rejection can prove submission never executed. */
export class DotRpcError extends GatewayError {
  constructor(
    readonly rpc: { readonly method: string; readonly code: number; readonly grpcStatusCode?: number | undefined },
    message: string,
    readonly beforeExecution: boolean,
    uncertain: boolean,
  ) {
    super(rpc.grpcStatusCode === 5 ? "dots_thread_missing" : "dots_rpc", message, 502, uncertain && !beforeExecution);
  }
}

/** One connection owns one job; notifications are buffered from before turn submission. */
export class DotConnection {
  private nextId = 1;
  private readonly pending = new Map<number, {
    readonly method: string;
    readonly threadId: string | undefined;
    activity: boolean;
    resolve(value: unknown): void;
    reject(error: GatewayError): void;
  }>();
  private readonly notifications: { readonly value: Notification; readonly bytes: number }[] = [];
  private queuedBytes = 0;
  private receivedBytes = 0;
  private notificationCount = 0;
  private waiting: {
    resolve(value: Notification): void;
    reject(error: GatewayError): void;
  } | undefined;
  private closed: GatewayError | undefined;
  readonly ready: Promise<void>;

  constructor(
    private readonly socket: WebSocket,
    signal: AbortSignal,
    private readonly uncertain: () => boolean,
  ) {
    this.ready = new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(this.failure()), { once: true });
      socket.addEventListener("close", () => reject(this.failure()), { once: true });
    });
    socket.addEventListener("message", (event: MessageEvent) => {
      if (this.closed) return;
      if (typeof event.data !== "string") {
        this.fail(new GatewayError("dots_protocol", "Dot sent a non-text frame.", 502, uncertain()));
        return;
      }
      const bytes = Buffer.byteLength(event.data);
      this.receivedBytes += bytes;
      if (bytes > MAX_DOT_FRAME_BYTES || this.receivedBytes > MAX_DOT_RECEIVED_BYTES) {
        this.fail(new GatewayError("dots_resource_limit", "Dot exceeded the connection byte budget.", 502, uncertain()));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        this.fail(new GatewayError("dots_protocol", "Dot sent invalid JSON.", 502, uncertain()));
        return;
      }
      const response = responseSchema.safeParse(parsed);
      if (response.success) {
        const pending = this.pending.get(response.data.id);
        if (!pending) return;
        this.pending.delete(response.data.id);
        if (response.data.error) {
          const { code, message } = response.data.error;
          const grpcStatusCode = response.data.error.data?.grpcStatusCode;
          // -32600 is an invalid request, not a failed accepted turn. A same-thread notification
          // contradicts that pre-execution interpretation, so any such activity forbids replay.
          const beforeExecution = pending.method === "turn/start" && code === -32600 &&
            grpcStatusCode === 5 && !pending.activity;
          pending.reject(new DotRpcError(
            { method: pending.method, code, grpcStatusCode },
            `Dot rejected an RPC request (${code}): ${message}`,
            beforeExecution,
            uncertain(),
          ));
        } else if (response.data.result === undefined) {
          pending.reject(new GatewayError("dots_protocol", "Dot RPC response has no result.", 502, uncertain()));
        } else {
          pending.resolve(response.data.result);
        }
        return;
      }
      const notification = notificationSchema.safeParse(parsed);
      if (notification.success) {
        this.notificationCount++;
        if (this.notificationCount > MAX_DOT_NOTIFICATIONS) {
          this.fail(new GatewayError("dots_resource_limit", "Dot exceeded the notification budget.", 502, uncertain()));
          return;
        }
        const scope = z.object({ threadId: z.string() }).safeParse(notification.data.params);
        for (const pending of this.pending.values()) {
          if (pending.method === "turn/start" && (!scope.success || scope.data.threadId === pending.threadId)) {
            pending.activity = true;
          }
        }
        const waiter = this.waiting;
        if (waiter) {
          this.waiting = undefined;
          waiter.resolve(notification.data);
        } else {
          if (this.notifications.length >= MAX_DOT_QUEUED_NOTIFICATIONS || this.queuedBytes + bytes > MAX_DOT_FRAME_BYTES) {
            this.fail(new GatewayError("dots_resource_limit", "Dot exceeded the notification queue budget.", 502, uncertain()));
            return;
          }
          this.notifications.push({ value: notification.data, bytes });
          this.queuedBytes += bytes;
        }
      }
    });
    socket.addEventListener("close", () => this.fail(this.failure()));
    socket.addEventListener("error", () => this.fail(this.failure()));
    signal.addEventListener("abort", () => {
      this.fail(new GatewayError("dots_timeout", "Dot connection ended before completion.", 504, uncertain()));
    }, { once: true });
    if (signal.aborted) this.fail(new GatewayError("dots_timeout", "Dot connection ended before completion.", 504, uncertain()));
  }

  private failure(): GatewayError {
    return this.closed ?? new GatewayError("dots_connection", "Dot connection closed before completion.", 502, this.uncertain());
  }

  private fail(error: GatewayError): void {
    if (this.closed) return;
    this.closed = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.notifications.length = 0;
    this.queuedBytes = 0;
    this.waiting?.reject(error);
    this.waiting = undefined;
    this.socket.close();
  }

  request(method: string, params: object): Promise<unknown> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const scope = z.object({ threadId: z.string() }).safeParse(params);
      this.pending.set(id, { method, threadId: scope.success ? scope.data.threadId : undefined, activity: false, resolve, reject });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch {
        this.pending.delete(id);
        reject(new GatewayError("dots_connection", "Dot request could not be sent.", 502, this.uncertain()));
      }
    });
  }

  notify(method: string, params: object): void {
    if (this.closed) throw this.closed;
    this.socket.send(JSON.stringify({ method, params }));
  }

  next(): Promise<Notification> {
    if (this.closed) return Promise.reject(this.closed);
    const notification = this.notifications.shift();
    if (notification) {
      this.queuedBytes -= notification.bytes;
      return Promise.resolve(notification.value);
    }
    return new Promise<Notification>((resolve, reject) => {
      this.waiting = { resolve, reject };
    });
  }

  close(): void {
    this.socket.close();
  }
}
