export default async function webhookRoutes(fastify) {
  const { prisma } = fastify;
  const UAZAPI_URL = process.env.UAZAPI_URL;

  fastify.post("/webhook", async (req, reply) => {
    const payload = req.body;
    console.log("📩 [WEBHOOK] Payload recebido:", JSON.stringify(payload, null, 2));

    try {
      const msg = payload.message || {};
      const chat = payload.chat || {};
      const rawNumber =
        msg.chatid ||
        msg.sender ||
        chat.wa_chatid ||
        payload.from ||
        msg.key?.remoteJid ||
        msg.sender_pn;

      if (!rawNumber) {
        console.warn("⚠️ [WEBHOOK] Nenhum número encontrado no payload");
        return reply.code(400).send({ error: "Número não encontrado" });
      }

      const number = rawNumber.replace(/[@:].*/g, "");
      console.log("👤 [WEBHOOK] Número identificado:", number);

      const botOwner = await prisma.user.findFirst({
        where: { botNumber: msg.owner || msg.chatid?.split("@")[0] || null },
      });

      if (!botOwner) {
        console.warn("⚠️ [WEBHOOK] Bot não reconhecido:", msg.owner);
        return reply.code(401).send({ error: "Bot não reconhecido" });
      }

      const isFromBot = msg.fromMe === true || msg.owner === botOwner.botNumber;
      console.log("🤖 [WEBHOOK] Mensagem é do bot?", isFromBot);

      const userMessage =
        msg.text ||
        msg.content ||
        payload.text ||
        payload.body ||
        msg.message?.conversation ||
        msg.extendedTextMessage?.text ||
        msg.imageMessage?.caption ||
        "";

      console.log("💬 [WEBHOOK] Mensagem recebida:", userMessage);

      let contact = await prisma.contact.findFirst({
        where: { phoneNumber: number, userId: botOwner.id },
      });

      if (!contact) {
        console.log("📇 [WEBHOOK] Criando novo contato...");
        contact = await prisma.contact.create({
          data: { phoneNumber: number, userId: botOwner.id },
        });
      }

      let botSettings = await prisma.botSettings.findFirst({
        where: { userId: botOwner.id },
      });

      if (!botSettings) {
        console.log("⚙️ [WEBHOOK] Criando configurações padrão do bot...");
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

      // Se a mensagem for do próprio bot
      if (isFromBot) {
        const finalMessage = (userMessage || "[mensagem sem texto]").trim();
        console.log("📤 [WEBHOOK] Salvando mensagem do BOT:", finalMessage);

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

      // Caso venha do usuário, enviar pro n8n
      const payloadWithSettings = {
        ...payload,
        botSettings,
        messageText: userMessage,
        phoneNumber: number,
      };

      console.log("🌐 [WEBHOOK] Enviando para n8n:", process.env.N8N_WEBHOOK_URL);
      console.log("📦 [WEBHOOK] Payload enviado ao n8n:", JSON.stringify(payloadWithSettings, null, 2));

      const response = await fetch(process.env.N8N_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payloadWithSettings),
      });

      console.log("📡 [WEBHOOK] Status da resposta do n8n:", response.status);

      let n8nReply = {};
      try {
        n8nReply = await response.json();
        console.log("✅ [WEBHOOK] Resposta JSON do n8n:", n8nReply);
      } catch {
        const text = await response.text();
        console.log("ℹ️ [WEBHOOK] Resposta de texto do n8n:", text);
        n8nReply = { reply: text };
      }

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

      const replyText = typeof n8nReply === "string" ? n8nReply : n8nReply.reply;
      console.log("🤖 [WEBHOOK] Resposta interpretada do n8n:", replyText);

      if (replyText) {
        console.log("📤 [WEBHOOK] Enviando resposta via UAZAPI:", replyText);
        const sendResp = await fetch(`${UAZAPI_URL}/send/text`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            token: process.env.UAZAPI_TOKEN,
          },
          body: JSON.stringify({ number, text: replyText }),
        });

        const sendResult = await sendResp.json();
        console.log("📬 [WEBHOOK] Resposta da UAZAPI:", sendResult);

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
      } else {
        console.warn("⚠️ [WEBHOOK] Nenhum texto de resposta vindo do n8n");
      }

      return { ok: true };
    } catch (err) {
      console.error("❌ [WEBHOOK] Erro na rota:", err);
      return reply.code(500).send({ error: err.message, stack: err.stack });
    }
  });
}