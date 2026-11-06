const $ = (id) => document.getElementById(id);
const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const hora = (ms) => new Date(ms).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
const dur = (ms) => (ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60000)}min`);
const CORES = ["#0b7a63", "#7b4bb3", "#b5573a", "#2a6fb0", "#a06a00", "#46793a"];
const RESPOSTAS = ["Olá! Já estou vendo seu caso.", "Pode me passar o CPF do titular?", "Resolvido por aqui. Posso ajudar em algo mais?"];

const estado = { eu: new URLSearchParams(location.search).get("a") ?? "ana", atual: null, aba: "minhas", modoNota: false, erro: "" };

async function api(caminho, corpo) {
  const r = await fetch(`/api/${caminho}`, { method: corpo ? "POST" : "GET", body: corpo ? JSON.stringify(corpo) : undefined, headers: { "x-atendente": estado.eu } });
  const d = await r.json();
  if (!r.ok) throw new Error(d.mensagem);
  return d;
}

async function acao(caminho, corpo = {}) {
  estado.erro = "";
  try {
    await api(caminho, corpo);
  } catch (e) {
    estado.erro = e.message;
  }
  await atualizar();
}

const avatar = (c) => `<span class="ava" style="background:${CORES[c.id % CORES.length]}">${esc(c.nome[0])}</span>`;

function desenharLista(conversas) {
  const minhas = conversas.filter((c) => c.atendente === estado.eu);
  const fila = conversas.filter((c) => c.estado === "fila");
  const abas = [["minhas", `Minhas ${minhas.length}`], ["fila", `Fila ${fila.length}`], ["todas", `Todas ${conversas.length}`]];
  $("abas").innerHTML = abas.map(([id, t]) => `<button role="tab" aria-selected="${estado.aba === id}" data-aba="${id}">${t}</button>`).join("");
  const lista = estado.aba === "minhas" ? minhas : estado.aba === "fila" ? fila : conversas;
  $("conversas").innerHTML = lista.map((c) => `<button class="linha" data-id="${c.id}" aria-current="${c.id === estado.atual}">${avatar(c)}
    <div><strong>${esc(c.nome)}</strong><small>${esc(c.ultima)}</small></div>
    <div><span class="selo ${c.estado === "fila" ? "fila" : ""}">${c.estado === "fila" ? "na fila" : esc(c.fila)}</span>${c.prioridade > 0 ? '<span class="selo urgente">prioridade</span>' : ""}</div></button>`).join("") || '<p style="padding:16px;color:var(--mudo)">Nada por aqui.</p>';
  document.querySelector(".corpo").classList.toggle("sem-conversa", !estado.atual);
}

function vistos(m) {
  if (m.status === "falhou") return '<span class="vistos falhou">falhou</span>';
  if (m.status === "pendente") return '<span class="vistos">…</span>';
  return `<span class="vistos ${m.status === "lida" ? "lida" : ""}">${m.status === "enviada" ? "✓" : "✓✓"}</span>`;
}

function bolha(m, equipe) {
  const meta = `<span class="meta">${hora(m.criada)}${m.tipo === "atendente" ? vistos(m) : ""}</span>`;
  const nome = equipe.find((a) => a.id === m.autor)?.nome.split(" ")[0] ?? "";
  if (m.tipo === "nota") return `<div class="bolha nota"><em>Nota interna · ${esc(nome)}</em>${esc(m.texto)}</div>`;
  if (m.tipo === "atendente") return `<div class="bolha eu2"><span class="autor">${esc(nome)}</span>${esc(m.texto)}${meta}</div>`;
  return `<div class="bolha">${esc(m.texto)}${meta}</div>`;
}

let rascunho = "";
function desenharConversa(c, equipe) {
  if (!c) return void ($("conversa").innerHTML = '<div class="vazio">Selecione uma conversa</div>');
  const area = document.querySelector("#texto");
  if (area) rascunho = area.value;
  // Precisa ser lido antes de trocar o HTML: depois disso o campo antigo já perdeu o foco.
  const tinhaFoco = area === document.activeElement;
  const cursor = area?.selectionStart ?? rascunho.length;
  const rolagem = document.querySelector(".msgs");
  const noFim = !rolagem || rolagem.scrollHeight - rolagem.scrollTop - rolagem.clientHeight < 60;
  const meu = c.atendente === estado.eu || equipe.find((a) => a.id === estado.eu)?.papel === "supervisor";
  const dono = equipe.find((a) => a.id === c.atendente)?.nome ?? "ninguém";
  const rodape = c.estado === "fila"
    ? `<div class="assumir"><button class="primario" id="assumir">Assumir conversa</button></div>`
    : meu ? `<div class="atalhos">${RESPOSTAS.map((r) => `<button data-r="${esc(r)}">${esc(r)}</button>`).join("")}</div>
      <form class="escrever ${estado.modoNota ? "nota" : ""}" id="form"><button type="button" class="secundario ${estado.modoNota ? "ativo" : ""}" id="nota">Nota</button><textarea id="texto" rows="1" aria-label="Mensagem" placeholder="${estado.modoNota ? "Só a equipe vê esta nota" : "Digite uma mensagem"}"></textarea><button class="primario">Enviar</button></form>`
    : `<div class="assumir" style="color:var(--mudo)">Em atendimento com ${esc(dono)}</div>`;
  $("conversa").innerHTML = `<div class="topo">${avatar(c)}<div><strong>${esc(c.nome)}</strong><small>+${esc(c.telefone)} · ${esc(c.fila)} · com ${esc(dono)}</small></div></div>
    <div class="msgs">${c.mensagens.map((m) => bolha(m, equipe)).join("")}</div>${estado.erro ? `<div class="erro" role="alert">${esc(estado.erro)}</div>` : ""}${rodape}`;
  const novo = document.querySelector("#texto");
  if (novo) {
    novo.value = rascunho;
    if (tinhaFoco || !area) {
      novo.focus();
      novo.setSelectionRange(cursor, cursor);
    }
  }
  const m = document.querySelector(".msgs");
  if (noFim) m.scrollTop = m.scrollHeight;
}

function desenharPainel(c, equipe) {
  const cliente = c ? `<h2>Conversa</h2><div class="par"><span>Fila</span>${esc(c.fila)}</div><div class="par"><span>Aberta às</span>${hora(c.criada)}</div>
    <div class="par"><span>1ª resposta</span>${c.primeira_resposta ? dur(c.primeira_resposta - c.criada) : "aguardando"}</div><div class="par"><span>SLA</span>${c.sla_estourado ? '<b style="color:var(--alerta)">estourado</b>' : "no prazo"}</div>
    ${c.estado === "aberta" ? `<h2>Ações</h2><div class="acoes"><select id="destino" aria-label="Transferir para"><option value="">Transferir para...</option>${["vendas", "suporte", "financeiro"].filter((f) => f !== c.fila).map((f) => `<option>${f}</option>`).join("")}</select><button class="secundario" id="encerrar">Encerrar conversa</button></div>` : ""}` : "";
  $("painel").innerHTML = `${cliente}<h2>Equipe</h2>${equipe.map((a) => `<div class="equipe"><i class="ponto ${a.status}"></i><span>${esc(a.nome)}</span><small>${a.carga}/${a.capacidade}</small><div class="barra-carga"><i style="width:${(a.carga / a.capacidade) * 100}%"></i></div></div>`).join("")}`;
}

function desenharNumeros(m) {
  const itens = [["Na fila", m.emFila, m.emFila > 3], ["Em atendimento", m.emAtendimento], ["Maior espera", m.maiorEspera ? dur(m.maiorEspera) : "0s", m.maiorEspera > 180000], ["1ª resposta p50", dur(m.primeiraRespostaP50)], ["1ª resposta p90", dur(m.primeiraRespostaP90)], ["SLA cumprido", `${m.slaCumprido}%`, m.slaCumprido < 80], ["Encerradas", m.encerradas]];
  $("numeros").innerHTML = itens.map(([t, v, ruim]) => `<div class="${ruim ? "ruim" : ""}"><b>${v}</b>${t}</div>`).join("");
}

let ocupado = false;
let denovo = false;
async function atualizar() {
  if (ocupado) return void (denovo = true);
  ocupado = true;
  try {
    const [conversas, equipe, metricas, atual] = await Promise.all([api("conversas"), api("atendentes"), api("metricas"), estado.atual ? api(`conversas/${estado.atual}`) : null]);
    desenharLista(conversas);
    desenharNumeros(metricas);
    desenharConversa(atual, equipe);
    desenharPainel(atual, equipe);
    $("presenca").value = equipe.find((a) => a.id === estado.eu)?.status ?? "offline";
    if ($("quem").options.length === 0) {
      $("quem").innerHTML = equipe.map((a) => `<option value="${a.id}">${esc(a.nome)}${a.papel === "supervisor" ? " (supervisão)" : ""}</option>`).join("");
      $("quem").value = estado.eu;
    }
  } finally {
    ocupado = false;
    if (denovo) {
      denovo = false;
      atualizar();
    }
  }
}

document.addEventListener("click", (e) => {
  const t = e.target.closest("button");
  if (!t) return;
  if (t.dataset.aba) ((estado.aba = t.dataset.aba), atualizar());
  else if (t.dataset.id) ((estado.atual = +t.dataset.id), (rascunho = ""), (estado.erro = ""), atualizar());
  else if (t.id === "assumir") acao(`conversas/${estado.atual}/assumir`);
  else if (t.id === "encerrar") (acao(`conversas/${estado.atual}/encerrar`), (estado.atual = null));
  else if (t.id === "nota") ((estado.modoNota = !estado.modoNota), atualizar());
  else if (t.dataset.r) {
    $("texto").value = t.dataset.r;
    $("texto").focus();
  }
});
document.addEventListener("submit", (e) => {
  e.preventDefault();
  const texto = $("texto").value;
  if (!texto.trim()) return;
  $("texto").value = "";
  rascunho = "";
  acao(`conversas/${estado.atual}/${estado.modoNota ? "nota" : "responder"}`, { texto });
});
document.addEventListener("keydown", (e) => {
  if (e.target.id === "texto" && e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("form").requestSubmit();
  }
});
document.addEventListener("change", (e) => {
  if (e.target.id === "destino" && e.target.value) (acao(`conversas/${estado.atual}/transferir`, { fila: e.target.value }), (estado.atual = null));
  if (e.target.id === "presenca") acao("status", { status: e.target.value });
  if (e.target.id === "quem") location.search = `?a=${e.target.value}`;
});

let espera = 0;
new EventSource("/api/eventos").onmessage = () => {
  clearTimeout(espera);
  espera = setTimeout(atualizar, 80);
};
setInterval(atualizar, 5000);
atualizar();
