import type { ApiRequest, Command } from './types.js';

export interface RemoteClient {
  request(request: ApiRequest): Promise<unknown>;
}

export type RemoteCommand = Exclude<
  Command,
  {
    kind:
      | 'help'
      | 'version'
      | 'init'
      | 'config.validate'
      | 'config.plan'
      | 'config.apply';
  }
>;

function runBody(
  command: Extract<Command, { kind: 'feature.start' | 'goal.start' }>,
) {
  return {
    projectId: command.projectId,
    title: command.title,
    description: command.description,
    repositorySha: command.repositorySha,
    configDigest: command.configDigest,
    modelDigest: command.modelDigest,
    promptDigest: command.promptDigest,
    environmentDigest: command.environmentDigest,
    policyDigest: command.policyDigest,
    ...(command.kind === 'goal.start' ? { criteria: command.criteria } : {}),
  };
}

export async function executeRemoteCommand(
  command: RemoteCommand,
  client: RemoteClient,
): Promise<unknown> {
  let request: ApiRequest;
  switch (command.kind) {
    case 'feature.start':
    case 'goal.start':
      request = {
        method: 'POST',
        path: command.kind === 'feature.start' ? '/api/features' : '/api/goals',
        body: runBody(command),
        idempotencyKey: command.idempotencyKey,
      };
      break;
    case 'runs.list':
      request = { method: 'GET', path: '/api/runs' };
      break;
    case 'runs.show':
    case 'goal.show':
      request = {
        method: 'GET',
        path: `/api/runs/${encodeURIComponent(command.id)}`,
      };
      break;
    case 'runs.cancel':
      request = {
        method: 'POST',
        path: `/api/runs/${encodeURIComponent(command.id)}/cancel`,
        body: {},
        idempotencyKey: command.idempotencyKey,
      };
      break;
    case 'inbox.list':
      request = { method: 'GET', path: '/api/inbox' };
      break;
    case 'inbox.reply':
      request = {
        method: 'POST',
        path: `/api/inbox/${encodeURIComponent(command.id)}/reply`,
        body: { reply: command.reply },
        idempotencyKey: command.idempotencyKey,
      };
      break;
    case 'inbox.approve':
    case 'inbox.reject':
      request = {
        method: 'POST',
        path: `/api/approvals/${encodeURIComponent(command.id)}/${command.kind.slice('inbox.'.length)}`,
        body: { scopeHash: command.scopeHash },
        idempotencyKey: command.idempotencyKey,
      };
      break;
  }
  return client.request(request);
}
