import { createHash } from 'node:crypto';

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export const DEFAULT_PROTECTED_PATHS = [
  '.github/workflows/**',
  'CODEOWNERS',
  '**/CODEOWNERS',
  '.gitmodules',
  '.env*',
  '**/.env*',
  'agentos/**',
] as const;

const Identifier = z.string().min(1);
const NonNegativeInteger = z.number().int().nonnegative();
const PositiveInteger = z.number().int().positive();

export const CapabilityPermissionsSchema = z
  .object({
    allow: z.array(Identifier).default([]),
    deny: z.array(Identifier).default([]),
  })
  .strict();

export const ModelProfileSchema = z
  .object({
    provider: Identifier,
    model: Identifier,
    inputMicrodollarsPerMillionTokens: NonNegativeInteger.default(0),
    outputMicrodollarsPerMillionTokens: NonNegativeInteger.default(0),
    runtimeMicrodollarsPerMinute: NonNegativeInteger.default(0),
  })
  .strict();

export const AgentDefinitionSchema = z
  .object({
    model: Identifier,
    prompt: z.string().optional(),
    environment: Identifier.optional(),
    tools: z.array(Identifier).default([]),
    mcps: z.array(Identifier).default([]),
    retries: NonNegativeInteger.default(0),
    timeoutMs: PositiveInteger.default(900_000),
  })
  .strict();

export const EnvironmentDefinitionSchema = z
  .object({
    runtime: Identifier,
    image: Identifier.optional(),
    variables: z.record(z.string(), z.string()).default({}),
    tools: z.array(Identifier).default([]),
    mcps: z.array(Identifier).default([]),
  })
  .strict();

export const PipelineStepSchema = z
  .object({
    id: Identifier,
    agent: Identifier,
    environment: Identifier.optional(),
    dependsOn: z.array(Identifier).default([]),
    retries: NonNegativeInteger.optional(),
    timeoutMs: PositiveInteger.optional(),
  })
  .strict();

export const PipelineDefinitionSchema = z
  .object({ steps: z.array(PipelineStepSchema).min(1) })
  .strict();

export const PatchPolicyConfigSchema = z
  .object({
    protectedPaths: z.array(Identifier).default([...DEFAULT_PROTECTED_PATHS]),
    allowBinary: z.boolean().default(false),
    allowSymlinks: z.boolean().default(false),
    maxFileBytes: PositiveInteger.default(1_000_000),
    tools: CapabilityPermissionsSchema.default({ allow: [], deny: [] }),
    mcp: CapabilityPermissionsSchema.default({ allow: [], deny: [] }),
  })
  .strict();

export const BudgetConfigSchema = z
  .object({
    workflowMicrodollars: NonNegativeInteger,
    dailyMicrodollars: NonNegativeInteger,
    concurrency: PositiveInteger,
    admissionReservePercent: z.number().int().min(0).max(100).default(80),
  })
  .strict();

export const GoalLimitsSchema = z
  .object({
    maxSteps: PositiveInteger,
    maxRetries: NonNegativeInteger,
    timeoutMs: PositiveInteger,
  })
  .strict();

export const RuntimeRoutingSchema = z
  .object({
    provider: Identifier,
    routing: z.record(z.string(), Identifier).default({}),
  })
  .strict();

