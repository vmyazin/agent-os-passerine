export interface GlobalOptions {
  readonly json: boolean;
  readonly url?: string;
  readonly token?: string;
}

export interface RunStartOptions extends GlobalOptions {
  readonly projectId: string;
  readonly title: string;
  readonly description: string;
  readonly repositorySha: string;
  readonly configDigest: string;
  readonly modelDigest: string;
  readonly promptDigest: string;
  readonly environmentDigest: string;
  readonly policyDigest: string;
  readonly idempotencyKey: string;
}

export interface GoalCommandCriterion {
  readonly id: string;
  readonly type: 'command';
  readonly description: string;
  readonly required?: boolean;
  readonly command: string;
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

export type Command =
  | (GlobalOptions & { readonly kind: 'help' | 'version' })
  | (GlobalOptions & {
      readonly kind: 'init';
      readonly config: string;
      readonly force: boolean;
    })
  | (GlobalOptions & {
      readonly kind: 'config.validate' | 'config.plan';
      readonly config: string;
    })
  | (GlobalOptions & {
      readonly kind: 'config.apply';
      readonly config: string;
      readonly idempotencyKey: string;
    })
  | (RunStartOptions & { readonly kind: 'feature.start' })
  | (RunStartOptions & {
      readonly kind: 'goal.start';
      readonly criteria: readonly GoalCommandCriterion[];
    })
  | (GlobalOptions & { readonly kind: 'runs.list' | 'inbox.list' })
  | (GlobalOptions & {
      readonly kind: 'runs.show' | 'goal.show';
      readonly id: string;
    })
  | (GlobalOptions & {
      readonly kind: 'runs.cancel';
      readonly id: string;
      readonly idempotencyKey: string;
    })
  | (GlobalOptions & {
      readonly kind: 'inbox.reply';
      readonly id: string;
      readonly reply?: string;
      readonly file?: string;
      readonly idempotencyKey: string;
    })
  | (GlobalOptions & {
      readonly kind: 'inbox.approve' | 'inbox.reject';
      readonly id: string;
      readonly scopeHash: string;
      readonly idempotencyKey: string;
    });

export interface ApiRequest {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: unknown;
  readonly idempotencyKey?: string;
}
