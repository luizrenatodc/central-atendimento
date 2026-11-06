import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { Central, ErroCentral, abrirBanco, type Transporte } from "./central.ts";
import { iniciarDemonstracao } from "./demonstracao.ts";

const PUBLICO = fileURLToPath(new URL("../public/", import.meta.url));
const TIPOS: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript" };

async function bruto(req: IncomingMessage): Promise<string> {
  let t = "";
  for await (const p of req) {
    t += p;
    if (t.length > 256_000) throw new ErroCentral("corpo_grande", "Pedido grande demais", 413);
  }
  return t;
}

/** Valida a assinatura sobre o corpo cru: reserializar o JSON mudaria os bytes. */
export function assinaturaValida(corpo: string, cabecalho: unknown, segredo: string): boolean {
  if (typeof cabecalho !== "string" || !cabecalho.startsWith("sha256=")) return false;
  const esperado = Buffer.from(createHmac("sha256", segredo).update(corpo).digest("hex"));
  const recebido = Buffer.from(cabecalho.slice(7));
  return esperado.length === recebido.length && timingSafeEqual(esperado, recebido);
}

export function criarServidor(central: Central, segredo: string): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const caminho = url.pathname;
    const metodo = req.method ?? "GET";
    const responder = (dados: unknown, status = 200) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(dados));
    try {
      if (caminho === "/webhook" && metodo === "POST") {
        const texto = await bruto(req);
        if (!assinaturaValida(texto, req.headers["x-hub-signature-256"], segredo)) throw new ErroCentral("assinatura", "Assinatura inválida", 401);
        central.receberWebhook(JSON.parse(texto));
        return responder({ ok: true });
      }
      if (caminho === "/api/eventos") {
        // Cada evento leva o seq como id, e o navegador devolve o último ao reconectar.
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        const envia = (e: any) => res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
        const ultimo = Number(req.headers["last-event-id"] ?? url.searchParams.get("desde") ?? -1);
        if (ultimo >= 0) central.eventosDesde(ultimo).forEach(envia);
        const sair = central.ouvir(envia);
        const batida = setInterval(() => res.write(": ok\n\n"), 20_000);
        req.on("close", () => {
          sair();
          clearInterval(batida);
        });
        return;
      }
      if (caminho.startsWith("/api/")) {
        const ator = String(req.headers["x-atendente"] ?? "");
        const [, , a, b, c] = caminho.split("/");
        const dados = metodo === "POST" ? JSON.parse((await bruto(req)) || "{}") : {};
        if (a === "atendentes" && metodo === "GET") return responder(central.atendentes());
        if (a === "metricas") return responder(central.metricas());
        if (a === "status" && metodo === "POST") return responder((central.definirStatus(ator, dados.status), { ok: true }));
        if (a === "conversas" && !b) return responder(central.conversasPara(ator));
        if (a === "conversas" && b) {
          const id = Number(b);
          if (metodo === "GET") return responder(central.detalhe(id));
          if (c === "assumir") central.assumir(id, ator);
          else if (c === "responder") central.responder(id, ator, String(dados.texto ?? ""));
          else if (c === "nota") central.nota(id, ator, String(dados.texto ?? ""));
          else if (c === "transferir") central.transferir(id, ator, dados.fila);
          else if (c === "encerrar") central.encerrar(id, ator);
          else throw new ErroCentral("rota", "Rota não encontrada", 404);
          return responder({ ok: true });
        }
        throw new ErroCentral("rota", "Rota não encontrada", 404);
      }
      const arquivo = normalize(caminho === "/" ? "index.html" : caminho.slice(1));
      if (arquivo.startsWith("..")) throw new ErroCentral("proibido", "Proibido", 403);
      const conteudo = await readFile(join(PUBLICO, arquivo));
      res.writeHead(200, { "content-type": TIPOS[extname(arquivo)] ?? "application/octet-stream" }).end(conteudo);
    } catch (e) {
      const conhecido = e instanceof ErroCentral;
      const status = conhecido ? e.status : (e as NodeJS.ErrnoException).code === "ENOENT" ? 404 : e instanceof SyntaxError ? 400 : 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) responder({ erro: conhecido ? e.codigo : "erro", mensagem: conhecido ? e.message : "Não foi possível concluir" }, status);
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const segredo = process.env.SEGREDO_WEBHOOK ?? "segredo-de-demonstracao";
  const porta = Number(process.env.PORTA ?? 3000);
  let ligacao: (telefone: string, texto: string, id: string) => void = () => {};
  const transporte: Transporte = {
    async enviar(telefone, texto) {
      const id = `wamid.${crypto.randomUUID()}`;
      ligacao(telefone, texto, id);
      return { id };
    },
  };
  const central = new Central(abrirBanco(process.env.BANCO ?? ":memory:"), transporte);
  criarServidor(central, segredo).listen(porta, () => console.log(`Central em http://localhost:${porta}`));
  setInterval(() => void central.despachar(), 300);
  setInterval(() => central.verificarSla(), 5000);
  ligacao = iniciarDemonstracao(central, porta, segredo);
}
