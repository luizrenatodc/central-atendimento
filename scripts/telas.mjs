// Sobe a central, atende de verdade pela interface, salva telas e quadros do GIF.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
const require = createRequire("C:/Users/Nitro V15/projetos/github-perfil/");
const puppeteer = require("puppeteer-core");
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const clicar = (p, s) => p.evaluate((x) => document.querySelector(x).click(), s);
const Q = "../_pacotes/v3/quadros";
fs.rmSync(Q, { recursive: true, force: true });
fs.mkdirSync(Q, { recursive: true });
const srv = spawn(process.execPath, ["src/servidor.ts"], { env: { ...process.env, PORTA: "3921" }, stdio: "ignore" });
await espera(900);
const b = await puppeteer.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: "new" });
const abrir = async (quem) => {
  const p = await b.newPage();
  p.on("pageerror", (e) => console.log("ERRO", e.message));
  await p.setViewport({ width: 1360, height: 800, deviceScaleFactor: 1 });
  await p.goto(`http://localhost:3921/?a=${quem}`);
  return p;
};
let n = 0;
const quadro = async (p, vezes = 1) => { for (let i = 0; i < vezes; i++) { await p.screenshot({ path: `${Q}/${String(n++).padStart(3, "0")}.png` }); await espera(120); } };
try {
  const ana = await abrir("ana");
  const bruno = await abrir("bruno");
  await ana.bringToFront();
  for (let i = 0; i < 16; i++) { await quadro(ana); await espera(280); }
  const abrirPrimeira = (p) => p.evaluate(() => document.querySelector(".linha")?.click());
  await abrirPrimeira(ana);
  await espera(400);
  await quadro(ana, 4);
  await clicar(ana, '[data-r]');
  await quadro(ana, 3);
  await ana.keyboard.press("Enter");
  for (let i = 0; i < 12; i++) { await quadro(ana); await espera(180); }
  await clicar(ana, '#nota');
  await espera(150);
  await ana.type("#texto", "Cliente recorrente, tratar com prioridade.", { delay: 8 });
  await quadro(ana, 3);
  await ana.keyboard.press("Enter");
  await espera(400);
  await clicar(ana, '#nota');
  await quadro(ana, 5);
  await espera(1200);
  await ana.setViewport({ width: 1360, height: 800, deviceScaleFactor: 1.25 });
  await espera(300);
  await ana.screenshot({ path: "docs/atendente.png" });

  await bruno.bringToFront();
  await abrirPrimeira(bruno);
  await espera(300);
  await bruno.type("#texto", "Consegue me enviar um print do erro?");
  await bruno.keyboard.press("Enter");
  await espera(1800);

  const dora = await abrir("dora");
  await dora.setViewport({ width: 1360, height: 800, deviceScaleFactor: 1.25 });
  await espera(500);
  await dora.evaluate(() => document.querySelector('[data-aba="todas"]').click());
  await espera(300);
  await dora.evaluate(() => [...document.querySelectorAll(".linha")].find((l) => l.textContent.includes("na fila"))?.click());
  await espera(600);
  await dora.screenshot({ path: "docs/supervisao.png" });
  console.log(await dora.evaluate(() => document.getElementById("numeros").innerText.replace(/\n/g, " ")));
} finally {
  await b.close();
  srv.kill();
}
console.log("quadros", n);
