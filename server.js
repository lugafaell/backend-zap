import Fastify from 'fastify'
import cors from '@fastify/cors'
import dotenv from 'dotenv'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { PrismaClient } from '@prisma/client'

dotenv.config()
const fastify = Fastify({ logger: true })
const prisma = new PrismaClient()
const UAZAPI_URL = process.env.UAZAPI_URL
const JWT_SECRET = process.env.JWT_SECRET

await fastify.register(cors, {
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
})

fastify.decorate('authenticate', async (req, reply) => {
    try {
        const authHeader = req.headers.authorization
        if (!authHeader) return reply.code(401).send({ error: 'Token ausente' })
        const token = authHeader.split(' ')[1]
        const decoded = jwt.verify(token, JWT_SECRET)
        req.user = decoded
    } catch (err) {
        reply.code(401).send({ error: 'Token inválido ou expirado' })
    }
})

fastify.post('/auth/register', async (req, reply) => {
    const { email, password, botNumber } = req.body
    if (!email || !password || !botNumber)
        return reply.code(400).send({ error: 'Email, senha e número do bot são obrigatórios' })
    const existing = await prisma.user.findUnique({ where: { email } })
    if (existing) return reply.code(400).send({ error: 'Usuário já existe' })
    const hashed = await bcrypt.hash(password, 10)
    const user = await prisma.user.create({
        data: { email, password: hashed, botNumber },
    })
    return reply.send({ message: 'Usuário criado', userId: user.id })
})

fastify.post('/auth/login', async (req, reply) => {
    const { email, password } = req.body
    const user = await prisma.user.findUnique({ where: { email } })
    if (!user) return reply.code(401).send({ error: 'Usuário não encontrado' })
    const isValid = await bcrypt.compare(password, user.password)
    if (!isValid) return reply.code(401).send({ error: 'Senha incorreta' })
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' })
    return reply.send({ token })
})

fastify.get('/ping', async () => ({ message: 'pong' }))

fastify.addHook('preHandler', async (req, reply) => {
    if (
        req.url.startsWith('/auth/') ||
        req.url.startsWith('/webhook') ||
        req.url === '/ping'
    ) {
        return
    }

    try {
        const authHeader = req.headers.authorization
        if (!authHeader) {
            return reply.code(401).send({ error: 'Token ausente' })
        }

        const token = authHeader.split(' ')[1]
        const decoded = jwt.verify(token, JWT_SECRET)
        req.user = decoded
    } catch (err) {
        return reply.code(401).send({ error: 'Token inválido ou expirado' })
    }
})

fastify.post('/webhook', async (req, reply) => {
    const payload = req.body
    try {
        const msg = payload.message || {}
        const chat = payload.chat || {}
        const rawNumber = msg.chatid || msg.sender || chat.wa_chatid || payload.from || msg.key?.remoteJid || msg.sender_pn
        if (!rawNumber) return reply.code(400).send({ error: 'Número não encontrado' })
        const number = rawNumber.replace(/[@:].*/g, '')

        const botOwner = await prisma.user.findFirst({
            where: { botNumber: msg.owner || msg.chatid?.split('@')[0] || null },
        })
        if (!botOwner) return reply.code(401).send({ error: 'Bot não reconhecido' })

        const isFromBot = msg.fromMe === true || msg.owner === botOwner.botNumber

        const userMessage =
            msg.text ||
            msg.content ||
            payload.text ||
            payload.body ||
            msg.message?.conversation ||
            msg.extendedTextMessage?.text ||
            msg.imageMessage?.caption ||
            ''

        let contact = await prisma.contact.findFirst({
            where: { phoneNumber: number, userId: botOwner.id },
        })
        if (!contact)
            contact = await prisma.contact.create({
                data: { phoneNumber: number, userId: botOwner.id },
            })

        let botSettings = await prisma.botSettings.findFirst({
            where: { userId: botOwner.id },
        })
        if (!botSettings)
            botSettings = await prisma.botSettings.create({
                data: {
                    userId: botOwner.id,
                    personality: 'divertido',
                    language: 'pt',
                    autoJokes: true,
                    autoTime: true,
                    autoGreeting: true,
                },
            })

        if (isFromBot) {
            const cleanMessage = (userMessage || '').trim()
            const finalMessage = cleanMessage || '[mensagem sem texto]'
            await prisma.message.create({
                data: {
                    contactId: contact.id,
                    userId: botOwner.id,
                    sender: 'BOT',
                    content: finalMessage,
                },
            })
            await prisma.activityLog.create({
                data: {
                    contactId: contact.id,
                    userId: botOwner.id,
                    actionType: 'BOT_MESSAGE',
                    message: `Bot enviou: ${finalMessage}`,
                },
            })
            return reply.code(200).send({ saved: true, from: 'BOT' })
        }

        const payloadWithSettings = { ...payload, botSettings, messageText: userMessage, phoneNumber: number }
        const response = await fetch(process.env.N8N_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payloadWithSettings),
        })
        let n8nReply = {}
        try {
            n8nReply = await response.json()
        } catch (e) {
            const text = await response.text()
            n8nReply = { reply: text }
        }

        await prisma.message.create({
            data: {
                contactId: contact.id,
                userId: botOwner.id,
                sender: 'USER',
                content: userMessage.trim(),
            },
        })
        await prisma.activityLog.create({
            data: {
                contactId: contact.id,
                userId: botOwner.id,
                actionType: 'SENT_MESSAGE',
                message: 'Mensagem recebida do usuário',
            },
        })

        const replyText = typeof n8nReply === 'string' ? n8nReply : n8nReply.reply
        if (replyText) {
            const sendResp = await fetch(`${UAZAPI_URL}/send/text`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', token: process.env.UAZAPI_TOKEN },
                body: JSON.stringify({ number, text: replyText }),
            })
            await sendResp.json()
            await prisma.message.create({
                data: {
                    contactId: contact.id,
                    userId: botOwner.id,
                    sender: 'BOT',
                    content: replyText,
                },
            })
            await prisma.activityLog.create({
                data: {
                    contactId: contact.id,
                    userId: botOwner.id,
                    actionType: 'AUTO_REPLY',
                    message: `Bot respondeu: ${replyText}`,
                },
            })
        }
        return { ok: true }
    } catch (err) {
        return reply.code(500).send({ error: err.message })
    }
})

