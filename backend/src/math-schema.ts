import { createHash } from "node:crypto";
import { z } from "zod";
import { Ajv } from "ajv";
import type { FastifyInstance } from "fastify";
export function installMathValidator(app: FastifyInstance) {
  const ajv = new Ajv({
    coerceTypes: true,
    useDefaults: true,
    removeAdditional: false,
    strict: false,
  });
  app.setValidatorCompiler(({ schema }) => ajv.compile(schema));
}
export const MATH_LIMITS = {
  conceptBytes: 64 * 1024,
  markdownBytes: 512 * 1024,
  documentBytes: 700 * 1024,
  chunkBytes: 200 * 1024,
  objectives: 200,
  capabilities: 1000,
  questions: 20,
  answerBytes: 32 * 1024,
  questionBytes: 32 * 1024,
  solutionBytes: 128 * 1024,
  orSearch: 4096,
  inputBytes: 60_000,
  outputTokens: 8000,
  calls: 240,
  tokens: 1_500_000,
} as const;
export const PARSER_VERSION = "math-unit-1";
export const PROMPT_VERSION = "math-1";
export const idSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,95}$/);
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const operationIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{8,100}$/);
export const capabilitySchema = z.enum(["recognize", "apply", "prove"]);
export const refSchema = z.strictObject({
  conceptId: idSchema,
  capability: capabilitySchema,
});
export const dependencySchema = z.strictObject({
  allOf: z.array(refSchema).max(1000),
  anyOf: z
    .array(
      z.strictObject({
        id: idSchema,
        priority: z.number().int(),
        requires: z.array(refSchema).min(1).max(1000),
      }),
    )
    .max(50),
});
export const formatSchema = z.enum([
  "numeric",
  "expression",
  "text",
  "proof",
  "choice",
]);
export const scopeRequestSchema = z.strictObject({
  subjectId: idSchema,
  selectedNodeIds: z.array(idSchema).min(1).max(200),
  excludedConceptIds: z.array(idSchema).max(1000).default([]),
  excludedObjectiveIds: z.array(idSchema).max(200).default([]),
  objectiveCapabilities: z
    .array(capabilitySchema)
    .min(1)
    .max(3)
    .default(["recognize", "apply", "prove"]),
  mode: z
    .enum(["strict", "prerequisites", "provided"])
    .default("prerequisites"),
  profileIds: z.array(idSchema).max(30).default([]),
  difficulty: z.number().int().min(1).max(5),
  questionCount: z.number().int().min(1).max(20),
  responseLanguage: z.enum(["en", "ja", "ko"]),
  answerFormats: z
    .array(formatSchema)
    .min(1)
    .max(5)
    .default(["numeric", "expression", "text", "proof", "choice"]),
});
export const candidateSchema = z.strictObject({
  status: z.literal("candidate"),
  promptMarkdown: z.string().min(1).max(32768),
  answerFormat: formatSchema,
  targetObjectiveIds: z.array(idSchema).min(1).max(5),
  prerequisitesUsed: z.array(refSchema).max(1000),
  foundationUsed: z.array(refSchema).max(1000),
  givens: z
    .array(
      z.strictObject({
        capability: refSchema,
        promptBlockId: idSchema,
        statementMarkdown: z.string().min(1),
        conditionsMarkdown: z.string().min(1),
      }),
    )
    .max(100),
  solution: z.strictObject({
    usedKnowledge: z
      .array(
        z.strictObject({
          conceptId: idSchema,
          revisionId: hashSchema,
          citationIds: z.array(idSchema).min(1),
          role: z.enum(["target", "prerequisite", "foundation", "given"]),
        }),
      )
      .min(1),
    strategyMarkdown: z.string().min(1),
    steps: z
      .array(
        z.strictObject({
          id: idSchema,
          citationIds: z.array(idSchema).min(1),
          uses: z.array(refSchema).min(1),
          applicabilityMarkdown: z.string().min(1),
          explanationMarkdown: z.string().min(1),
        }),
      )
      .min(1)
      .max(40),
    finalAnswerMarkdown: z.string().min(1),
    checksMarkdown: z.string().min(1),
  }),
  rubric: z
    .array(
      z.strictObject({
        criterionId: idSchema,
        objectiveId: idSchema,
        points: z.number().positive().max(100),
        description: z.string().min(1),
        requiredStepIds: z.array(idSchema).min(1),
      }),
    )
    .min(1)
    .max(30),
  estimatedDifficulty: z.strictObject({
    level: z.number().int().min(1).max(5),
    reasoningDepth: z.number().int().min(0).max(5),
    algebraLoad: z.number().int().min(0).max(5),
    abstraction: z.number().int().min(0).max(5),
    proofDemand: z.number().int().min(0).max(5),
    integrationCount: z.number().int().min(1).max(5),
  }),
  expectedMinutes: z.number().positive().max(240),
  numericCheck: z
    .strictObject({
      expected: z.number(),
      absoluteTolerance: z.number().nonnegative().max(1),
      unit: z.string().max(40),
    })
    .nullable(),
});
export const solverSchema = z.strictObject({
  answerMarkdown: z.string().min(1),
  usedCapabilities: z.array(refSchema),
  sufficientConditions: z.boolean(),
  circular: z.boolean(),
  explanation: z.string(),
});
export const validationSchema = z.strictObject({
  valid: z.boolean(),
  matchesIndependentSolution: z.boolean(),
  conditionsComplete: z.boolean(),
  withinScope: z.boolean(),
  nonCircular: z.boolean(),
  difficultyMatches: z.boolean(),
  reason: z.string(),
});
export const assessmentSchema = z.strictObject({
  state: z.enum(["graded", "needs_review"]),
  criteria: z.array(
    z.strictObject({
      criterionId: idSchema,
      awardedPoints: z.number().nonnegative(),
      maxPoints: z.number().positive(),
      feedback: z.string(),
      evidenceRanges: z.array(
        z.strictObject({
          start: z.number().int().nonnegative(),
          end: z.number().int().nonnegative(),
          quote: z.string(),
        }),
      ),
      citationIds: z.array(idSchema),
    }),
  ),
  outsideMethodUsed: z.boolean(),
  objectiveEvidence: z.array(
    z.strictObject({ objectiveId: idSchema, demonstrated: z.boolean() }),
  ),
  correctnessScore: z.number().nonnegative(),
  gradeSource: z.enum(["ai", "deterministic", "self", "override"]),
  feedback: z.string(),
});
export class MathError extends Error {
  constructor(
    public code: string,
    public statusCode = 400,
    public details: Record<string, unknown> = {},
  ) {
    super(code);
  }
}
export function invariant(
  value: unknown,
  code: string,
  status = 400,
  details: Record<string, unknown> = {},
): asserts value {
  if (!value) throw new MathError(code, status, details);
}
export function canonical(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((v) => canonical(v)).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function contentHash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export function checkBytes(
  value: unknown,
  limit: number,
  code = "MATH_SIZE_LIMIT",
): void {
  invariant(
    Buffer.byteLength(
      typeof value === "string" ? value : JSON.stringify(value),
      "utf8",
    ) <= limit,
    code,
    413,
  );
}
export function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema, ...body } = z.toJSONSchema(schema, { target: "draft-7" });
  return body;
}
