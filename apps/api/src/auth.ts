/**
 * Auth + trace-id handling. Every /v1 response carries x-trace-id; missing or
 * wrong bearer tokens produce 401 ErrorResponse {error, traceId}.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ErrorCode } from "@ui-intelligence/protocol";

declare module "fastify" {
  interface FastifyRequest {
    traceId: string;
  }
}

export type AuthOptions = {
  token: string;
};

export function verifyToken(request: FastifyRequest, token: string): boolean {
  const header = request.headers.authorization ?? "";
  return header === `Bearer ${token}`;
}

export function sendError(reply: FastifyReply, traceId: string, status: number, code: ErrorCode, message: string, details?: unknown): void {
  reply.code(status).send({
    error: { code, message, ...(details !== undefined ? { details } : {}) },
    traceId,
  });
}

export function registerAuthAndErrors(app: FastifyInstance, options: AuthOptions): void {
  app.addHook("onRequest", async (request, reply) => {
    request.traceId = randomUUID();
    if (request.url === "/health") return; // liveness probe stays unauthenticated
    if (!verifyToken(request, options.token)) {
      sendError(reply, request.traceId, 401, "UNAUTHORIZED", "missing or invalid bearer token");
      return reply;
    }
  });

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-trace-id", request.traceId);
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    const err = error as { statusCode?: number; httpStatus?: number; code?: ErrorCode; details?: unknown };
    const status = typeof err.httpStatus === "number" ? err.httpStatus : typeof err.statusCode === "number" && err.statusCode >= 400 ? err.statusCode : 500;
    sendError(reply, request.traceId, status, err.code ?? (status >= 500 ? "INTERNAL" : "SCHEMA_INVALID"), error.message, err.details);
  });
}
