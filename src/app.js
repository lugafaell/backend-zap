import Fastify from "fastify"
import dotenv from "dotenv"
import cors from "@fastify/cors"
import prismaPlugin from "./plugins/prisma.js"
import authPlugin from "./plugins/auth.js"
import authRoutes from "./routes/auth.js"
import webhookRoutes from "./routes/webhook.js"
import botRoutes from "./routes/bot.js"
import contactsRoutes from "./routes/contacts.js"
import miscRoutes from "./routes/misc.js"

dotenv.config()

export async function buildApp() {
  const fastify = Fastify({ logger: true })

  await fastify.register(cors, {
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  })

  await fastify.register(prismaPlugin)
  await fastify.register(authPlugin)

  await fastify.register(authRoutes)
  await fastify.register(webhookRoutes)
  await fastify.register(miscRoutes)

  await fastify.register(botRoutes, { prefix: "/bot" })
  await fastify.register(contactsRoutes, { prefix: "/contacts" })

  return fastify
}
