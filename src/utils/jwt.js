import jwt from "jsonwebtoken"

const JWT_SECRET = process.env.JWT_SECRET
const TOKEN_EXPIRATION = "7d"

export function generateToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_EXPIRATION })
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET)
  } catch (err) {
    return null
  }
}

export async function authenticate(request, reply) {
  const authHeader = request.headers.authorization
  if (!authHeader) {
    return reply.code(401).send({ error: "Token ausente" })
  }

  const token = authHeader.replace("Bearer ", "").trim()
  const decoded = verifyToken(token)

  if (!decoded) {
    return reply.code(401).send({ error: "Token inválido ou expirado" })
  }

  request.user = decoded
}
