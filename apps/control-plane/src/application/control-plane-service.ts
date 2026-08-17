import { createHash } from 'node:crypto';

import type {
  Approval,
  DomainEvent,
  DomainRepository,
  InboxMessage,
  IsoTimestamp,
  JsonValue,
  PersistenceDigests,
  PersistenceId,
  PersistenceIdKind,
  RunStatus,
  WorkflowRun,
} from '@agentos/core';
import { persistenceId } from '@agentos/core';

export type IdGenerator = <Kind extends PersistenceIdKind>(
  kind: Kind,
  idempotencyKey: string,
) => PersistenceId<Kind>;

export class ServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

export interface CreateRunInput extends PersistenceDigests {
  readonly projectId: string;
  readonly title: string;
  readonly description: string;
}

const SENSITIVE_KEY =
  /(?:secret|token|password|authorization|cookie|stack|idempotency|chain.?of.?thought|reasoning|private.?key)/i;

function sanitize(value: JsonValue | undefined): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.map((item) => sanitize(item) ?? null);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !SENSITIVE_KEY.test(key))
        .map(([key, item]) => [key, sanitize(item) ?? null]),
    );
  }
  return value;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function sanitizeInboxMessage(message: InboxMessage): InboxMessage {
  const reply = sanitize(message.reply);
  return {
    ...message,
    body: sanitize(message.body) ?? null,
    ...(reply === undefined ? {} : { reply }),
  };
}

function inputForRun(idempotencyKey: string, input: CreateRunInput): JsonValue {
  return {
    idempotencyKey,
    title: input.title,
    description: input.description,
    provenance: {
      repositorySha: input.repositorySha,
      configDigest: input.configDigest,
      modelDigest: input.modelDigest,
      promptDigest: input.promptDigest,
      environmentDigest: input.environmentDigest,
      policyDigest: input.policyDigest,
    },
  };
}

export interface RunProjection extends PersistenceDigests {
  readonly id: string;
  readonly projectId: string;
  readonly pipeline: string;
  readonly status: RunStatus;
  readonly input?: JsonValue;
  readonly output?: JsonValue;
  readonly error?: JsonValue;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly steps: readonly {
    id: string;
    stepKey: string;
    attempt: number;
    status: string;
  }[];
  readonly timeline: readonly {
    eventId: string;
    sequence: number;
    type: string;
    payload?: JsonValue;
    occurredAt: IsoTimestamp;
  }[];
}

function provenance(run: WorkflowRun): PersistenceDigests {
  const inputValue =
    run.input && !Array.isArray(run.input) && typeof run.input === 'object'
      ? run.input
      : {};
  const input = inputValue as { readonly [key: string]: JsonValue };
  const raw = input.provenance;
  const sourceValue =
    raw && !Array.isArray(raw) && typeof raw === 'object' ? raw : {};
  const source = sourceValue as { readonly [key: string]: JsonValue };
  const read = (key: keyof PersistenceDigests) =>
    typeof source[key] === 'string' ? source[key] : '';
  return {
    repositorySha: read('repositorySha'),
    configDigest: read('configDigest'),
    modelDigest: read('modelDigest'),
    promptDigest: read('promptDigest'),
    environmentDigest: read('environmentDigest'),
    policyDigest: read('policyDigest'),
  };
}

export class ControlPlaneService {
  constructor(
    private readonly repository: DomainRepository,
    private readonly clock: () => IsoTimestamp,
    private readonly generateId: IdGenerator,
  ) {}

  createFeatureRun(idempotencyKey: string, input: CreateRunInput) {
    return this.createRun('feature', idempotencyKey, input);
  }

  createGoalRun(idempotencyKey: string, input: CreateRunInput) {
    return this.createRun('goal', idempotencyKey, input);
  }

