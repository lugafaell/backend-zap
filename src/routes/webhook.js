export default async function webhookRoutes(fastify) {
  const { prisma } = fastify;
  const UAZAPI_URL = process.env.UAZAPI_URL;

  fastify.post("/webhook", async (req, reply) => {
    const payload = req.body;

    try {
      fastify.log.info("📩 [WEBHOOK] Payload recebido:", payload);

      const msg = payload.message || {};
      const chat = payload.chat || {};

      const rawNumber =
        msg.chatid ||
        msg.sender ||
        chat.wa_chatid ||
        payload.from ||
        msg.key?.remoteJid ||
        msg.sender_pn;

      if (!rawNumber)
        return reply.code(400).send({ error: "Número não encontrado" });

      const number = rawNumber.replace(/[@:].*/g, "");
      fastify.log.info("👤 [WEBHOOK] Número identificado:", number);

      const botOwner = await prisma.user.findFirst({
        where: { botNumber: msg.owner || msg.chatid?.split("@")[0] || null },
      });

      if (!botOwner)
        return reply.code(401).send({ error: "Bot não reconhecido" });

      // 🔧 Correção na detecção de mensagens enviadas pelo bot
      const isFromBot =
        msg.fromMe === true ||
        msg.sender === `${botOwner.botNumber}@s.whatsapp.net`;

      fastify.log.info(
        "🤖 [WEBHOOK] Verificação de origem:",
        `fromMe=${msg.fromMe}, sender=${msg.sender}, owner=${msg.owner}, botNumber=${botOwner.botNumber}, isFromBot=${isFromBot}`
      );

      const userMessage =
        msg.text ||
        msg.content ||
        payload.text ||
        payload.body ||
        msg.message?.conversation ||
        msg.extendedTextMessage?.text ||
        msg.imageMessage?.caption ||
        "";

      fastify.log.info("💬 [WEBHOOK] Mensagem recebida:", userMessage);

      let contact = await prisma.contact.findFirst({
        where: { phoneNumber: number, userId: botOwner.id },
      });

      if (!contact)
        contact = await prisma.contact.create({
          data: { phoneNumber: number, userId: botOwner.id },
        });

      let botSettings = await prisma.botSettings.findFirst({
        where: { userId: botOwner.id },
      });

      if (!botSettings)
        botSettings = await prisma.botSettings.create({
          data: {
            userId: botOwner.id,
            personality: "divertido",
            language: "pt",
            autoJokes: true,
            autoTime: true,
            autoGreeting: true,
          },
        });

      // 🟡 Caso seja mensagem do próprio bot
      if (isFromBot) {
        const cleanMessage = (userMessage || "").trim();
        const finalMessage = cleanMessage || "[mensagem sem texto]";

        fastify.log.info("📤 [WEBHOOK] Salvando mensagem do BOT:", finalMessage);

        await prisma.message.create({
          data: {
            contactId: contact.id,
            userId: botOwner.id,
            sender: "BOT",
            content: finalMessage,
          },
        });

        await prisma.activityLog.create({
          data: {
            contactId: contact.id,
            userId: botOwner.id,
            actionType: "BOT_MESSAGE",
            message: `Bot enviou: ${finalMessage}`,
          },
        });

        return reply.code(200).send({ saved: true, from: "BOT" });
      }

      // 🟢 Mensagem do usuário → envia para o n8n
      const payloadWithSettings = {
        ...payload,
        botSettings,
        messageText: userMessage,
        phoneNumber: number,
      };

      fastify.log.info("📨 [WEBHOOK] Enviando payload para N8N:", {
        url: process.env.N8N_WEBHOOK_URL,
        body: payloadWithSettings,
      });

      const response = await fetch(process.env.N8N_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payloadWithSettings),
      });

      let n8nReply = {};
      try {
        n8nReply = await response.json();
      } catch {
        const text = await response.text();
        n8nReply = { reply: text };
      }

      fastify.log.info("📬 [WEBHOOK] Resposta do N8N:", n8nReply);

      await prisma.message.create({
        data: {
          contactId: contact.id,
          userId: botOwner.id,
          sender: "USER",
          content: userMessage.trim(),
        },
      });

      await prisma.activityLog.create({
        data: {
          contactId: contact.id,
          userId: botOwner.id,
          actionType: "SENT_MESSAGE",
          message: "Mensagem recebida do usuário",
        },
      });

      const replyText =
        typeof n8nReply === "string" ? n8nReply : n8nReply.reply;

      if (replyText) {
        fastify.log.info("💬 [WEBHOOK] Enviando resposta para usuário:", {
          number,
          replyText,
        });

        const sendResp = await fetch(`${UAZAPI_URL}/send/text`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            token: process.env.UAZAPI_TOKEN,
          },
          body: JSON.stringify({ number, text: replyText }),
        });

        await sendResp.json();

        await prisma.message.create({
          data: {
            contactId: contact.id,
            userId: botOwner.id,
            sender: "BOT",
            content: replyText,
          },
        });

        await prisma.activityLog.create({
          data: {
            contactId: contact.id,
            userId: botOwner.id,
            actionType: "AUTO_REPLY",
            message: `Bot respondeu: ${replyText}`,
          },
        });
      }

      return { ok: true };
    } catch (err) {
      fastify.log.error("❌ [WEBHOOK] Erro:", err);
      return reply.code(500).send({ error: err.message });
    }
  });
}