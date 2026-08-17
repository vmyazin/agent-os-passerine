import { GitHubPublisherError } from './errors.js';
import type {
  PublicationEvent,
  PublicationPhase,
  PublicationRecord,
  PublicationStore,
} from './types.js';

const transitions: Readonly<
  Record<PublicationPhase, readonly PublicationPhase[]>
> = {
  claimed: ['blobs_created', 'failed', 'cancelled'],
  failed: ['blobs_created', 'cancelled'],
  blobs_created: ['tree_created', 'failed', 'cancelled'],
  tree_created: ['commit_created', 'failed', 'cancelled'],
  commit_created: ['ref_created', 'failed', 'cancelled'],
  ref_created: ['pr_created', 'failed', 'cancelled'],
  pr_created: ['succeeded', 'failed', 'cancelled'],
  succeeded: [],
  cancelled: [],
};

export class InMemoryPublicationStore implements PublicationStore {
  readonly #records = new Map<string, PublicationRecord>();
  readonly #bindingKeys = new Map<string, string>();
  readonly #events: PublicationEvent[] = [];

  async claim(
    input: Omit<
      PublicationRecord,
      'phase' | 'revision' | 'createdAt' | 'updatedAt'
    > & {
      readonly now: string;
    },
  ): Promise<PublicationRecord> {
    const existing = this.#records.get(input.key);
    if (existing !== undefined) return existing;
    const existingBinding = this.#bindingKeys.get(input.bindingKey);
    if (existingBinding !== undefined && existingBinding !== input.key) {
      throw new GitHubPublisherError(
        'publication_collision',
        'Run is already bound to a different publication manifest',
      );
    }
    const { now, ...fields } = input;
    const record: PublicationRecord = Object.freeze({
      ...fields,
      phase: 'claimed',
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    this.#records.set(input.key, record);
    this.#bindingKeys.set(input.bindingKey, input.key);
    this.#events.push({
      publicationKey: input.key,
      phase: 'claimed',
      at: now,
      details: {},
    });
    return record;
  }

  async save(
    key: string,
    expectedRevision: number,
    patch: Parameters<PublicationStore['save']>[2],
    event: PublicationEvent,
  ): Promise<PublicationRecord> {
    if (
      event.publicationKey !== key ||
      event.phase !== patch.phase ||
      event.at !== patch.updatedAt ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision <= 0
    ) {
      throw new GitHubPublisherError(
        'publication_store_conflict',
        'Publication event does not match its checkpoint',
      );
    }
    const existing = this.#records.get(key);
    const cancellationEnrichment =
      existing?.phase === 'cancelled' &&
      patch.phase === 'cancelled' &&
      existing.pullRequestNumber === undefined &&
      patch.pullRequestNumber !== undefined &&
      patch.pullRequestUrl !== undefined &&
      patch.draft === true;
    if (
      existing === undefined ||
      existing.revision !== expectedRevision ||
      (!transitions[existing.phase].includes(patch.phase) &&
        !cancellationEnrichment)
    ) {
      throw new GitHubPublisherError(
        'publication_store_conflict',
        'Publication checkpoint changed concurrently',
      );
    }
    const record = Object.freeze({
      ...existing,
      ...patch,
      revision: existing.revision + 1,
    });
    this.#records.set(key, record);
    this.#events.push(Object.freeze({ ...event }));
    return record;
  }

  async get(key: string): Promise<PublicationRecord | undefined> {
    return this.#records.get(key);
  }

  async listEvents(): Promise<readonly PublicationEvent[]> {
    return [...this.#events];
  }
}
