export default async function webhookRoutes(fastify) {
  const { prisma } = fastify;
  const UAZAPI_URL = process.env.UAZAPI_URL;

  fastify.post("/webhook", async (req, reply) => {
    const payload = req.body;

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

      if (!rawNumber)
        return reply.code(400).send({ error: "Número não encontrado" });

      const number = rawNumber.replace(/[@:].*/g, "");

      // 👉 O número do bot vem do dono da conta (user.botNumber)
      const botOwner = await prisma.user.findFirst({
        where: {
          botNumber:
            msg.owner || payload.owner || msg.chatid?.split("@")[0] || null,
        },
      });

      if (!botOwner)
        return reply.code(401).send({ error: "Bot não reconhecido" });

      const isFromBot = msg.fromMe === true;

      const userMessage =
        msg.text ||
        msg.content ||
        payload.text ||
        payload.body ||
        msg.message?.conversation ||
        msg.extendedTextMessage?.text ||
        msg.imageMessage?.caption ||
        "";

      let contact = await prisma.contact.findFirst({
        where: { phoneNumber: number, userId: botOwner.id },
      });

      if (!contact) {
        contact = await prisma.contact.create({
          data: { phoneNumber: number, userId: botOwner.id },
        });
      }

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

      if (isFromBot) {
        // 🟩 Mensagem enviada PELO bot
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

      // 🟨 Caso contrário, mensagem recebida do usuário → envia pro n8n
      const payloadWithSettings = {
        ...payload,
        botSettings,
        messageText: userMessage,
        phoneNumber: number,
      };

      console.log("\n====== Enviando mensagem para n8n ======");
      console.log("➡️ URL do webhook:", process.env.N8N_WEBHOOK_URL);
      console.log("➡️ Número do contato:", number);
      console.log("➡️ Mensagem:", userMessage);
      console.log("➡️ Payload final:", JSON.stringify(payloadWithSettings, null, 2));
      console.log("========================================\n");

      let response;
      try {
        response = await fetch(process.env.N8N_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payloadWithSettings),
        });
      } catch (err) {
        console.error("❌ Erro ao enviar requisição para o n8n:", err);
        return reply.code(500).send({ error: "Erro ao enviar para o n8n" });
      }

      // ✅ Loga o status HTTP e o corpo da resposta
      console.log("📩 Resposta do n8n - status:", response.status);

      let n8nReply = {};
      try {
        const text = await response.text();
        console.log("📄 Corpo da resposta do n8n:", text);
        try {
          n8nReply = JSON.parse(text);
        } catch {
          n8nReply = { reply: text };
        }
      } catch (err) {
        console.error("❌ Erro ao ler resposta do n8n:", err);
      }

      if (!response.ok) {
        console.error("⚠️ n8n retornou status de erro:", response.status);
      }

      // 💾 Salva a mensagem como USER
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
          actionType: "RECEIVED_MESSAGE",
          message: "Mensagem recebida do usuário",
        },
      });

      const replyText =
        typeof n8nReply === "string" ? n8nReply : n8nReply.reply;

      if (replyText) {
        // 📤 Envia a resposta automática
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
      console.error("Erro no webhook:", err);
      return reply.code(500).send({ error: err.message });
    }
  });
}