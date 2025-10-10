import { buildApp } from "./app.js";

const PORT = process.env.PORT || 3000;

const start = async () => {
  const fastify = await buildApp();
  try {
    await fastify.listen({ port: PORT, host: "0.0.0.0" });
    fastify.log.info(`🚀 Servidor rodando em http://localhost:${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
