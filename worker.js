/**
 * Sparingsagent v2 — Cloudflare Worker
 * Med CORS for browser-tilgang og preview_only-modus (ingen Discord-posting)
 *
 * Secrets:
 *   ANTHROPIC_API_KEY   — Anthropic nøkkel
 *   DISCORD_WEBHOOK_URL — Discord webhook
 *   AGENT_SECRET        — Valgfritt tilgangsnøkkel
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Agent-Secret",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const authHeader = request.headers.get("X-Agent-Secret");
    if (env.AGENT_SECRET && authHeader !== env.AGENT_SECRET) {
      return new Response("Unauthorized", { status: 401, headers: CORS_HEADERS });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400, headers: CORS_HEADERS });
    }

    const { dnb_csv, nordnet_csv, config, last_week, portfolio_history, week_label, preview_only } = body;

    if (!dnb_csv) {
      return new Response("Mangler dnb_csv", { status: 400, headers: CORS_HEADERS });
    }

    // Steg 1: Markedsdata
    let markedsdata = "Markedsdata ikke tilgjengelig.";
    try {
      markedsdata = await hentMarkedsdata(env.ANTHROPIC_API_KEY, nordnet_csv, config);
    } catch (err) {
      console.error("Markedsdatafeil:", err.message);
    }

    // Steg 2: Analyse
    let analysisData;
    try {
      analysisData = await kjørHovedanalyse({
        apiKey: env.ANTHROPIC_API_KEY,
        dnbCsv: dnb_csv,
        nordnetCsv: nordnet_csv,
        config,
        lastWeek: last_week,
        portfolioHistory: portfolio_history,
        markedsdata,
        weekLabel: week_label,
      });
    } catch (err) {
      return new Response(`Analysefeil: ${err.message}`, { status: 500, headers: CORS_HEADERS });
    }

    // Steg 3: Discord (hopp over ved preview_only)
    if (!preview_only && env.DISCORD_WEBHOOK_URL) {
      try {
        await postTilDiscord(env.DISCORD_WEBHOOK_URL, analysisData);
      } catch (err) {
        console.error("Discord-feil:", err.message);
      }
    }

    return new Response(
      JSON.stringify({ success: true, data: analysisData }),
      { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  },
};

async function hentMarkedsdata(apiKey, nordnetCsv, config) {
  const fondNavn = nordnetCsv
    ? nordnetCsv.split("\n").slice(1).filter(Boolean).map((l) => l.split(";")[0]).filter(Boolean).join(", ")
    : "norske indeksfond";

  const spørsmål = `Søk og gi en kompakt oppsummering på norsk (maks 120 ord): 1) Norges Banks siste rentebeslutning eller signal. 2) Oslo Børs (OSEBX) siste uke. 3) Kort nyhet for: ${fondNavn}. Ren tekst, ingen lister.`;
  const messages = [{ role: "user", content: spørsmål }];

  for (let i = 0; i < 5; i++) {
    const r = await callClaude(apiKey, {
      model: "claude-sonnet-4-20250514",
      max_tokens: 800,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages,
    });
    const verktøy = r.content.filter((b) => b.type === "tool_use");
    if (!verktøy.length) return r.content.find((b) => b.type === "text")?.text || "Ingen data.";
    messages.push({ role: "assistant", content: r.content });
    messages.push({ role: "user", content: verktøy.map((v) => ({ type: "tool_result", tool_use_id: v.id, content: v.output || "" })) });
  }
  return "Utilgjengelig.";
}

async function kjørHovedanalyse({ apiKey, dnbCsv, nordnetCsv, config, lastWeek, portfolioHistory, markedsdata, weekLabel }) {
  const today = new Date().toLocaleDateString("nb-NO", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const cfg = config || {};
  const bsu = cfg.bsu || {};
  const mål = cfg.sparemål || [];
  const budsjett = cfg.kategoribudsjett || {};
  const dagerIgjen = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate() - new Date().getDate();
  const bsuGjenstår = bsu.aktiv ? (bsu.maks_per_år || 27500) - (bsu.inneværende_år_innskudd || 0) : 0;

  const system = `Du er personlig økonomi- og investeringsassistent for en norsk privatperson.
Bruker: inntekt ~${cfg.månedlig_inntekt_estimat || "ukjent"} kr/mnd, husleie ${cfg.månedlig_husleie || "ukjent"} kr, buffer ${cfg.ønsket_buffer_brukskonto || 15000} kr, portefølje: ${cfg.portefølje?.type || "ASK"}.
${bsu.aktiv ? `BSU: saldo ${bsu.saldo} kr, innskutt i år ${bsu.inneværende_år_innskudd} kr, gjenstår ${bsuGjenstår} kr.` : "Ingen BSU."}
Sparemål: ${mål.map((m) => `${m.navn} ${m.saldo}/${m.mål} kr${m.innen ? " frist " + m.innen : ""}`).join("; ") || "ingen"}
Budsjett: ${Object.entries(budsjett).filter(([k]) => k !== "kommentar").map(([k, v]) => `${k} ${v} kr`).join(", ")}
Svar KUN på norsk. Svar KUN med gyldig JSON, null tekst utenfor.

RETURNER DENNE STRUKTUREN:
{"uke":"Uke XX — DD. måned ÅÅÅÅ","økonomi":{"estimert_brukskonto_saldo":"XX XXX kr","estimert_sparekonto_saldo":"XX XXX kr","inntekt_perioden":"XX XXX kr","utgifter_perioden":"XX XXX kr","netto_perioden":"+/- XX XXX kr","anbefalt_til_brukskonto":"XX XXX kr/mnd","anbefalt_til_sparing":"XX XXX kr/mnd","analyse":"2-3 setninger"},"uke_over_uke":{"tilgjengelig":true,"inntekt_endring":"+/- XX XXX kr","utgifter_endring":"+/- XX XXX kr","største_endring":"tekst"},"kategorier":[{"navn":"Mat/dagligvare","brukt":"X XXX kr","budsjett":"X XXX kr","status":"ok|advarsel|over","prosent":85}],"faste_utgifter":{"oppdaget":["Husleie 12 500 kr"],"nye_siden_sist":[],"endrede":[],"analyse":"tekst"},"månedsprognose":{"estimert_totalforbruk":"XX XXX kr","dager_igjen_i_måneden":${dagerIgjen},"daglig_snittforbruk":"XXX kr","status":"på_kurs|over_budsjett|under_budsjett","beskrivelse":"tekst"},"bsu":{"aktiv":${!!bsu.aktiv},"gjenstående_kvote_i_år":"${bsuGjenstår} kr","potensiell_skattefradrag":"X XXX kr","anbefaling":"tekst"},"portefølje":{"total_verdi":"XX XXX kr","antall_posisjoner":0,"uke_endring":"+/- X XXX kr","beholdninger":[{"navn":"...","verdi":"XX XXX kr","endring_uke":"+X,X%"}],"historikk_trend":"tekst","analyse":"tekst"},"skatt":{"portefølje_type":"ASK","urealisert_gevinst":"XX XXX kr","estimert_skatt_ved_salg":"XX XXX kr","ask_fordel":"tekst"},"sparemål":[{"navn":"...","mål":"XX XXX kr","nåværende":"XX XXX kr","prosent":65,"gjenstår":"XX XXX kr","måneder_til_mål":4,"anbefalt_månedlig":"X XXX kr/mnd","status":"på_kurs|bak_skjema|ingen_frist"}],"markedsdata":{"sammendrag":"tekst"},"anbefalinger":[{"prioritet":1,"emoji":"🎯","tittel":"...","beskrivelse":"..."}],"advarsel":null}`;

  const r = await callClaude(apiKey, {
    model: "claude-sonnet-4-20250514",
    max_tokens: 3000,
    system,
    messages: [{
      role: "user",
      content: `Dato: ${today}\n${weekLabel ? "Uke: " + weekLabel : ""}\nDager igjen i mnd: ${dagerIgjen}\n\n=== MARKEDSDATA ===\n${markedsdata}\n\n=== DNB CSV ===\n${dnbCsv}\n\n=== NORDNET CSV ===\n${nordnetCsv || "Ingen data."}\n\n=== FORRIGE UKE ===\n${lastWeek ? JSON.stringify(lastWeek) : "Første kjøring."}\n\n=== PORTEFØLJEHISTORIKK ===\n${portfolioHistory || "Ingen."}\n\nReturner JSON.`,
    }],
  });

  const raw = r.content.filter((b) => b.type === "text").map((b) => b.text).join("").replace(/```json\n?|```\n?/g, "").trim();
  try { return JSON.parse(raw); } catch { throw new Error("Ugyldig JSON fra Claude: " + raw.slice(0, 200)); }
}

async function postTilDiscord(webhookUrl, data) {
  const embeds = buildEmbeds(data);
  for (let i = 0; i < embeds.length; i += 10) {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "Sparingsagent 💰", embeds: embeds.slice(i, i + 10) }),
    });
    if (!res.ok) throw new Error(`Discord ${res.status}`);
    if (i + 10 < embeds.length) await new Promise((r) => setTimeout(r, 1000));
  }
}

function buildEmbeds(d) {
  const e = [];
  const øk = d.økonomi || {};
  e.push({ title: `📊 ${d.uke}`, description: øk.analyse || "", color: 0x2ecc71, fields: [
    { name: "💳 Brukskonto", value: øk.estimert_brukskonto_saldo || "—", inline: true },
    { name: "🏦 Sparekonto", value: øk.estimert_sparekonto_saldo || "—", inline: true },
    { name: "\u200b", value: "\u200b", inline: false },
    { name: "📥 Inntekt", value: øk.inntekt_perioden || "—", inline: true },
    { name: "📤 Utgifter", value: øk.utgifter_perioden || "—", inline: true },
    { name: "📊 Netto", value: `**${øk.netto_perioden || "—"}**`, inline: true },
    { name: "💡 Til brukskonto", value: `**${øk.anbefalt_til_brukskonto || "—"}**`, inline: true },
    { name: "💰 Til sparing", value: `**${øk.anbefalt_til_sparing || "—"}**`, inline: true },
  ], footer: { text: "Estimater — ikke finansiell rådgivning" }});

  const uou = d.uke_over_uke;
  if (uou?.tilgjengelig) e.push({ title: "📅 Uke-over-uke", color: 0x9b59b6, fields: [
    { name: "💵 Inntektsendring", value: uou.inntekt_endring || "—", inline: true },
    { name: "🛒 Utgiftsendring", value: uou.utgifter_endring || "—", inline: true },
    { name: "🔍 Største endring", value: uou.største_endring || "—", inline: false },
  ]});

  const prog = d.månedsprognose;
  if (prog) {
    const fc = { på_kurs: 0x2ecc71, over_budsjett: 0xe74c3c, under_budsjett: 0xf39c12 };
    const fe = { på_kurs: "🟢", over_budsjett: "🔴", under_budsjett: "🟡" };
    e.push({ title: `${fe[prog.status] || "📆"} Månedsprognose`, description: prog.beskrivelse || "", color: fc[prog.status] || 0x95a5a6, fields: [
      { name: "📈 Estimert totalforbruk", value: prog.estimert_totalforbruk || "—", inline: true },
      { name: "📅 Dager igjen", value: String(prog.dager_igjen_i_måneden ?? "—"), inline: true },
      { name: "💸 Daglig snitt", value: prog.daglig_snittforbruk || "—", inline: true },
    ]});
  }

  if (d.kategorier?.length) {
    const se = { ok: "🟢", advarsel: "🟡", over: "🔴" };
    e.push({ title: "🗂 Kategoribudsjett", color: 0x1abc9c, fields: d.kategorier.slice(0, 9).map((k) => ({ name: `${se[k.status] || "⬜"} ${k.navn}`, value: `${k.brukt} / ${k.budsjett} (${k.prosent}%)`, inline: true }))});
  }

  const faste = d.faste_utgifter;
  if (faste) e.push({ title: "🔁 Faste utgifter", description: [faste.analyse, faste.nye_siden_sist?.length ? `⚠️ Nye: ${faste.nye_siden_sist.join(", ")}` : null].filter(Boolean).join("\n\n"), color: 0x7f8c8d, fields: [{ name: "📋 Oppdagede faste utgifter", value: faste.oppdaget?.slice(0, 10).join("\n") || "—", inline: false }]});

  if (d.bsu?.aktiv) e.push({ title: "🏠 BSU", description: d.bsu.anbefaling || "", color: 0xe67e22, fields: [{ name: "Gjenstående kvote", value: d.bsu.gjenstående_kvote_i_år || "—", inline: true }, { name: "Mulig skattefradrag", value: d.bsu.potensiell_skattefradrag || "—", inline: true }]});

  if (d.sparemål?.length) {
    const pb = (p) => "█".repeat(Math.round(Math.min(p, 100) / 10)) + "░".repeat(10 - Math.round(Math.min(p, 100) / 10));
    const se = { på_kurs: "✅", bak_skjema: "⚠️", ingen_frist: "ℹ️" };
    e.push({ title: "🎯 Sparemål", color: 0x3498db, fields: d.sparemål.map((m) => ({ name: `${se[m.status] || "🎯"} ${m.navn}`, value: `${pb(m.prosent || 0)} **${m.prosent || 0}%**\n${m.nåværende} / ${m.mål} — Gjenstår: **${m.gjenstår}**\nAnbefalt: ${m.anbefalt_månedlig}${m.måneder_til_mål ? ` (${m.måneder_til_mål} mnd)` : ""}`, inline: false }))});
  }

  const pf = d.portefølje;
  if (pf) e.push({ title: "📈 Portefølje", description: pf.analyse || "", color: 0x2980b9, fields: [
    { name: "💼 Total verdi", value: pf.total_verdi || "—", inline: true },
    { name: "📊 Ukesendring", value: pf.uke_endring || "—", inline: true },
    { name: "🔢 Posisjoner", value: String(pf.antall_posisjoner ?? "—"), inline: true },
    { name: "📋 Beholdninger", value: (pf.beholdninger?.map((b) => `**${b.navn}** — ${b.verdi} (${b.endring_uke})`).join("\n") || "—").slice(0, 1024), inline: false },
  ]});

  if (d.skatt) e.push({ title: `🧾 Skatt (${d.skatt.portefølje_type})`, color: 0x95a5a6, fields: [
    { name: "Urealisert gevinst", value: d.skatt.urealisert_gevinst || "—", inline: true },
    { name: "Est. skatt ved salg", value: d.skatt.estimert_skatt_ved_salg || "—", inline: true },
    { name: "ASK-fordel", value: d.skatt.ask_fordel || "—", inline: false },
  ]});

  if (d.markedsdata?.sammendrag) e.push({ title: "🌍 Markedsoversikt", description: d.markedsdata.sammendrag, color: 0x34495e, footer: { text: "Hentet via web search" }});

  if (d.anbefalinger?.length) e.push({ title: "⚡ Anbefalinger", color: 0xe67e22, fields: d.anbefalinger.map((a) => ({ name: `${a.emoji || "▪️"} ${a.tittel}`, value: a.beskrivelse, inline: false }))});

  if (d.advarsel) e.push({ title: "⚠️ Advarsel", description: d.advarsel, color: 0xe74c3c });

  return e;
}

async function callClaude(apiKey, payload) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`Claude ${r.status}: ${await r.text()}`);
  return r.json();
}