export const AgentOsConfigSchema = z
  .object({
    version: z.literal(1),
    project: z
      .object({
        name: Identifier,
        repository: z.string().url().optional(),
        defaultBranch: Identifier.default('main'),
      })
      .strict(),
    models: z.record(z.string(), ModelProfileSchema),
    agents: z.record(z.string(), AgentDefinitionSchema),
    environments: z.record(z.string(), EnvironmentDefinitionSchema),
    pipelines: z.record(z.string(), PipelineDefinitionSchema),
    policies: PatchPolicyConfigSchema,
    budgets: BudgetConfigSchema,
    goals: GoalLimitsSchema,
    runtime: RuntimeRoutingSchema,
  })
  .strict()
  .superRefine((config, context) => {
    for (const [agentName, agent] of Object.entries(config.agents)) {
      if (!(agent.model in config.models)) {
        context.addIssue({
          code: 'custom',
          path: ['agents', agentName, 'model'],
          message: `Unknown model profile: ${agent.model}`,
        });
      }
      if (
        agent.environment !== undefined &&
        !(agent.environment in config.environments)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['agents', agentName, 'environment'],
          message: `Unknown environment: ${agent.environment}`,
        });
      }
    }

    for (const [pipelineName, pipeline] of Object.entries(config.pipelines)) {
      const stepIndexes = new Map<string, number>();
      pipeline.steps.forEach((step, stepIndex) => {
        if (stepIndexes.has(step.id)) {
          context.addIssue({
            code: 'custom',
            path: ['pipelines', pipelineName, 'steps', stepIndex, 'id'],
            message: `Duplicate pipeline step id: ${step.id}`,
          });
        } else {
          stepIndexes.set(step.id, stepIndex);
        }
        if (!(step.agent in config.agents)) {
          context.addIssue({
            code: 'custom',
            path: ['pipelines', pipelineName, 'steps', stepIndex, 'agent'],
            message: `Unknown agent: ${step.agent}`,
          });
        }
        if (
          step.environment !== undefined &&
          !(step.environment in config.environments)
        ) {
          context.addIssue({
            code: 'custom',
            path: [
              'pipelines',
              pipelineName,
              'steps',
              stepIndex,
              'environment',
            ],
            message: `Unknown environment: ${step.environment}`,
          });
        }
      });

      pipeline.steps.forEach((step, stepIndex) => {
        for (const dependency of step.dependsOn) {
          if (dependency === step.id) {
            context.addIssue({
              code: 'custom',
              path: [
                'pipelines',
                pipelineName,
                'steps',
                stepIndex,
                'dependsOn',
              ],
              message: `Pipeline step ${step.id} cannot depend on itself`,
            });
          } else if (!stepIndexes.has(dependency)) {
            context.addIssue({
              code: 'custom',
              path: [
                'pipelines',
                pipelineName,
                'steps',
                stepIndex,
                'dependsOn',
              ],
              message: `Unknown pipeline dependency: ${dependency}`,
            });
          }
        }
      });

      const visiting = new Set<string>();
      const visited = new Set<string>();
      const visit = (stepId: string): boolean => {
        if (visiting.has(stepId)) return true;
        if (visited.has(stepId)) return false;
        visiting.add(stepId);
        const stepIndex = stepIndexes.get(stepId);
        const step =
          stepIndex === undefined ? undefined : pipeline.steps[stepIndex];
        const cyclic =
          step?.dependsOn.some(
            (dependency) =>
              dependency !== stepId &&
              stepIndexes.has(dependency) &&
              visit(dependency),
          ) ?? false;
        visiting.delete(stepId);
        visited.add(stepId);
        return cyclic;
      };

      for (const [stepId, stepIndex] of stepIndexes) {
        if (visit(stepId)) {
          context.addIssue({
            code: 'custom',
            path: ['pipelines', pipelineName, 'steps', stepIndex, 'dependsOn'],
            message: `Pipeline contains a dependency cycle involving ${stepId}`,
          });
          break;
        }
      }
    }
  });

export type AgentOsConfig = z.infer<typeof AgentOsConfigSchema>;

export function parseAgentOsConfig(input: unknown): AgentOsConfig {
  return AgentOsConfigSchema.parse(input);
}

export function loadAgentOsConfig(yaml: string): AgentOsConfig {
  return parseAgentOsConfig(parseYaml(yaml));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

export function canonicalConfigJson(config: AgentOsConfig): string {
  return JSON.stringify(canonicalize(parseAgentOsConfig(config)));
}

export function canonicalConfigHash(config: AgentOsConfig): string {
  return createHash('sha256').update(canonicalConfigJson(config)).digest('hex');
}

export interface ConfigChange {
  readonly kind: 'added' | 'removed' | 'changed';
  readonly path: string;
  readonly before?: unknown;
  readonly after?: unknown;
}

function diffValues(
  before: unknown,
  after: unknown,
  path: string,
): ConfigChange[] {
  if (Object.is(before, after)) return [];
  if (
    before !== null &&
    after !== null &&
    typeof before === 'object' &&
    typeof after === 'object' &&
    !Array.isArray(before) &&
    !Array.isArray(after)
  ) {
    const beforeRecord = before as Record<string, unknown>;
    const afterRecord = after as Record<string, unknown>;
    const keys = [
      ...new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)]),
    ].sort();
    return keys.flatMap((key) => {
      const childPath = path === '' ? key : `${path}.${key}`;
      if (!(key in beforeRecord))
        return [
          { kind: 'added' as const, path: childPath, after: afterRecord[key] },
        ];
      if (!(key in afterRecord))
        return [
          {
            kind: 'removed' as const,
            path: childPath,
            before: beforeRecord[key],
          },
        ];
      return diffValues(beforeRecord[key], afterRecord[key], childPath);
    });
  }
  if (
    Array.isArray(before) &&
    Array.isArray(after) &&
    JSON.stringify(before) === JSON.stringify(after)
  )
    return [];
  return [{ kind: 'changed', path, before, after }];
}

export function semanticConfigDiff(
  before: AgentOsConfig,
  after: AgentOsConfig,
): ConfigChange[] {
  return diffValues(parseAgentOsConfig(before), parseAgentOsConfig(after), '');
}

export interface ConfigPlan {
  readonly fromHash: string;
  readonly toHash: string;
  readonly changes: readonly ConfigChange[];
  readonly changed: boolean;
}

export function planConfigChange(
  before: AgentOsConfig,
  after: AgentOsConfig,
): ConfigPlan {
  const changes = semanticConfigDiff(before, after);
  return {
    fromHash: canonicalConfigHash(before),
    toHash: canonicalConfigHash(after),
    changes,
    changed: changes.length > 0,
  };
}

export const parseConfig = parseAgentOsConfig;
export const loadConfig = loadAgentOsConfig;
export const canonicalHash = canonicalConfigHash;
export const semanticDiff = semanticConfigDiff;
export const semanticPlan = planConfigChange;
