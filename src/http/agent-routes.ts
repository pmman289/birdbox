import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { normalizeAgentArch } from "../agent-release.js";

import type { AgentBroker } from "../agent-broker.js";
import type { AgentRegistration, AgentTaskResult } from "../agent-protocol.js";

interface AgentRoutesOptions { broker: AgentBroker; binaryPath?: string; }

function binaryForArch(base: string, requested: unknown): string {
  const arch = String(requested ?? "").toLowerCase();
  if (!arch) return base;
  const suffix = normalizeAgentArch(arch);
  if (!suffix) throw new Error("不支持的 Agent 架构");
  return path.extname(base) ? `${path.dirname(base)}/birdbox-agent-${suffix}` : path.join(base, `birdbox-agent-${suffix}`);
}

function body(request: FastifyRequest): Record<string, unknown> {
  const value = request.body;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Object.assign(new Error("Agent 请求体必须是对象"), { status: 400 });
  return value as Record<string, unknown>;
}

function token(request: FastifyRequest, input: Record<string, unknown>): string {
  const header = request.headers.authorization;
  if (typeof header === "string" && /^Bearer\s+/i.test(header)) return header.replace(/^Bearer\s+/i, "").trim();
  return String(input.token ?? "");
}

function nodeId(request: FastifyRequest, input: Record<string, unknown>): string {
  return String(input.nodeId ?? (request.params as { nodeId?: string })?.nodeId ?? "").trim();
}

function reject(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(401).send({ error: message, code: "AGENT_AUTH_REQUIRED" });
}

export const agentRoutes: FastifyPluginAsync<AgentRoutesOptions> = async (app, options) => {
  app.get<{ Querystring: { arch?: string } }>("/api/agent/releases/latest/download", async (request, reply) => {
    if (!options.binaryPath) return reply.code(404).send({ error: "Agent 二进制尚未发布" });
    try {
      const selected = binaryForArch(options.binaryPath, request.query.arch ?? process.arch);
      const stat = await fs.stat(selected);
      if (!stat.isFile()) return reply.code(404).send({ error: "Agent 二进制不存在" });
      return reply.type("application/octet-stream").header("content-length", stat.size).send(createReadStream(selected));
    } catch { return reply.code(404).send({ error: "Agent 二进制不存在" }); }
  });
  app.get<{ Querystring: { arch?: string } }>("/api/agent/releases/latest/checksum", async (request, reply) => {
    if (!options.binaryPath) return reply.code(404).send({ error: "Agent 二进制尚未发布" });
    try {
      const selected = binaryForArch(options.binaryPath, request.query.arch ?? process.arch);
      const digest = createHash("sha256").update(await fs.readFile(selected)).digest("hex");
      return reply.type("text/plain; charset=utf-8").send(`${digest}\n`);
    } catch { return reply.code(404).send({ error: "Agent 二进制不存在" }); }
  });

  app.post("/api/agent/register", async (request, reply) => {
    const input = body(request);
    try {
      const result = await options.broker.register(input as unknown as AgentRegistration);
      return reply.code(200).send({ ok: true, ...result });
    } catch (error) { return reject(reply, error instanceof Error ? error.message : "Agent 注册失败"); }
  });

  app.post("/api/agent/heartbeat", async (request, reply) => {
    const input = body(request); const id = nodeId(request, input);
    try { options.broker.heartbeat(id, token(request, input)); return reply.send({ ok: true }); }
    catch (error) { return reject(reply, error instanceof Error ? error.message : "Agent 心跳失败"); }
  });

  app.post("/api/agent/tasks/poll", async (request, reply) => {
    const input = body(request); const id = nodeId(request, input);
    const controller = new AbortController();
    const onClose = (): void => controller.abort();
    request.raw.socket.once("close", onClose);
    try {
      const task = await options.broker.poll(id, token(request, input), 25_000, controller.signal);
      if (task && (controller.signal.aborted || request.raw.socket.destroyed)) {
        options.broker.requeue(task);
        return reply;
      }
      return reply.send({ task });
    } catch (error) { return reject(reply, error instanceof Error ? error.message : "Agent 轮询失败"); }
    finally { request.raw.socket.off("close", onClose); }
  });

  app.post<{ Params: { taskId: string } }>("/api/agent/tasks/:taskId/result", { bodyLimit: 20 * 1024 * 1024, handler: async (request, reply) => {
    const input = body(request); const id = nodeId(request, input);
    try {
      const result = { ...input, taskId: request.params.taskId, nodeId: id } as unknown as AgentTaskResult;
      options.broker.result(result, token(request, input));
      return reply.send({ ok: true });
    } catch (error) { return reject(reply, error instanceof Error ? error.message : "Agent 任务结果提交失败"); }
  } });
};
