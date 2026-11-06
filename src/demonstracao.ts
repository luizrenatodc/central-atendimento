/**
 * Clientes fictícios para a demonstração. Eles falam com a central pelo mesmo
 * caminho de produção: um POST assinado em /webhook, no formato da Cloud API.
 */
import { createHmac } from "node:crypto";
import type { Central } from "./central.ts";

const EQUIPE = [
  { id: "ana", nome: "Ana Prado", papel: "atendente", filas: ["vendas", "suporte"], capacidade: 3 },
  { id: "bruno", nome: "Bruno Lima", papel: "atendente", filas: ["suporte"], capacidade: 3 },
  { id: "carla", nome: "Carla Souza", papel: "atendente", filas: ["financeiro", "vendas"], capacidade: 2 },
  { id: "dora", nome: "Dora Reis", papel: "supervisor", filas: ["vendas", "suporte", "financeiro"], capacidade: 2 },
] as const;

const ROTEIROS: [string, string, string[]][] = [
  ["5517990000001", "Marcos Vieira", ["Oi, queria saber o preço do plano anual", "Tem desconto para pagar à vista?"]],
  ["5517990000002", "Patrícia Nunes", ["Meu boleto veio com valor errado", "Preciso disso hoje, por favor"]],
  ["5517990000003", "Rafael Duarte", ["O aplicativo não funciona desde ontem", "Já reinstalei e continua com erro"]],
  ["5517990000004", "Juliana Melo", ["É urgente, quero cancelar a assinatura", "Ninguém me respondeu ainda"]],
  ["5517990000005", "Tiago Rocha", ["Bom dia! Vocês atendem empresas?", "Somos 40 pessoas"]],
  ["5517990000006", "Helena Castro", ["Pedi reembolso faz uma semana", "Foi no pix"]],
  ["5517990000007", "Otávio Paes", ["Tive um problema com o login", "Diz que a senha expirou"]],
  ["5517990000008", "Sônia Freitas", ["Quero contratar mais usuários", "Como funciona?"]],
  ["5517990000009", "Igor Tavares", ["Essa cobrança aqui eu não reconheço", "Veio duplicada"]],
];

export function iniciarDemonstracao(central: Central, porta: number, segredo: string) {
  for (const a of EQUIPE) central.cadastrar({ ...a, filas: [...a.filas], status: "online" });

  let n = 0;
  const postar = (value: object) => {
    const corpo = JSON.stringify({ entry: [{ changes: [{ value }] }] });
    const assinatura = `sha256=${createHmac("sha256", segredo).update(corpo).digest("hex")}`;
    return fetch(`http://localhost:${porta}/webhook`, { method: "POST", body: corpo, headers: { "x-hub-signature-256": assinatura } }).catch(() => {});
  };
  const falar = (telefone: string, nome: string, texto: string) =>
    postar({ contacts: [{ wa_id: telefone, profile: { name: nome } }], messages: [{ id: `in.${Date.now()}.${n++}`, from: telefone, type: "text", text: { body: texto } }] });

  ROTEIROS.forEach(([tel, nome, falas], i) => {
    setTimeout(() => void falar(tel, nome, falas[0]!), 500 + i * 900);
    setTimeout(() => void falar(tel, nome, falas[1]!), 2600 + i * 900);
  });

  // Confirmações da plataforma, chegando como no mundo real: depois do envio.
  return (_telefone: string, _texto: string, id: string) => {
    setTimeout(() => void postar({ statuses: [{ id, status: "delivered" }] }), 500);
    setTimeout(() => void postar({ statuses: [{ id, status: "read" }] }), 1400);
  };
}