  private async createRun(
    pipeline: 'feature' | 'goal',
    idempotencyKey: string,
    input: CreateRunInput,
  ): Promise<RunProjection> {
    const id = this.generateId('run', `${pipeline}:${idempotencyKey}`);
    const runInput = inputForRun(idempotencyKey, input);
    const existing = await this.repository.getRun(id);
    if (existing) {
      if (
        existing.pipeline !== pipeline ||
        canonical(existing.input) !== canonical(runInput) ||
        existing.projectId !== input.projectId
      ) {
        throw new ServiceError(
          'idempotency_conflict',
          'idempotency key was already used with another payload',
          409,
        );
      }
      return this.project(existing);
    }
    const now = this.clock();
    try {
      const created = await this.repository.createRun({
        id,
        projectId: persistenceId('project', input.projectId),
        pipeline,
        status: 'pending',
        input: runInput,
        createdAt: now,
        updatedAt: now,
      });
      return this.project(created);
    } catch (error) {
      if (error instanceof Error && error.name === 'IdempotencyConflictError') {
        throw new ServiceError('idempotency_conflict', error.message, 409);
      }
      throw error;
    }
  }

  async listRuns(limit = 50): Promise<readonly RunProjection[]> {
    const runs = await this.repository.listRuns({ limit });
    return Promise.all(runs.map((run) => this.project(run)));
  }

  async getRun(id: string): Promise<RunProjection> {
    const run = await this.repository.getRun(persistenceId('run', id));
    if (!run) throw new ServiceError('not_found', 'run not found', 404);
    return this.project(run);
  }

  async cancelRun(id: string, idempotencyKey: string): Promise<RunProjection> {
    const runId = persistenceId('run', id);
    const run = await this.repository.getRun(runId);
    if (!run) throw new ServiceError('not_found', 'run not found', 404);
    if (['succeeded', 'failed'].includes(run.status)) {
      throw new ServiceError(
        'invalid_state',
        'completed run cannot be cancelled',
        409,
      );
    }
    if (run.status !== 'cancelled') {
      const now = this.clock();
      await this.repository.updateRun(runId, {
        status: 'cancelled',
        updatedAt: now,
        completedAt: now,
      });
      await this.appendEvent(id, idempotencyKey, 'run.cancelled', {});
    }
    return this.getRun(id);
  }

  async createApproval(
    idempotencyKey: string,
    input: { runId: string; scope: string; expiresAt: IsoTimestamp },
  ): Promise<Approval> {
    const approval: Approval = {
      id: this.generateId('approval', `approval:${idempotencyKey}`),
      runId: persistenceId('run', input.runId),
      scope: input.scope,
      fingerprint: fingerprint({ runId: input.runId, scope: input.scope }),
      status: 'pending',
      createdAt: this.clock(),
      expiresAt: input.expiresAt,
    };
    const existing = await this.repository.getApproval(approval.id);
    if (existing) {
      if (
        existing.runId !== approval.runId ||
        existing.scope !== approval.scope ||
        existing.fingerprint !== approval.fingerprint ||
        existing.expiresAt !== approval.expiresAt
      ) {
        throw new ServiceError(
          'idempotency_conflict',
          'approval key conflict',
          409,
        );
      }
      return existing;
    }
    return this.repository.createApproval(approval);
  }

  async getApproval(id: string): Promise<Approval> {
    const approval = await this.repository.getApproval(
      persistenceId('approval', id),
    );
    if (!approval)
      throw new ServiceError('not_found', 'approval not found', 404);
    return approval;
  }

  async consumeApproval(
    id: string,
    decision: 'approve' | 'reject',
    idempotencyKey: string,
  ): Promise<Approval> {
    const approval = await this.getApproval(id);
    if (approval.status === 'expired') {
      throw new ServiceError('approval_expired', 'approval expired', 409);
    }
    const decisionType =
      decision === 'approve' ? 'approval.approved' : 'approval.rejected';
    if (approval.status === 'consumed') {
      const eventId = this.generateId(
        'event',
        `event:${approval.runId}:approval:${idempotencyKey}`,
      );
      const replay = (
        await this.repository.listEvents(approval.runId, {
          limit: 1_000,
        })
      ).find((event) => event.eventId === eventId);
      if (!replay) {
        throw new ServiceError(
          'approval_already_decided',
          'approval was already decided',
          409,
        );
      }
      if (replay.type !== decisionType) {
        throw new ServiceError(
          'idempotency_conflict',
          'approval decision key conflict',
          409,
        );
      }
      return approval;
    }
    const event = await this.appendEvent(
      approval.runId,
      `approval:${idempotencyKey}`,
      decisionType,
      { approvalId: id, scopeHash: approval.fingerprint },
    );
    void event;
    const consumed = await this.repository.consumeApproval({
      approvalId: approval.id,
      runId: approval.runId,
      scope: approval.scope,
      fingerprint: approval.fingerprint,
      consumedAt: this.clock(),
    });
    if (!consumed)
      throw new ServiceError('approval_invalid', 'approval is invalid', 409);
    return consumed;
  }

