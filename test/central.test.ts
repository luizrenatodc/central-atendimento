import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { Central, ErroCentral, JANELA_24H, SLA_PRIMEIRA_RESPOSTA, abrirBanco, triar, type Transporte } from "../src/central.ts";
import { assinaturaValida, criarServidor } from "../src/servidor.ts";

function montar(transporte?: Transporte) {
  const enviados: string[] = [];
  let agora = 1_000_000;
  const padrao: Transporte = { enviar: async (_t, texto) => (enviados.push(texto), { id: `w${enviados.length}` }) };
  const c = new Central(abrirBanco(), transporte ?? padrao, () => agora);
  c.cadastrar({ id: "ana", nome: "Ana", papel: "atendente", filas: ["vendas", "suporte"], capacidade: 2, status: "online" });
  c.cadastrar({ id: "bia", nome: "Bia", papel: "atendente", filas: ["vendas"], capacidade: 2, status: "online" });
  c.cadastrar({ id: "sup", nome: "Sup", papel: "supervisor", filas: [], capacidade: 0, status: "online" });
  return { c, enviados, avancar: (ms: number) => (agora += ms) };
}

let n = 0;
const msg = (from: string, texto: string, id = `m${n++}`) => ({ entry: [{ changes: [{ value: { contacts: [{ wa_id: from, profile: { name: `Cliente ${from}` } }], messages: [{ id, from, type: "text", text: { body: texto } }] } }] }] });
const status = (id: string, s: string) => ({ entry: [{ changes: [{ value: { statuses: [{ id, status: s }] } }] }] });
const primeira = (c: Central, ator: string) => c.conversasPara(ator)[0];

test("triagem separa filas e detecta urgência", () => {
  assert.deepEqual(triar("meu boleto veio errado"), { fila: "financeiro", prioridade: 0 });
  assert.deepEqual(triar("o app não funciona"), { fila: "suporte", prioridade: 0 });
  assert.deepEqual(triar("quero cancelar, é urgente"), { fila: "suporte", prioridade: 1 });
  assert.equal(triar("qual o preço?").fila, "vendas");
});

test("reentrega do webhook não duplica a mensagem", () => {
  const { c } = montar();
  c.receberWebhook(msg("1", "oi", "repetida"));
  c.receberWebhook(msg("1", "oi", "repetida"));
  assert.equal(c.detalhe(primeira(c, "sup").id).mensagens.length, 1);
});

test("novas mensagens do mesmo cliente entram na conversa ativa", () => {
  const { c } = montar();
  c.receberWebhook(msg("1", "oi"));
  c.receberWebhook(msg("1", "tudo bem?"));
  assert.equal(c.conversasPara("sup").length, 1);
});

test("distribui para o menos carregado e respeita habilidade", () => {
  const { c } = montar();
  c.receberWebhook(msg("1", "preço"));
  c.receberWebhook(msg("2", "preço"));
  const donos = c.conversasPara("sup").map((x) => x.atendente).sort();
  assert.deepEqual(donos, ["ana", "bia"]);
  c.receberWebhook(msg("3", "o app deu erro"));
  const suporte = c.conversasPara("sup").find((x) => x.fila === "suporte");
  assert.equal(suporte.atendente, "ana", "só Ana atende suporte");
});

test("respeita a capacidade e deixa o excedente na fila", () => {
  const { c } = montar();
  for (const t of ["1", "2", "3", "4", "5"]) c.receberWebhook(msg(t, "preço"));
  assert.equal(c.metricas().emAtendimento, 4);
  assert.equal(c.metricas().emFila, 1);
});

test("encerrar libera vaga e puxa a próxima da fila", () => {
  const { c } = montar();
  for (const t of ["1", "2", "3", "4", "5"]) c.receberWebhook(msg(t, "preço"));
  const aberta = c.conversasPara("ana")[0];
  c.encerrar(aberta.id, "ana");
  assert.equal(c.metricas().emFila, 0);
});

test("prioridade passa à frente na fila", () => {
  const { c } = montar();
  c.definirStatus("ana", "pausa");
  c.definirStatus("bia", "pausa");
  c.receberWebhook(msg("1", "preço"));
  c.receberWebhook(msg("2", "quero cancelar, é urgente, preço"));
  c.definirStatus("ana", "online");
  const a = c.conversasPara("ana").find((x) => x.estado === "aberta");
  assert.equal(a.telefone, "2");
});

test("duas pessoas não assumem a mesma conversa", () => {
  const { c } = montar();
  c.definirStatus("ana", "pausa");
  c.definirStatus("bia", "pausa");
  c.receberWebhook(msg("1", "preço"));
  const id = primeira(c, "sup").id;
  c.assumir(id, "ana");
  assert.throws(() => c.assumir(id, "bia"), (e: ErroCentral) => e.codigo === "ja_atribuida");
});

