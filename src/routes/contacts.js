export default async function contactsRoutes(fastify) {
  const { prisma } = fastify
  const UAZAPI_URL = process.env.UAZAPI_URL
  const UAZAPI_TOKEN = process.env.UAZAPI_TOKEN

  fastify.post("/send", { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { number, text } = req.body
    const userId = req.user.id

    if (!number || !text) {
      return reply.code(400).send({ error: "Número e texto são obrigatórios" })
    }

    try {
      let contact =
        (await prisma.contact.findFirst({ where: { phoneNumber: number, userId } })) ||
        (await prisma.contact.create({ data: { phoneNumber: number, userId } }))

      const response = await fetch(`${UAZAPI_URL}/send/text`, {
        method: "POST",
        headers: { "Content-Type": "application/json", token: UAZAPI_TOKEN },
        body: JSON.stringify({ number, text }),
      })

      const data = await response.json()

      await prisma.message.create({
        data: { contactId: contact.id, userId, sender: "BOT", content: text },
      })

      await prisma.activityLog.create({
        data: {
          contactId: contact.id,
          userId,
          actionType: "SENT_MESSAGE",
          message: `Mensagem enviada manualmente: ${text}`,
        },
      })

      return reply.send(data)
    } catch (err) {
      return reply.code(500).send({ error: err.message })
    }
  })

  fastify.get("/conversations", { preHandler: [fastify.authenticate] }, async (req) => {
    const userId = req.user.id
    const messages = await prisma.message.findMany({
      where: { userId },
      include: { contact: true },
      orderBy: { timestamp: "desc" },
      take: 5,
    })
    return messages
  })

  fastify.get("/messages", { preHandler: [fastify.authenticate] }, async (req) => {
    const userId = req.user.id
    const messages = await prisma.message.findMany({
      where: { userId },
      include: { contact: true },
      orderBy: { timestamp: "desc" },
    })
    return messages.map((m) => ({
      id: m.id,
      message: m.content,
      user: m.contact?.name || m.sender || "Desconhecido",
      isBot: m.sender === "BOT",
      time: new Date(m.timestamp).toLocaleString("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }),
    }))
  })

  fastify.get("/logs", { preHandler: [fastify.authenticate] }, async (req) => {
    const userId = req.user.id
    const logs = await prisma.activityLog.findMany({
      where: { userId },
      include: { contact: true },
      orderBy: { timestamp: "desc" },
      take: 5,
    })
    return logs
  })

  fastify.get("/", { preHandler: [fastify.authenticate] }, async (req) => {
    const userId = req.user.id
    const contacts = await prisma.contact.findMany({
      where: { userId },
      include: { messages: { orderBy: { timestamp: "desc" }, take: 1 } },
    })

    return contacts.map((c) => ({
      id: c.id,
      name: c.name || c.phoneNumber,
      lastMessage: c.messages[0]?.content || "",
      time: c.messages[0]?.timestamp || null,
    }))
  })

  fastify.get("/:contactId", { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = req.user.id
    const { contactId } = req.params

    const messages = await prisma.message.findMany({
      where: { contactId, userId },
      orderBy: { timestamp: "asc" },
    })

    if (!messages.length) {
      return reply.code(404).send({ error: "Nenhuma mensagem encontrada" })
    }

    return messages
  })

  fastify.delete("/:contactId", { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = req.user.id;
    const { contactId } = req.params;

    try {
      const contact = await prisma.contact.findUnique({
        where: { id: contactId },
      });

      if (!contact || contact.userId !== userId) {
        return reply.code(404).send({ error: "Contato não encontrado ou não pertence ao usuário" });
      }

      await prisma.message.deleteMany({
        where: { contactId, userId },
      });

      await prisma.activityLog.deleteMany({
        where: { contactId, userId },
      });

      await prisma.contact.delete({
        where: { id: contactId },
      });

      return reply.send({ success: true, message: "Contato e mensagens excluídos com sucesso" });
    } catch (err) {
      console.error("Erro ao excluir contato:", err);
      reply.code(500).send({ error: "Erro interno ao excluir contato" });
    }
  });

}
