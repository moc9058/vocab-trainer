import type { FastifyPluginAsync } from "fastify";
import {
  getExpressions,
  getExpression,
  addExpression,
  updateExpression,
  deleteExpression,
  getExpressionGroups,
  createExpressionGroup,
  updateExpressionGroup,
  deleteExpressionGroup,
  modifyExpressionGroupMembers,
} from "../firestore.js";
import type { Expression } from "../types.js";

const expressionRoutes: FastifyPluginAsync = async (fastify) => {
  // List expressions with filters & pagination
  fastify.get<{
    Params: { language: string };
    Querystring: { search?: string; purpose?: string; groupId?: string; page?: string; limit?: string };
  }>("/:language/items", async (request) => {
    const { language } = request.params;
    const { search, purpose, groupId } = request.query;
    const page = Math.max(1, parseInt(request.query.page ?? "1", 10) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(request.query.limit ?? "50", 10) || 50));
    return await getExpressions(language, { search, purpose, groupId }, { page, limit });
  });

  // Get single expression
  fastify.get<{ Params: { language: string; expressionId: string } }>(
    "/:language/items/:expressionId",
    async (request, reply) => {
      const item = await getExpression(request.params.expressionId);
      if (!item) return reply.notFound("Expression not found");
      return item;
    }
  );

  // Add expression
  fastify.post<{
    Params: { language: string };
    Body: Omit<Expression, "language">;
  }>(
    "/:language/items",
    {
      schema: {
        body: {
          type: "object",
          required: ["id", "phrase", "context"],
          properties: {
            id: { type: "string" },
            phrase: { type: "string" },
            context: { type: "string" },
            description: { type: "string" },
            purpose: { type: "array", items: { type: "string", enum: ["speaking", "writing"] } },
            groupIds: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
    async (request, reply) => {
      const { language } = request.params;
      const item: Expression = { ...request.body, language };
      await addExpression(item);
      return reply.status(201).send(item);
    }
  );

  // Update expression
  fastify.put<{
    Params: { language: string; expressionId: string };
    Body: Partial<Expression>;
  }>(
    "/:language/items/:expressionId",
    async (request, reply) => {
      const existing = await getExpression(request.params.expressionId);
      if (!existing) return reply.notFound("Expression not found");
      const updated = await updateExpression(request.params.expressionId, request.body);
      return updated;
    }
  );

  // Delete expression
  fastify.delete<{ Params: { language: string; expressionId: string } }>(
    "/:language/items/:expressionId",
    async (request, reply) => {
      const deleted = await deleteExpression(request.params.expressionId);
      if (!deleted) return reply.notFound("Expression not found");
      return { deleted: true };
    }
  );

  // ----- Expression Groups -----

  fastify.get<{ Params: { language: string } }>(
    "/:language/groups",
    async (request) => await getExpressionGroups(request.params.language)
  );

  fastify.post<{
    Params: { language: string };
    Body: { name: string };
  }>(
    "/:language/groups",
    {
      schema: {
        body: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string" } },
        },
      },
    },
    async (request, reply) => {
      const group = await createExpressionGroup(request.params.language, request.body.name);
      return reply.status(201).send(group);
    }
  );

  fastify.put<{
    Params: { language: string; groupId: string };
    Body: { name: string };
  }>(
    "/:language/groups/:groupId",
    {
      schema: {
        body: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string" } },
        },
      },
    },
    async (request) =>
      await updateExpressionGroup(request.params.groupId, { name: request.body.name })
  );

  fastify.delete<{ Params: { language: string; groupId: string } }>(
    "/:language/groups/:groupId",
    async (request) => {
      await deleteExpressionGroup(request.params.groupId);
      return { deleted: true };
    }
  );

  fastify.post<{
    Params: { language: string; groupId: string };
    Body: { expressionIds: string[]; action: "add" | "remove" };
  }>(
    "/:language/groups/:groupId/expressions",
    {
      schema: {
        body: {
          type: "object",
          required: ["expressionIds", "action"],
          properties: {
            expressionIds: { type: "array", items: { type: "string" } },
            action: { type: "string", enum: ["add", "remove"] },
          },
        },
      },
    },
    async (request) =>
      await modifyExpressionGroupMembers(
        request.params.groupId,
        request.body.expressionIds,
        request.body.action
      )
  );
};

export default expressionRoutes;
