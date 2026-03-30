export type RuntimePhase = 'plan' | 'execute' | 'verify';

export type RuntimeEventType =
  | 'phase_started'
  | 'phase_completed'
  | 'round_started'
  | 'round_completed'
  | 'model_text_delta'
  | 'tool_call_started'
  | 'tool_call_completed'
  | 'tool_call_failed'
  | 'approval_pending'
  | 'approval_resolved'
  | 'verifier_result'
  | 'final_result'
  | 'error';

export interface RuntimeEvent {
  id: string;
  timestamp: string;
  sessionId: string;
  mode: 'task' | 'chat';
  type: RuntimeEventType;
  phase?: RuntimePhase;
  round?: number;
  backend?: string;
  data?: Record<string, unknown>;
}

export interface RuntimeEventSink {
  emit(event: Omit<RuntimeEvent, 'id' | 'timestamp'>): Promise<void> | void;
}

export type RuntimeEventListener = (event: RuntimeEvent) => void;

export class RuntimeEventBus implements RuntimeEventSink {
  private nextId = 1;
  private readonly listeners = new Map<string, Set<RuntimeEventListener>>();
  private readonly buffers = new Map<string, RuntimeEvent[]>();

  constructor(private readonly maxBufferedEvents = 500) {}

  async emit(event: Omit<RuntimeEvent, 'id' | 'timestamp'>): Promise<void> {
    const enriched: RuntimeEvent = {
      ...event,
      id: String(this.nextId++),
      timestamp: new Date().toISOString(),
    };

    const buffer = this.buffers.get(enriched.sessionId) ?? [];
    buffer.push(enriched);
    if (buffer.length > this.maxBufferedEvents) {
      buffer.splice(0, buffer.length - this.maxBufferedEvents);
    }
    this.buffers.set(enriched.sessionId, buffer);

    const listeners = this.listeners.get(enriched.sessionId);
    if (!listeners) {
      return;
    }

    for (const listener of listeners) {
      listener(enriched);
    }
  }

  subscribe(sessionId: string, listener: RuntimeEventListener, lastEventId?: string | null): () => void {
    const listeners = this.listeners.get(sessionId) ?? new Set<RuntimeEventListener>();
    listeners.add(listener);
    this.listeners.set(sessionId, listeners);

    const lastSeen = lastEventId ? Number(lastEventId) : 0;
    const buffered = this.buffers.get(sessionId) ?? [];
    for (const event of buffered) {
      if (Number(event.id) > lastSeen) {
        listener(event);
      }
    }

    return () => {
      const current = this.listeners.get(sessionId);
      if (!current) {
        return;
      }
      current.delete(listener);
      if (current.size === 0) {
        this.listeners.delete(sessionId);
      }
    };
  }
}