test("atendente sem a fila não assume e não responde conversa alheia", () => {
  const { c } = montar();
  c.definirStatus("ana", "pausa");
  c.receberWebhook(msg("1", "o app deu erro"));
  const id = primeira(c, "sup").id;
  assert.throws(() => c.assumir(id, "bia"), (e: ErroCentral) => e.codigo === "fila_proibida");
  c.assumir(id, "ana");
  assert.throws(() => c.responder(id, "bia", "oi"), (e: ErroCentral) => e.codigo === "nao_e_dono");
  c.responder(id, "sup", "Supervisão assumindo");
});

test("sair do ar devolve as conversas; pausa mantém", () => {
  const { c } = montar();
  c.receberWebhook(msg("1", "o app deu erro"));
  c.definirStatus("ana", "pausa");
  assert.equal(primeira(c, "sup").atendente, "ana");
  c.definirStatus("ana", "offline");
  assert.equal(primeira(c, "sup").estado, "fila");
});

test("transferência troca de fila e redistribui", () => {
  const { c } = montar();
  c.receberWebhook(msg("1", "o app deu erro"));
  const id = primeira(c, "sup").id;
  c.transferir(id, "ana", "vendas");
  const v = c.detalhe(id);
  assert.equal(v.fila, "vendas");
  assert.equal(v.atendente, "bia");
});

test("fora da janela de 24 horas não responde livremente", () => {
  const { c, avancar } = montar();
  c.receberWebhook(msg("1", "preço"));
  const { id, atendente } = primeira(c, "sup");
  avancar(JANELA_24H + 1);
  assert.throws(() => c.responder(id, atendente, "oi"), (e: ErroCentral) => e.codigo === "janela_expirada");
});

test("SLA estoura uma vez e sobe a prioridade", () => {
  const { c, avancar } = montar();
  c.receberWebhook(msg("1", "preço"));
  avancar(SLA_PRIMEIRA_RESPOSTA + 1);
  assert.equal(c.verificarSla(), 1);
  assert.equal(c.verificarSla(), 0);
  assert.equal(primeira(c, "sup").prioridade, 1);
  assert.equal(c.metricas().slaCumprido, 0);
});

test("resposta sai pela caixa de saída e o status nunca regride", async () => {
  const { c, enviados } = montar();
  c.receberWebhook(msg("1", "preço"));
  const { id, atendente } = primeira(c, "sup");
  c.responder(id, atendente, "Olá!");
  assert.equal(await c.despachar(), 1);
  assert.deepEqual(enviados, ["Olá!"]);
  c.receberWebhook(status("w1", "read"));
  c.receberWebhook(status("w1", "delivered"));
  assert.equal(c.detalhe(id).mensagens.at(-1).status, "lida");
});

test("falha no envio reagenda, mantém a ordem e desiste depois de cinco tentativas", async () => {
  const tentou: string[] = [];
  const { c, avancar } = montar({ enviar: async (_t, texto) => (tentou.push(texto), Promise.reject(new Error("fora do ar"))) });
  c.receberWebhook(msg("1", "preço"));
  const { id, atendente } = primeira(c, "sup");
  c.responder(id, atendente, "primeira");
  c.responder(id, atendente, "segunda");
  await c.despachar();
  assert.deepEqual(tentou, ["primeira"], "a segunda espera a primeira");
  for (let i = 0; i < 4; i++) {
    avancar(60_000);
    await c.despachar();
  }
  assert.equal(c.detalhe(id).mensagens.find((m: any) => m.texto === "primeira").status, "falhou");
});

test("eventos permitem retomar de onde parou", () => {
  const { c } = montar();
  c.receberWebhook(msg("1", "preço"));
  const todos = c.eventosDesde(0);
  assert.ok(todos.length >= 3);
  assert.equal(c.eventosDesde(todos.at(-1).seq).length, 0);
  assert.equal(c.eventosDesde(todos[0].seq).length, todos.length - 1);
});

test("webhook recusa assinatura errada e aceita a correta", async () => {
  assert.equal(assinaturaValida("x", "sha256=00", "s"), false);
  assert.equal(assinaturaValida("x", undefined, "s"), false);
  const { c } = montar();
  const s = criarServidor(c, "segredo").listen(0);
  const url = `http://localhost:${(s.address() as any).port}/webhook`;
  const corpo = JSON.stringify(msg("1", "preço"));
  try {
    assert.equal((await fetch(url, { method: "POST", body: corpo, headers: { "x-hub-signature-256": "sha256=abc" } })).status, 401);
    const boa = `sha256=${createHmac("sha256", "segredo").update(corpo).digest("hex")}`;
    assert.equal((await fetch(url, { method: "POST", body: corpo, headers: { "x-hub-signature-256": boa } })).status, 200);
    assert.equal(c.metricas().emAtendimento, 1);
  } finally {
    s.close();
  }
});
