export default async function miscRoutes(fastify) {
  fastify.get("/ping", async () => ({ message: "pong" }));
}