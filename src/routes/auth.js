import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

export default async function authRoutes(fastify) {
  const { prisma } = fastify;
  const JWT_SECRET = process.env.JWT_SECRET;

  fastify.post("/auth/register", async (req, reply) => {
    const { email, password, botNumber } = req.body;
    if (!email || !password || !botNumber)
      return reply.code(400).send({ error: "Email, senha e número do bot são obrigatórios" });

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return reply.code(400).send({ error: "Usuário já existe" });

    const hashed = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { email, password: hashed, botNumber },
    });

    return reply.send({ message: "Usuário criado", userId: user.id });
  });

  fastify.post("/auth/login", async (req, reply) => {
    const { email, password } = req.body;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return reply.code(401).send({ error: "Usuário não encontrado" });

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) return reply.code(401).send({ error: "Senha incorreta" });

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: "7d" });
    return reply.send({ token });
  });
}