  async listInbox(limit = 50): Promise<readonly InboxMessage[]> {
    const runs = await this.repository.listRuns({ limit });
    const pages = await Promise.all(
      runs.map((run) =>
        this.repository.listInboxMessages(run.id, undefined, { limit }),
      ),
    );
    return pages
      .flat()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(sanitizeInboxMessage);
  }

  async listPendingApprovals(limit = 50): Promise<readonly Approval[]> {
    const runs = await this.repository.listRuns({ limit });
    const pages = await Promise.all(
      runs.map((run) =>
        this.repository.listApprovals(run.id, { status: 'pending', limit }),
      ),
    );
    return pages.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async replyInbox(
    id: string,
    reply: JsonValue,
    idempotencyKey: string,
  ): Promise<InboxMessage> {
    const message = await this.repository.getInboxMessage(
      persistenceId('inboxMessage', id),
    );
    if (!message)
      throw new ServiceError('not_found', 'inbox item not found', 404);
    if (message.status === 'replied') {
      if (canonical(message.reply) !== canonical(reply)) {
        throw new ServiceError(
          'idempotency_conflict',
          'reply key conflict',
          409,
        );
      }
      return sanitizeInboxMessage(message);
    }
    await this.appendEvent(
      message.runId,
      `inbox:${idempotencyKey}`,
      'inbox.replied',
      {
        messageId: id,
      },
    );
    const result = await this.repository.replyInboxMessage({
      messageId: message.id,
      reply,
      repliedAt: this.clock(),
    });
    return sanitizeInboxMessage(result);
  }

  async appendEvent(
    runIdValue: string,
    idempotencyKey: string,
    type: string,
    payload: JsonValue,
  ): Promise<DomainEvent> {
    const runId = persistenceId('run', runIdValue);
    const existing = await this.repository.listEvents(runId, { limit: 1_000 });
    const eventId = this.generateId(
      'event',
      `event:${runId}:${idempotencyKey}`,
    );
    const replay = existing.find((event) => event.eventId === eventId);
    const eventFingerprint = fingerprint({ type, payload });
    if (replay) {
      if (replay.fingerprint !== eventFingerprint) {
        throw new ServiceError(
          'idempotency_conflict',
          'event key conflict',
          409,
        );
      }
      return replay;
    }
    return this.repository.appendEvent({
      runId,
      eventId,
      fingerprint: eventFingerprint,
      sequence: (existing.at(-1)?.sequence ?? 0) + 1,
      type,
      payload,
      occurredAt: this.clock(),
    });
  }

  private async project(run: WorkflowRun): Promise<RunProjection> {
    const [steps, events] = await Promise.all([
      this.repository.listStepRuns(run.id, { limit: 100 }),
      this.repository.listEvents(run.id, { limit: 1_000 }),
    ]);
    const safeInput = sanitize(run.input);
    const safeOutput = sanitize(run.output);
    const safeError = sanitize(run.error);
    return {
      id: run.id,
      projectId: run.projectId,
      pipeline: run.pipeline,
      status: run.status,
      ...(safeInput === undefined ? {} : { input: safeInput }),
      ...(safeOutput === undefined ? {} : { output: safeOutput }),
      ...(safeError === undefined ? {} : { error: safeError }),
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      ...provenance(run),
      steps: steps.map((step) => ({
        id: step.id,
        stepKey: step.stepKey,
        attempt: step.attempt,
        status: step.status,
      })),
      timeline: events.map((event) => {
        const payload = sanitize(event.payload);
        return {
          eventId: event.eventId,
          sequence: event.sequence,
          type: event.type,
          ...(payload === undefined ? {} : { payload }),
          occurredAt: event.occurredAt,
        };
      }),
    };
  }
}
