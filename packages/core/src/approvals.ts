import type { ApprovalHandler, ApprovalRequest } from './runtime.js';

export interface PendingApproval extends ApprovalRequest {
  id: string;
  createdAt: string;
}

interface PendingRecord {
  request: PendingApproval;
  resolve(decision: boolean): void;
}

export class ApprovalManager {
  private readonly pending = new Map<string, PendingRecord>();

  createHandler(): ApprovalHandler {
    return async (request) => {
      const approval: PendingApproval = {
        ...request,
        id: `${request.sessionId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
        createdAt: new Date().toISOString(),
      };

      return new Promise<boolean>((resolve) => {
        this.pending.set(approval.id, {
          request: approval,
          resolve: (decision) => {
            this.pending.delete(approval.id);
            resolve(decision);
          },
        });
      });
    };
  }

  list(sessionId?: string): PendingApproval[] {
    return [...this.pending.values()]
      .map((entry) => entry.request)
      .filter((entry) => (sessionId ? entry.sessionId === sessionId : true))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  resolve(id: string, decision: boolean): boolean {
    const record = this.pending.get(id);
    if (!record) {
      return false;
    }

    record.resolve(decision);
    return true;
  }
}
