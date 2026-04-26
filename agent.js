/**
 * Novooi Sparingsagent v2 — GitHub Actions Script
 *
 * Håndterer:
 *   - Lesing av CSV-filer og config
 *   - Historikk-management (last_week.json, portfolio_history.csv)
 *   - Kall til Cloudflare Worker
 *   - Lagring av oppdatert historikk (GitHub Actions committer tilbake)
 *
 * Miljøvariabler (GitHub Secrets):
 *   WORKER_URL    — URL til Cloudflare Worker
 *   AGENT_SECRET  — tilgangsnøkkel (valgfritt)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Konfigurasjon ────────────────────────────────────────────────────────────
const WORKER_URL = process.env.WORKER_URL;
const AGENT_SECRET = process.env.AGENT_SECRET || "";

if (!WORKER_URL) {
  console.error("❌ Mangler WORKER_URL miljøvariabel");
  process.exit(1);
}

const PATHS = {
  data: path.join(__dirname, "data"),
  history: path.join(__dirname, "data", "history"),
  dnbCsv: path.join(__dirname, "data", "dnb_transactions.csv"),
  nordnetCsv: path.join(__dirname, "data", "nordnet_portfolio.csv"),
  config: path.join(__dirname, "config.json"),
  lastWeek: path.join(__dirname, "data", "history", "last_week.json"),
  portfolioHistory: path.join(__dirname, "data", "history", "portfolio_history.csv"),
};

// ── Filhjelper ────────────────────────────────────────────────────────────────
function lesFilEllerNull(filsti, type = "text") {
  if (!fs.existsSync(filsti)) {
    console.warn(`⚠️  Fant ikke: ${filsti}`);
    return null;
  }
  const innhold = fs.readFileSync(filsti, "utf-8").trim();
  if (!innhold) {
    console.warn(`⚠️  Tom fil: ${filsti}`);
    return null;
  }
  if (type === "json") {
    try {
      return JSON.parse(innhold);
    } catch {
      console.warn(`⚠️  Ugyldig JSON i ${filsti}`);
      return null;
    }
  }
  console.log(`✅ Leste ${path.basename(filsti)} (${innhold.length} tegn)`);
  return innhold;
}

// ── Ukenummer ─────────────────────────────────────────────────────────────────
function getWeekLabel() {
  const nå = new Date();
  const startOfYear = new Date(nå.getFullYear(), 0, 1);
  const weekNumber = Math.ceil(
    ((nå - startOfYear) / 86400000 + startOfYear.getDay() + 1) / 7
  );
  return `Uke ${weekNumber} — ${nå.getFullYear()}`;
}

// ── Oppdater porteføljehistorikk CSV ─────────────────────────────────────────
function oppdaterPorteføljeHistorikk(analysisData) {
  const pf = analysisData?.portefølje;
  if (!pf?.total_verdi) return;

  // Parse beløp fra streng (f.eks. "18 740 kr" → 18740)
  const verdiBelop = parseInt(pf.total_verdi.replace(/[^0-9]/g, ""), 10);
  if (isNaN(verdiBelop)) return;

  const idag = new Date().toISOString().split("T")[0];
  const nyLinje = `${idag};${verdiBelop};${pf.total_verdi};${analysisData.uke || ""}`;

  if (!fs.existsSync(PATHS.portfolioHistory)) {
    fs.writeFileSync(PATHS.portfolioHistory, "dato;verdi_nok;verdi_tekst;uke\n", "utf-8");
    console.log("📄 Opprettet portfolio_history.csv");
  }

  fs.appendFileSync(PATHS.portfolioHistory, nyLinje + "\n", "utf-8");
  console.log(`✅ Porteføljehistorikk oppdatert: ${verdiBelop} kr`);
}

// ── Lagre denne uken som forrige uke til neste kjøring ────────────────────────
function lagreSomForrigeUke(analysisData) {
  // Vi lagrer en komprimert versjon — kun nøkkeltall for sammenligning
  const snapshot = {
    uke: analysisData.uke,
    dato: new Date().toISOString(),
    økonomi: {
      inntekt_perioden: analysisData.økonomi?.inntekt_perioden,
      utgifter_perioden: analysisData.økonomi?.utgifter_perioden,
      netto_perioden: analysisData.økonomi?.netto_perioden,
      estimert_brukskonto_saldo: analysisData.økonomi?.estimert_brukskonto_saldo,
    },
    portefølje: {
      total_verdi: analysisData.portefølje?.total_verdi,
      antall_posisjoner: analysisData.portefølje?.antall_posisjoner,
    },
    faste_utgifter: {
      oppdaget: analysisData.faste_utgifter?.oppdaget,
    },
    kategorier: analysisData.kategorier?.map((k) => ({
      navn: k.navn,
      brukt: k.brukt,
    })),
  };

  fs.writeFileSync(PATHS.lastWeek, JSON.stringify(snapshot, null, 2), "utf-8");
  console.log("✅ Lagret snapshot til last_week.json");
}

// ── Sørg for at history-mappen finnes ────────────────────────────────────────
function sikkerHistoryMappe() {
  if (!fs.existsSync(PATHS.history)) {
    fs.mkdirSync(PATHS.history, { recursive: true });
    console.log("📁 Opprettet data/history/");
  }
}

// ── Hoved-kjøring ─────────────────────────────────────────────────────────────
async function runAgent() {
  const weekLabel = getWeekLabel();
  console.log(`\n🚀 Sparingsagent v2 — ${weekLabel}`);
  console.log(`📡 Worker: ${WORKER_URL}\n`);

  sikkerHistoryMappe();

  // Les CSV
  const dnbCsv = lesFilEllerNull(PATHS.dnbCsv);
  if (!dnbCsv) {
    console.error("❌ dnb_transactions.csv er påkrevd. Last ned fra DNB Nettbank og legg i /data/");
    process.exit(1);
  }
  const nordnetCsv = lesFilEllerNull(PATHS.nordnetCsv);

  // Les config
  const config = lesFilEllerNull(PATHS.config, "json");
  if (!config) {
    console.warn("⚠️  Ingen config.json funnet — bruker standardverdier");
  }

  // Les historikk
  const lastWeek = lesFilEllerNull(PATHS.lastWeek, "json");
  if (lastWeek) {
    console.log(`✅ Forrige ukes data lastet (${lastWeek.uke})`);
  } else {
    console.log("ℹ️  Ingen forrige ukes data — første kjøring");
  }

  const portfolioHistory = lesFilEllerNull(PATHS.portfolioHistory);

  // Bygg payload
  const payload = {
    dnb_csv: dnbCsv,
    nordnet_csv: nordnetCsv,
    config,
    last_week: lastWeek,
    portfolio_history: portfolioHistory,
    week_label: weekLabel,
  };

  console.log("\n📤 Sender til Cloudflare Worker...");

  // Kall Worker
  let response;
  try {
    response = await fetch(WORKER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(AGENT_SECRET && { "X-Agent-Secret": AGENT_SECRET }),
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error("❌ Nettverksfeil:", err.message);
    process.exit(1);
  }

  const responseText = await response.text();

  if (!response.ok) {
    console.error(`❌ Worker feil ${response.status}:`);
    console.error(responseText);
    process.exit(1);
  }

  let result;
  try {
    result = JSON.parse(responseText);
  } catch {
    console.error("❌ Kunne ikke parse Worker-respons:", responseText.slice(0, 200));
    process.exit(1);
  }

  if (!result.success || !result.data) {
    console.error("❌ Uventet respons fra Worker:", result);
    process.exit(1);
  }

  const analysisData = result.data;

  // Oppdater historikk
  console.log("\n💾 Oppdaterer historikk...");
  oppdaterPorteføljeHistorikk(analysisData);
  lagreSomForrigeUke(analysisData);

  console.log("\n✅ Sparingsagent fullført!");
  console.log(`📬 Discord-rapport sendt: ${analysisData.uke || weekLabel}`);
  console.log("\n📊 Nøkkeltall denne uken:");
  if (analysisData.økonomi) {
    console.log(`   Inntekt:   ${analysisData.økonomi.inntekt_perioden}`);
    console.log(`   Utgifter:  ${analysisData.økonomi.utgifter_perioden}`);
    console.log(`   Netto:     ${analysisData.økonomi.netto_perioden}`);
  }
  if (analysisData.portefølje) {
    console.log(`   Portefølje: ${analysisData.portefølje.total_verdi}`);
  }
}

runAgent().catch((err) => {
  console.error("❌ Uventet feil:", err);
  process.exit(1);
});
