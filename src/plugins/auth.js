import fp from "fastify-plugin";
import jwt from "jsonwebtoken";

export default fp(async (fastify, opts) => {
  const JWT_SECRET = process.env.JWT_SECRET;

  fastify.decorate("authenticate", async (req, reply) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader) return reply.code(401).send({ error: "Token ausente" });

      const token = authHeader.split(" ")[1];
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = decoded;
    } catch (err) {
      reply.code(401).send({ error: "Token inválido ou expirado" });
    }
  });
});
