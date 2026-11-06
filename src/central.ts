/**
 * Domínio da central de atendimento. Regras de fila, posse da conversa, SLA e
 * envio ficam aqui, sem HTTP. O relógio e o transporte são injetados.
 */
import { DatabaseSync } from "node:sqlite";

export const JANELA_24H = 24 * 3600_000;
export const SLA_PRIMEIRA_RESPOSTA = 5 * 60_000;
const ORDEM_STATUS: Record<string, number> = { pendente: 0, enviada: 1, entregue: 2, lida: 3, falhou: 4 };

export class ErroCentral extends Error {
  readonly codigo: string;
  readonly status: number;
  constructor(codigo: string, mensagem: string, status = 409) {
    super(mensagem);
    this.codigo = codigo;
    this.status = status;
  }
}

export interface Transporte {
  enviar(telefone: string, texto: string): Promise<{ id: string }>;
}

export type Fila = "vendas" | "suporte" | "financeiro";

export interface Atendente {
  id: string;
  nome: string;
  papel: "atendente" | "supervisor";
  filas: Fila[];
  capacidade: number;
  status: "online" | "pausa" | "offline";
}

/** Triagem por palavras-chave. Em produção, este é o ponto de encaixe de um classificador. */
export function triar(texto: string): { fila: Fila; prioridade: number } {
  const t = texto.toLowerCase();
  const urgente = /urgente|procon|cancelar|absurdo|reclama/.test(t) ? 1 : 0;
  if (/boleto|fatura|pagamento|cobran|reembolso|nota fiscal|pix/.test(t)) return { fila: "financeiro", prioridade: urgente };
  if (/erro|problema|não funciona|nao funciona|defeito|quebr|ajuda|suporte|cancelar/.test(t)) return { fila: "suporte", prioridade: urgente };
  return { fila: "vendas", prioridade: urgente };
}

