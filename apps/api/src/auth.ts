/**
 * Auth + trace-id handling. Every /v1 response carries x-trace-id; missing or
 * wrong bearer tokens produce 401 ErrorResponse {error, traceId}.
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ErrorCode } from "@ui-intelligence/protocol";
import { authenticate, type Principal } from "./authz.js";

declare module "fastify" {
  interface FastifyRequest {
    traceId: string;
    principal?: Principal;
  }
}

export type AuthOptions = {
  token: string;
  /** User/key store; when absent only the operator token authenticates. */
  db?: Database;
};

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function extractToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization ?? "";
  if (header.startsWith("Bearer ")) return header.slice(7);
  // Dev-profile fallback: the Vorflux preview proxy strips Authorization
  // headers. Accept the token via access_token query parameter so the
  // browser editor can reach the API through a public preview URL.
  const query = request.url.split("?", 2)[1] ?? "";
  const params = new URLSearchParams(query);
  return params.get("access_token");
}

/** Authenticate the request to a principal (operator token OR user API key). */
export function verifyToken(request: FastifyRequest, options: AuthOptions): Principal | null {
  const presented = extractToken(request);
  if (presented === null) return null;
  // Constant-time operator comparison before any DB lookup.
  if (safeEqual(presented, options.token)) {
    return {
      userId: "operator",
      displayName: "Dev Operator",
      operator: true,
      roleFor: () => "owner",
    };
  }
  if (!options.db) return null;
  return authenticate(options.db, options.token, presented);
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
    // Minimal CORS support (dev profile): the browser editor runs on a
    // different origin than the API. Credential-free, echo-requested origin.
    const origin = request.headers.origin;
    if (origin) {
      reply.header("access-control-allow-origin", origin);
      reply.header("vary", "Origin");
      if (request.method === "OPTIONS") {
        reply.header("access-control-allow-methods", "GET,POST,PUT,DELETE,OPTIONS");
        reply.header("access-control-allow-headers", "authorization,content-type,idempotency-key");
        reply.header("access-control-max-age", "600");
        return reply.code(204);
      }
    }
    if (request.url === "/health") return; // liveness probe stays unauthenticated
    const principal = verifyToken(request, options);
    if (!principal) {
      sendError(reply, request.traceId, 401, "UNAUTHORIZED", "missing or invalid credentials");
      return reply;
    }
    request.principal = principal;
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