fastify.post('/send', async (req, reply) => {
    const { number, text } = req.body
    const userId = req.user.id
    try {
        let contact = await prisma.contact.findFirst({ where: { phoneNumber: number, userId } })
        if (!contact)
            contact = await prisma.contact.create({ data: { phoneNumber: number, userId } })
        const response = await fetch(`${UAZAPI_URL}/send/text`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', token: process.env.UAZAPI_TOKEN },
            body: JSON.stringify({ number, text }),
        })
        const data = await response.json()
        await prisma.message.create({
            data: { contactId: contact.id, userId, sender: 'BOT', content: text },
        })
        await prisma.activityLog.create({
            data: { contactId: contact.id, userId, actionType: 'SENT_MESSAGE', message: `Mensagem enviada manualmente: ${text}` },
        })
        return data
    } catch (err) {
        reply.code(500).send({ error: err.message })
    }
})

fastify.get('/conversations', async (req, reply) => {
    const userId = req.user.id
    const messages = await prisma.message.findMany({
        where: { userId },
        include: { contact: true },
        orderBy: { timestamp: 'desc' },
        take: 5,
    })
    return messages
})

fastify.get('/messages', async (req, reply) => {
    const userId = req.user.id
    const messages = await prisma.message.findMany({
        where: { userId },
        include: { contact: true },
        orderBy: { timestamp: 'desc' },
    })
    return messages.map(m => ({
        id: m.id,
        message: m.content,
        user: m.contact?.name || m.sender || 'Desconhecido',
        isBot: m.sender === 'BOT',
        time: new Date(m.timestamp).toLocaleString('pt-BR', { hour: '2-digit', minute: '2-digit', hour12: false }),
    }))
})

fastify.get('/logs', async (req, reply) => {
    const userId = req.user.id
    const logs = await prisma.activityLog.findMany({
        where: { userId },
        include: { contact: true },
        orderBy: { timestamp: 'desc' },
        take: 5,
    })
    return logs
})

fastify.get('/contacts', async (req, reply) => {
    const userId = req.user.id
    const contacts = await prisma.contact.findMany({
        where: { userId },
        include: { messages: { orderBy: { timestamp: 'desc' }, take: 1 } },
    })
    return contacts.map(c => ({
        id: c.id,
        name: c.name || c.phoneNumber,
        lastMessage: c.messages[0]?.content || '',
        time: c.messages[0]?.timestamp || null,
    }))
})

fastify.get('/messages/:contactId', async (req, reply) => {
    const userId = req.user.id
    const { contactId } = req.params
    const messages = await prisma.message.findMany({
        where: { contactId, userId },
        orderBy: { timestamp: 'asc' },
    })
    return messages
})

fastify.get('/bot/settings', async (req, reply) => {
    const userId = req.user.id
    const settings = await prisma.botSettings.findFirst({ where: { userId } })
    if (!settings) {
        const defaultSettings = await prisma.botSettings.create({
            data: { userId, personality: 'divertido', language: 'pt', autoJokes: true, autoTime: true, autoGreeting: true },
        })
        return reply.send(defaultSettings)
    }
    return reply.send(settings)
})

fastify.post('/bot/settings', async (req, reply) => {
    const userId = req.user.id
    const { personality, language, autoJokes, autoTime, autoGreeting } = req.body
    const existing = await prisma.botSettings.findFirst({ where: { userId } })
    const updated = existing
        ? await prisma.botSettings.update({
            where: { id: existing.id },
            data: { personality, language, autoJokes, autoTime, autoGreeting },
        })
        : await prisma.botSettings.create({
            data: { userId, personality, language, autoJokes, autoTime, autoGreeting },
        })
    return reply.send(updated)
})

fastify.listen({ port: process.env.PORT || 3000, host: '0.0.0.0' }, (err, address) => {
    if (err) {
        fastify.log.error(err)
        process.exit(1)
    }
    fastify.log.info(`Servidor rodando em ${address}`)
})