export function abrirBanco(caminho = ":memory:"): DatabaseSync {
  const db = new DatabaseSync(caminho);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS atendentes (id TEXT PRIMARY KEY, nome TEXT NOT NULL, papel TEXT NOT NULL, filas TEXT NOT NULL, capacidade INTEGER NOT NULL, status TEXT NOT NULL, ultima_atribuicao INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS conversas (id INTEGER PRIMARY KEY, telefone TEXT NOT NULL, nome TEXT NOT NULL, fila TEXT NOT NULL, prioridade INTEGER NOT NULL DEFAULT 0, estado TEXT NOT NULL, atendente TEXT REFERENCES atendentes(id),
      criada INTEGER NOT NULL, atribuida INTEGER, primeira_resposta INTEGER, encerrada INTEGER, ultima_cliente INTEGER NOT NULL, sla_estourado INTEGER NOT NULL DEFAULT 0);
    CREATE UNIQUE INDEX IF NOT EXISTS uma_ativa_por_telefone ON conversas(telefone) WHERE estado <> 'encerrada';
    CREATE INDEX IF NOT EXISTS conversas_fila ON conversas(estado, fila, prioridade DESC, criada);
    CREATE TABLE IF NOT EXISTS mensagens (id INTEGER PRIMARY KEY, conversa INTEGER NOT NULL REFERENCES conversas(id), externo TEXT UNIQUE, tipo TEXT NOT NULL, autor TEXT, texto TEXT NOT NULL, status TEXT NOT NULL, tentativas INTEGER NOT NULL DEFAULT 0, proxima INTEGER NOT NULL DEFAULT 0, criada INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS mensagens_saida ON mensagens(status, proxima) WHERE status = 'pendente';
    CREATE TABLE IF NOT EXISTS eventos (seq INTEGER PRIMARY KEY AUTOINCREMENT, tipo TEXT NOT NULL, conversa INTEGER, ator TEXT, dados TEXT, quando INTEGER NOT NULL);
  `);
  return db;
}

export class Central {
  private readonly db: DatabaseSync;
  private readonly transporte: Transporte;
  private readonly agora: () => number;
  private ouvintes = new Set<(e: any) => void>();

  constructor(db: DatabaseSync, transporte: Transporte, agora: () => number = Date.now) {
    this.db = db;
    this.transporte = transporte;
    this.agora = agora;
  }

  ouvir(f: (e: any) => void): () => void {
    this.ouvintes.add(f);
    return () => this.ouvintes.delete(f);
  }

  private tx<T>(f: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = f();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  private registrar(tipo: string, conversa: number | null, ator: string | null, dados: object = {}): void {
    const quando = this.agora();
    const r = this.db.prepare("INSERT INTO eventos (tipo, conversa, ator, dados, quando) VALUES (?,?,?,?,?)").run(tipo, conversa, ator, JSON.stringify(dados), quando);
    const e = { seq: Number(r.lastInsertRowid), tipo, conversa, ator, dados, quando };
    queueMicrotask(() => this.ouvintes.forEach((f) => f(e)));
  }

  /** Eventos depois de um número de sequência: é o que permite ao navegador reconectar sem perder nada. */
  eventosDesde(seq: number) {
    return (this.db.prepare("SELECT * FROM eventos WHERE seq > ? ORDER BY seq LIMIT 500").all(seq) as any[]).map((e) => ({ ...e, dados: JSON.parse(e.dados) }));
  }

  cadastrar(a: Omit<Atendente, "status"> & { status?: Atendente["status"] }): void {
    this.db.prepare("INSERT OR REPLACE INTO atendentes (id, nome, papel, filas, capacidade, status) VALUES (?,?,?,?,?,?)").run(a.id, a.nome, a.papel, JSON.stringify(a.filas), a.capacidade, a.status ?? "offline");
  }

  private atendente(id: string): Atendente & { carga: number } {
    const a = this.db.prepare("SELECT a.*, (SELECT count(*) FROM conversas c WHERE c.atendente = a.id AND c.estado = 'aberta') carga FROM atendentes a WHERE id = ?").get(id) as any;
    if (!a) throw new ErroCentral("atendente_inexistente", "Atendente não encontrado", 404);
    return { ...a, filas: JSON.parse(a.filas) };
  }

  atendentes() {
    return (this.db.prepare("SELECT id FROM atendentes ORDER BY nome").all() as { id: string }[]).map((x) => this.atendente(x.id));
  }

  /** Recebe o formato de webhook da WhatsApp Cloud API. Reentregas são ignoradas pelo id externo. */
  receberWebhook(corpo: any): void {
    for (const entrada of corpo?.entry ?? []) {
      for (const mudanca of entrada?.changes ?? []) {
        const v = mudanca?.value ?? {};
        const nomes = new Map<string, string>((v.contacts ?? []).map((c: any) => [c.wa_id, c.profile?.name ?? c.wa_id]));
        for (const m of v.messages ?? []) {
          const texto = m.type === "text" ? String(m.text?.body ?? "") : `[${m.type} recebido]`;
          this.receberMensagem(m.id, m.from, nomes.get(m.from) ?? m.from, texto);
        }
        for (const s of v.statuses ?? []) this.atualizarStatus(s.id, s.status === "sent" ? "enviada" : s.status === "delivered" ? "entregue" : s.status === "read" ? "lida" : "falhou");
      }
    }
    this.distribuir();
  }

  private receberMensagem(externo: string, telefone: string, nome: string, texto: string): void {
    this.tx(() => {
      if (this.db.prepare("SELECT 1 FROM mensagens WHERE externo = ?").get(externo)) return;
      const agora = this.agora();
      let c = this.db.prepare("SELECT id FROM conversas WHERE telefone = ? AND estado <> 'encerrada'").get(telefone) as { id: number } | undefined;
      if (!c) {
        const { fila, prioridade } = triar(texto);
        const r = this.db.prepare("INSERT INTO conversas (telefone, nome, fila, prioridade, estado, criada, ultima_cliente) VALUES (?,?,?,?,'fila',?,?)").run(telefone, nome, fila, prioridade, agora, agora);
        c = { id: Number(r.lastInsertRowid) };
        this.registrar("conversa_criada", c.id, null, { fila, prioridade });
      }
      this.db.prepare("UPDATE conversas SET ultima_cliente = ? WHERE id = ?").run(agora, c.id);
      this.db.prepare("INSERT INTO mensagens (conversa, externo, tipo, texto, status, criada) VALUES (?,?,'cliente',?,'recebida',?)").run(c.id, externo, texto, agora);
      this.registrar("mensagem", c.id, null);
    });
  }

  /** Status só avança: um "entregue" atrasado não pode desfazer um "lida". */
  private atualizarStatus(externo: string, status: string): void {
    this.tx(() => {
      const m = this.db.prepare("SELECT id, conversa, status FROM mensagens WHERE externo = ?").get(externo) as any;
      if (!m || ORDEM_STATUS[status]! <= ORDEM_STATUS[m.status]!) return;
      this.db.prepare("UPDATE mensagens SET status = ? WHERE id = ?").run(status, m.id);
      this.registrar("status", m.conversa, null, { mensagem: m.id, status });
    });
  }

  /**
   * Distribui a fila: prioridade, depois antiguidade. O escolhido é o atendente
   * habilitado com menor carga; no empate, quem recebeu há mais tempo.
   */
  distribuir(): number {
    return this.tx(() => {
      const pendentes = this.db.prepare("SELECT id, fila FROM conversas WHERE estado = 'fila' ORDER BY prioridade DESC, criada, id").all() as { id: number; fila: Fila }[];
      let atribuidas = 0;
      for (const c of pendentes) {
        const livres = this.atendentes()
          .filter((a) => a.status === "online" && a.filas.includes(c.fila) && a.carga < a.capacidade)
          .sort((x: any, y: any) => x.carga - y.carga || x.ultima_atribuicao - y.ultima_atribuicao);
        const a = livres[0];
        if (!a) continue;
        this.atribuir(c.id, a.id, null);
        atribuidas++;
      }
      return atribuidas;
    });
  }

  private atribuir(conversa: number, atendente: string, ator: string | null): void {
    const agora = this.agora();
    // A condição estado = 'fila' faz a posse ser exclusiva: só um consegue.
    const r = this.db.prepare("UPDATE conversas SET estado = 'aberta', atendente = ?, atribuida = coalesce(atribuida, ?) WHERE id = ? AND estado = 'fila'").run(atendente, agora, conversa);
    if (r.changes === 0) throw new ErroCentral("ja_atribuida", "Outra pessoa já assumiu esta conversa");
    this.db.prepare("UPDATE atendentes SET ultima_atribuicao = ? WHERE id = ?").run(agora, atendente);
    this.registrar("atribuida", conversa, ator, { atendente });
  }

  assumir(conversa: number, atendente: string): void {
    this.tx(() => {
      const a = this.atendente(atendente);
      const c = this.conversa(conversa);
      if (a.papel !== "supervisor" && !a.filas.includes(c.fila)) throw new ErroCentral("fila_proibida", "Você não atende esta fila", 403);
      this.atribuir(conversa, atendente, atendente);
    });
  }

  private conversa(id: number): any {
    const c = this.db.prepare("SELECT * FROM conversas WHERE id = ?").get(id);
    if (!c) throw new ErroCentral("conversa_inexistente", "Conversa não encontrada", 404);
    return c;
  }

  private exigirDono(c: any, ator: string): void {
    if (c.atendente !== ator && this.atendente(ator).papel !== "supervisor") throw new ErroCentral("nao_e_dono", "Esta conversa está com outra pessoa", 403);
  }

  /** Grava na caixa de saída na mesma transação da regra. O envio real acontece em `despachar`. */
  responder(conversa: number, ator: string, texto: string): void {
    const limpo = texto.trim();
    if (!limpo) throw new ErroCentral("texto_vazio", "Escreva uma mensagem", 422);
    this.tx(() => {
      const c = this.conversa(conversa);
      if (c.estado !== "aberta") throw new ErroCentral("conversa_fechada", "Assuma a conversa antes de responder");
      this.exigirDono(c, ator);
      const agora = this.agora();
      // Regra da plataforma: passadas 24 horas da última mensagem do cliente, só modelo aprovado.
      if (agora - c.ultima_cliente > JANELA_24H) throw new ErroCentral("janela_expirada", "Janela de 24 horas encerrada. Use um modelo aprovado");
      this.db.prepare("INSERT INTO mensagens (conversa, tipo, autor, texto, status, criada) VALUES (?, 'atendente', ?, ?, 'pendente', ?)").run(conversa, ator, limpo, agora);
      if (c.primeira_resposta === null) this.db.prepare("UPDATE conversas SET primeira_resposta = ? WHERE id = ?").run(agora, conversa);
      this.registrar("mensagem", conversa, ator);
    });
  }

  nota(conversa: number, ator: string, texto: string): void {
    this.tx(() => {
      this.conversa(conversa);
      this.db.prepare("INSERT INTO mensagens (conversa, tipo, autor, texto, status, criada) VALUES (?, 'nota', ?, ?, 'interna', ?)").run(conversa, ator, texto.trim(), this.agora());
      this.registrar("mensagem", conversa, ator);
    });
  }

  transferir(conversa: number, ator: string, fila: Fila): void {
    this.tx(() => {
      const c = this.conversa(conversa);
      this.exigirDono(c, ator);
      this.db.prepare("UPDATE conversas SET estado = 'fila', atendente = NULL, fila = ? WHERE id = ?").run(fila, conversa);
      this.registrar("transferida", conversa, ator, { de: c.fila, para: fila });
    });
    this.distribuir();
  }

  encerrar(conversa: number, ator: string): void {
    this.tx(() => {
      const c = this.conversa(conversa);
      this.exigirDono(c, ator);
      this.db.prepare("UPDATE conversas SET estado = 'encerrada', encerrada = ? WHERE id = ?").run(this.agora(), conversa);
      this.registrar("encerrada", conversa, ator);
    });
    this.distribuir();
  }

  /** Quem sai do ar devolve as conversas à fila, para ninguém ficar sem resposta. Pausa mantém as atuais. */
  definirStatus(id: string, status: Atendente["status"]): void {
    this.tx(() => {
      this.atendente(id);
      this.db.prepare("UPDATE atendentes SET status = ? WHERE id = ?").run(status, id);
      if (status === "offline") {
        const r = this.db.prepare("UPDATE conversas SET estado = 'fila', atendente = NULL WHERE atendente = ? AND estado = 'aberta' RETURNING id").all(id) as { id: number }[];
        for (const c of r) this.registrar("devolvida", c.id, id);
      }
      this.registrar("presenca", null, id, { status });
    });
    this.distribuir();
  }

  /** Marca estouro de SLA uma única vez e sobe a prioridade da conversa. */
  verificarSla(): number {
    const n = this.tx(() => {
      const limite = this.agora() - SLA_PRIMEIRA_RESPOSTA;
      const r = this.db.prepare("UPDATE conversas SET sla_estourado = 1, prioridade = prioridade + 1 WHERE primeira_resposta IS NULL AND sla_estourado = 0 AND estado <> 'encerrada' AND criada <= ? RETURNING id").all(limite) as { id: number }[];
      for (const c of r) this.registrar("sla_estourado", c.id, null);
      return r.length;
    });
    if (n) this.distribuir();
    return n;
  }

  /**
   * Esvazia a caixa de saída. Falha temporária reagenda com espera exponencial;
   * depois de cinco tentativas a mensagem fica como falha, visível para o atendente.
   */
  async despachar(): Promise<number> {
    const fila = this.db.prepare("SELECT m.id, m.texto, m.tentativas, m.conversa, c.telefone FROM mensagens m JOIN conversas c ON c.id = m.conversa WHERE m.status = 'pendente' AND m.proxima <= ? ORDER BY m.id LIMIT 50").all(this.agora()) as any[];
    const bloqueadas = new Set<number>();
    let enviadas = 0;
    for (const m of fila) {
      if (bloqueadas.has(m.conversa)) continue; // preserva a ordem dentro de cada conversa
      try {
        const { id } = await this.transporte.enviar(m.telefone, m.texto);
        this.tx(() => {
          this.db.prepare("UPDATE mensagens SET status = 'enviada', externo = ? WHERE id = ?").run(id, m.id);
          this.registrar("status", m.conversa, null, { mensagem: m.id, status: "enviada" });
        });
        enviadas++;
      } catch {
        bloqueadas.add(m.conversa);
        const tentativas = m.tentativas + 1;
        const desistiu = tentativas >= 5;
        this.tx(() => {
          this.db.prepare("UPDATE mensagens SET tentativas = ?, proxima = ?, status = ? WHERE id = ?").run(tentativas, this.agora() + 1000 * 2 ** tentativas, desistiu ? "falhou" : "pendente", m.id);
          if (desistiu) this.registrar("status", m.conversa, null, { mensagem: m.id, status: "falhou" });
        });
      }
    }
    return enviadas;
  }

  conversasPara(ator: string) {
    const a = this.atendente(ator);
    const todas = this.db
      .prepare(
        `SELECT c.*, (SELECT texto FROM mensagens m WHERE m.conversa = c.id AND m.tipo <> 'nota' ORDER BY m.id DESC LIMIT 1) ultima,
         (SELECT tipo FROM mensagens m WHERE m.conversa = c.id AND m.tipo <> 'nota' ORDER BY m.id DESC LIMIT 1) ultimo_tipo
         FROM conversas c WHERE c.estado <> 'encerrada' ORDER BY c.prioridade DESC, c.ultima_cliente DESC`,
      )
      .all() as any[];
    return a.papel === "supervisor" ? todas : todas.filter((c) => c.atendente === ator || (c.estado === "fila" && a.filas.includes(c.fila)));
  }

  detalhe(id: number) {
    return { ...this.conversa(id), mensagens: this.db.prepare("SELECT * FROM mensagens WHERE conversa = ? ORDER BY id").all(id) };
  }

  metricas() {
    const agora = this.agora();
    const fila = this.db.prepare("SELECT fila, count(*) n FROM conversas WHERE estado = 'fila' GROUP BY fila").all() as any[];
    const respostas = (this.db.prepare("SELECT primeira_resposta - criada d FROM conversas WHERE primeira_resposta IS NOT NULL ORDER BY d").all() as { d: number }[]).map((x) => x.d);
    const pct = (p: number) => (respostas.length ? respostas[Math.min(respostas.length - 1, Math.floor(respostas.length * p))]! : 0);
    const total = (this.db.prepare("SELECT count(*) n, sum(sla_estourado) e, sum(estado = 'encerrada') f, sum(estado = 'aberta') a FROM conversas").get() as any);
    const esperaMaior = (this.db.prepare("SELECT min(criada) m FROM conversas WHERE estado = 'fila'").get() as any).m;
    return {
      fila: Object.fromEntries(fila.map((f) => [f.fila, f.n])),
      emFila: fila.reduce((t, f) => t + f.n, 0),
      emAtendimento: total.a ?? 0,
      encerradas: total.f ?? 0,
      slaCumprido: total.n ? Math.round(((total.n - (total.e ?? 0)) / total.n) * 100) : 100,
      primeiraRespostaP50: pct(0.5),
      primeiraRespostaP90: pct(0.9),
      maiorEspera: esperaMaior ? agora - esperaMaior : 0,
    };
  }
}
