export default async function webhookRoutes(fastify) {
  const { prisma } = fastify;
  const UAZAPI_URL = process.env.UAZAPI_URL;

  fastify.post("/webhook", async (req, reply) => {
    const payload = req.body;

    try {
      const msg = payload.message || {};
      const chat = payload.chat || {};

      // Detecta número de origem
      const rawNumber =
        msg.chatid ||
        msg.sender ||
        chat.wa_chatid ||
        payload.from ||
        msg.key?.remoteJid ||
        msg.sender_pn;

      if (!rawNumber) {
        return reply.code(400).send({ error: "Número não encontrado" });
      }

      // Remove sufixos e caracteres não numéricos
      const clean = (num) => (num || "").replace(/[@:].*/g, "").replace(/\D/g, "");
      const number = clean(rawNumber);

      // Identifica o dono do bot (usuário da plataforma)
      const botOwner = await prisma.user.findFirst({
        where: { botNumber: msg.owner || msg.chatid?.split("@")[0] || null },
      });

      if (!botOwner) {
        return reply.code(401).send({ error: "Bot não reconhecido" });
      }

      // Normaliza número do bot e do remetente
      const botNumber = clean(botOwner.botNumber);
      const senderNumber = clean(
        msg.sender || msg.participant || msg.from || msg.remoteJid || msg.chatid
      );

      // Verifica se a mensagem veio do próprio bot
      const isFromBot = senderNumber === botNumber || msg.fromMe === true;

      // Extrai o texto da mensagem
      const userMessage =
        msg.text ||
        msg.content ||
        payload.text ||
        payload.body ||
        msg.message?.conversation ||
        msg.extendedTextMessage?.text ||
        msg.imageMessage?.caption ||
        "";

      // Garante que o contato existe no banco
      let contact = await prisma.contact.findFirst({
        where: { phoneNumber: number, userId: botOwner.id },
      });

      if (!contact) {
        contact = await prisma.contact.create({
          data: { phoneNumber: number, userId: botOwner.id },
        });
      }

      // Garante que o botSettings existe
      let botSettings = await prisma.botSettings.findFirst({
        where: { userId: botOwner.id },
      });

      if (!botSettings) {
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
      }

      // ================================
      // 🧠 Mensagem enviada pelo BOT
      // ================================
      if (isFromBot) {
        const cleanMessage = (userMessage || "").trim();
        const finalMessage = cleanMessage || "[mensagem sem texto]";

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

      // ================================
      // 💬 Mensagem recebida do USUÁRIO
      // ================================
      const cleanMessage = (userMessage || "").trim();
      if (!cleanMessage) {
        return reply.code(400).send({ error: "Mensagem vazia" });
      }

      // Salva a mensagem do usuário
      await prisma.message.create({
        data: {
          contactId: contact.id,
          userId: botOwner.id,
          sender: "USER",
          content: cleanMessage,
        },
      });

      await prisma.activityLog.create({
        data: {
          contactId: contact.id,
          userId: botOwner.id,
          actionType: "RECEIVED_MESSAGE",
          message: "Mensagem recebida do usuário",
        },
      });

      // Envia para o n8n processar
      const payloadWithSettings = {
        ...payload,
        botSettings,
        messageText: cleanMessage,
        phoneNumber: number,
      };

      const response = await fetch(process.env.N8N_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payloadWithSettings),
      });

      // Captura resposta do n8n
      let n8nReply = {};
      try {
        n8nReply = await response.json();
      } catch {
        const text = await response.text();
        n8nReply = { reply: text };
      }

      const replyText =
        typeof n8nReply === "string" ? n8nReply : n8nReply.reply || "";

      // Se o n8n retornou uma resposta, envia pelo bot
      if (replyText) {
        const sendResp = await fetch(`${UAZAPI_URL}/send/text`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            token: process.env.UAZAPI_TOKEN,
          },
          body: JSON.stringify({ number, text: replyText }),
        });

        await sendResp.json();

        // Salva resposta do bot
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

      return reply.send({ ok: true });
    } catch (err) {
      console.error("Erro no webhook:", err);
      return reply.code(500).send({ error: err.message });
    }
  });
}