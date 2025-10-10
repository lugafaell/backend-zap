export default async function botRoutes(fastify) {
  const { prisma } = fastify;

  fastify.get("/settings", { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = req.user.id;
    const settings = await prisma.botSettings.findFirst({ where: { userId } });
    if (!settings) {
      const defaultSettings = await prisma.botSettings.create({
        data: {
          userId,
          personality: "divertido",
          language: "pt",
          autoJokes: true,
          autoTime: true,
          autoGreeting: true,
        },
      });
      return reply.send(defaultSettings);
    }
    return reply.send(settings);
  });

  fastify.post("/settings", { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = req.user.id;
    const { personality, language, autoJokes, autoTime, autoGreeting } = req.body;
    const existing = await prisma.botSettings.findFirst({ where: { userId } });

    const updated = existing
      ? await prisma.botSettings.update({
          where: { id: existing.id },
          data: { personality, language, autoJokes, autoTime, autoGreeting },
        })
      : await prisma.botSettings.create({
          data: { userId, personality, language, autoJokes, autoTime, autoGreeting },
        });

    return reply.send(updated);
  });
}
