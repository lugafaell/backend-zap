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
    origin: ['http://localhost:5173'],
    methods: ['GET', 'POST', 'OPTIONS'],
})

fastify.get('/ping', async () => {
    return { message: 'pong' }
})

fastify.post('/webhook', async (req, reply) => {
    const message = req.body
    fastify.log.info("📨 Mensagem recebida:", message)

    try {
        const response = await fetch(process.env.N8N_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(message),
        })

        let n8nReply = {};
        try {
            n8nReply = await response.json();
        } catch (e) {
            const text = await response.text();
            console.warn("Resposta não JSON do n8n:", text);
            n8nReply = { reply: text };
        }

        const rawNumber =
            message.chatid ||
            message.sender ||
            message.from ||
            message.key?.remoteJid ||
            message.key?.chatid

        if (!rawNumber) {
            return reply.code(400).send({ error: 'Número não encontrado' })
        }

        const number = rawNumber.replace(/[@:].*/g, '')

        let contact = await prisma.contact.findUnique({ where: { phoneNumber: number } })
        if (!contact) {
            contact = await prisma.contact.create({ data: { phoneNumber: number } })
        }

        const userMessage =
            message.text ||
            message.body ||
            message.message?.conversation ||
            message.message?.extendedTextMessage?.text ||
            message.message?.imageMessage?.caption ||
            message.content ||
            ''

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
        fastify.log.error("❌ Erro no webhook:", err)
        reply.code(500).send({ error: err.message })
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
