import Fastify from 'fastify'
import cors from '@fastify/cors'
import dotenv from 'dotenv'
import { PrismaClient } from '@prisma/client'

dotenv.config()

const fastify = Fastify({ logger: true })
const prisma = new PrismaClient()

const UAZAPI_URL = process.env.UAZAPI_URL
const N8N_WEBHOOK = process.env.N8N_WEBHOOK_URL

await fastify.register(cors, {
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
})

fastify.get('/ping', async () => {
    return { message: 'pong' }
})

fastify.post('/webhook', async (req, reply) => {
    const payload = req.body
    console.log("📨 Mensagem recebida:", JSON.stringify(payload, null, 2))

    try {
        const msg = payload.message || {}
        const chat = payload.chat || {}

        const rawNumber =
            msg.chatid ||
            msg.sender ||
            chat.wa_chatid ||
            payload.from ||
            msg.key?.remoteJid ||
            msg.sender_pn

        if (!rawNumber) {
            console.log("❌ Número não encontrado. Payload:", JSON.stringify(payload, null, 2))
            return reply.code(400).send({ error: 'Número não encontrado' })
        }

        const number = rawNumber.replace(/[@:].*/g, '')
        const isFromBot = msg.fromMe === true || msg.owner === process.env.BOT_NUMBER

        const userMessage =
            msg.text ||
            msg.content ||
            payload.text ||
            payload.body ||
            msg.message?.conversation ||
            msg.extendedTextMessage?.text ||
            msg.imageMessage?.caption ||
            ''

        let contact = await prisma.contact.findUnique({ where: { phoneNumber: number } })
        if (!contact) {
            contact = await prisma.contact.create({ data: { phoneNumber: number } })
        }

        if (isFromBot) {
            console.log(`🤖 Mensagem enviada pelo BOT (${process.env.BOT_NUMBER}) — não será enviada ao n8n`)
            console.log("🧠 Dados da mensagem do BOT:", JSON.stringify({
                chatid: msg.chatid,
                sender: msg.sender,
                owner: msg.owner,
                fromMe: msg.fromMe,
                text: msg.text,
                content: msg.content,
                userMessage,
            }, null, 2))

            try {
                const cleanMessage = (userMessage || '').trim()
                const finalMessage = cleanMessage || '[mensagem sem texto]'

                const savedMsg = await prisma.message.create({
                    data: {
                        contactId: contact.id,
                        sender: 'BOT',
                        content: finalMessage,
                    },
                })
                console.log(`💾 Mensagem do BOT salva no banco: "${finalMessage}"`)

                await prisma.activityLog.create({
                    data: {
                        contactId: contact.id,
                        actionType: 'BOT_MESSAGE',
                        message: `Bot enviou: ${finalMessage}`,
                    },
                })
                console.log("✅ Log de atividade criado para mensagem do BOT.")
            } catch (err) {
                console.log("❌ Erro ao salvar mensagem do BOT:", err)
            }

            return reply.code(200).send({ saved: true, from: 'BOT' })
        }

        console.log(`💬 Mensagem recebida de ${number}: "${userMessage}"`)

        const response = await fetch(process.env.N8N_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        })

        let n8nReply = {}
        try {
            n8nReply = await response.json()
        } catch (e) {
            const text = await response.text()
            console.log("⚠️ Resposta não JSON do n8n:", text)
            n8nReply = { reply: text }
        }

        await prisma.message.create({
            data: {
                contactId: contact.id,
                sender: 'USER',
                content: userMessage.trim(),
            },
        })

        await prisma.activityLog.create({
            data: {
                contactId: contact.id,
                actionType: 'SENT_MESSAGE',
                message: 'Mensagem recebida do usuário',
            },
        })

        const replyText =
            typeof n8nReply === 'string' ? n8nReply : n8nReply.reply

        if (replyText) {
            const sendResp = await fetch(`${UAZAPI_URL}/send/text`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    token: process.env.UAZAPI_TOKEN,
                },
                body: JSON.stringify({ number, text: replyText }),
            })

            await sendResp.json()

            await prisma.message.create({
                data: {
                    contactId: contact.id,
                    sender: 'BOT',
                    content: replyText,
                },
            })

            await prisma.activityLog.create({
                data: {
                    contactId: contact.id,
                    actionType: 'AUTO_REPLY',
                    message: `Bot respondeu: ${replyText}`,
                },
            })
        }

        return { ok: true }
    } catch (err) {
        console.log("❌ Erro no webhook:", err)
        return reply.code(500).send({ error: err.message })
    }
})

fastify.post('/send', async (req, reply) => {
    const { number, text } = req.body
    try {
        let contact = await prisma.contact.findUnique({ where: { phoneNumber: number } })
        if (!contact) {
            contact = await prisma.contact.create({ data: { phoneNumber: number } })
        }
        const response = await fetch(`${UAZAPI_URL}/send/text`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                token: process.env.UAZAPI_TOKEN,
            },
            body: JSON.stringify({ number, text }),
        })
        const data = await response.json()
        await prisma.message.create({
            data: {
                contactId: contact.id,
                sender: 'BOT',
                content: text,
            },
        })
        await prisma.activityLog.create({
            data: {
                contactId: contact.id,
                actionType: 'SENT_MESSAGE',
                message: `Mensagem enviada manualmente: ${text}`,
            },
        })
        console.log(data)
        return data
    } catch (err) {
        reply.code(500).send({ error: err.message })
    }
})

fastify.get('/conversations', async (req, reply) => {
    const messages = await prisma.message.findMany({
        include: { contact: true },
        orderBy: { timestamp: "desc" },
        take: 5,
    })
    return messages
})

fastify.get('/messages', async (req, reply) => {
    const messages = await prisma.message.findMany({
        include: { contact: true },
        orderBy: { timestamp: 'desc' },
    })

    const formatted = messages.map((m) => ({
        id: m.id,
        message: m.content,
        user: m.contact?.name || m.sender || "Desconhecido",
        isBot: m.sender === "bot",
        time: new Date(m.timestamp).toLocaleString("pt-BR", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
        }),
    }));

    return formatted
})

fastify.get('/logs', async (req, reply) => {
    const logs = await prisma.activityLog.findMany({
        include: { contact: true },
        orderBy: { timestamp: "desc" },
        take: 5,
    })
    return logs
})

fastify.get('/contacts', async (req, reply) => {
    const contacts = await prisma.contact.findMany({
        include: {
            messages: {
                orderBy: { timestamp: "desc" },
                take: 1,
            },
        },
    })

    return contacts.map(c => ({
        id: c.id,
        name: c.name || c.phoneNumber,
        lastMessage: c.messages[0]?.text || '',
        time: c.messages[0]?.timestamp || null,
    }))
})

fastify.get('/messages/:contactId', async (req, reply) => {
    const { contactId } = req.params
    const messages = await prisma.message.findMany({
        where: { contactId },
        orderBy: { timestamp: 'asc' },
    })
    return messages
})

fastify.listen({
    port: process.env.PORT || 3000,
    host: '0.0.0.0'
}, (err, address) => {
    if (err) {
        fastify.log.error(err)
        process.exit(1)
    }
    fastify.log.info(`Servidor rodando em ${address}`)
})
