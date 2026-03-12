import type { FastifyPluginAsync } from "fastify";
import { listLanguages } from "../firestore.js";

const languagesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/", async () => {
    return await listLanguages();
  });
};

export default languagesRoutes;
