"use client";
/* eslint-disable @next/next/no-img-element */
import { useEffect, useRef, useState } from "react";
import type { Analysis, Product, PromptScore, Proposal, Scorecard } from "@/lib/types";
import { buildCsv, buildJson, download, wordDiff } from "@/lib/export";

type Info = { samples: { asin: string; title: string; url: string }[]; liveAmazon: boolean; claude: string | null; esciQueries: number };
type Res = Analysis & { warning?: string };
type Prop = Proposal & { warning?: string };

const f1 = (x: number | null | undefined) => (x == null ? "—" : (Math.round(x * 10) / 10).toFixed(1));
const NAMES = { R: "Query relevance", A: "Attribute coverage", C: "Content clarity", M: "Metadata" } as const;
const EXPLAIN = {
  R: "How well the listing satisfies each shopper prompt, judged with Amazon ESCI's labels: Exact, Substitute, Complement, Irrelevant. Weight 40%.",
  A: "Share of the attributes each prompt asks for (color, size, material, audience…) that the page states. Title or details = full credit, only in bullets/description = half, not stated = none. Weight 30%; when a prompt asks for no attribute, its weight is shared out.",
  C: "Four checks of 25 points: product type clear from the title, a real description, 2+ concrete bullets, no repeated boilerplate. Weight 20%.",
  M: "Which listing fields are filled: title, brand, bullets, description, 3+ product details, and color when relevant. Weight 10%.",
} as const;
const LABEL = { E: ["Exact match", "good"], S: ["Substitute", "warn"], C: ["Complement", "warn"], I: ["Irrelevant", "bad"] } as const;
const tone = (v: number) => (v >= 75 ? "good" : v >= 55 ? "warn" : "bad");

export default function AgentReady() {
  const [info, setInfo] = useState<Info | null>(null);
  const [stage, setStage] = useState<"input" | "loading" | "results">("input");
  const [mode, setMode] = useState<"url" | "text">("url");
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const [load, setLoad] = useState(0);
  const [a, setA] = useState<Res | null>(null);
  const [prop, setProp] = useState<Prop | null>(null);
  const [optBusy, setOptBusy] = useState(false);
  const [optErr, setOptErr] = useState("");
  const [choice, setChoice] = useState<"improved" | "original" | null>(null);
  const improveRef = useRef<HTMLDivElement>(null);
  const exportRef = useRef<HTMLDivElement>(null);

  useEffect(() => { fetch("/api/samples").then((r) => r.json()).then(setInfo).catch(() => {}); }, []);
  useEffect(() => {
    if (stage !== "loading") return;
    const t = [setTimeout(() => setLoad(1), 1500), setTimeout(() => setLoad(2), 3500), setTimeout(() => setLoad(3), 9000)];
    return () => t.forEach(clearTimeout);
  }, [stage]);

  async function run(body: { url?: string; text?: string }) {
    setErr(""); setLoad(0); setStage("loading"); setProp(null); setChoice(null); setOptErr("");
    try {
      const r = await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Analysis failed.");
      setA(j); setStage("results"); window.scrollTo(0, 0);
    } catch (e) { setErr((e as Error).message); setStage("input"); }
  }

  async function improve() {
    if (!a) return;
    setOptBusy(true); setOptErr(""); setChoice(null);
    try {
      const r = await fetch("/api/optimize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ analysis: a }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not generate improvements.");
      setProp(j);
      setTimeout(() => improveRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 200);
    } catch (e) { setOptErr((e as Error).message); } finally { setOptBusy(false); }
  }

  const step = stage !== "results" ? 1 : choice ? 4 : prop ? 3 : 2;
  const reset = () => { setStage("input"); setA(null); setProp(null); setChoice(null); setErr(""); };

  return (
    <>
      <header className="top"><div className="top-in">
        <button className="logo" onClick={reset} aria-label="Start over"><i />AgentReady</button>
        {a && stage === "results" && <div className="badges">
          <span className="badge">{a.mode.data === "rainforest" ? "Live Amazon page" : a.mode.data === "sample" ? "Sample listing (ESCI)" : "Pasted listing"}</span>
          <span className="badge">{a.mode.judge === "claude" ? `Judge: ${a.mode.model}` : "Judge: keyword rules"}</span>
        </div>}
        <nav className="steps" aria-label="Progress">
          {["Link", "Scores", "Improve", "Export"].map((s, i) => (
            <button key={s} className={`step ${step === i + 1 ? "on" : step > i + 1 ? "done" : ""}`} disabled={step < i + 1}
              onClick={() => i === 0 ? reset() : i === 1 ? window.scrollTo({ top: 0, behavior: "smooth" }) : i === 2 ? improveRef.current?.scrollIntoView({ behavior: "smooth" }) : exportRef.current?.scrollIntoView({ behavior: "smooth" })}>
              <b>{step > i + 1 ? "✓" : i + 1}</b>{s}
            </button>
          ))}
        </nav>
      </div></header>

      <main className="main">
        {stage === "input" && (
          <section className="hero">
            <p className="eyebrow">AI shopping visibility</p>
            <h1>Is your product visible to AI shoppers?</h1>
            <p className="lead">Paste an Amazon product link. We read the page the way an AI shopping agent does, test it against real shopper queries from Amazon&apos;s ESCI dataset, and score its visibility and SEO. Then we suggest fixes you can export.</p>
            <form className="bar" onSubmit={(e) => { e.preventDefault(); if (mode === "url" ? url.trim() : text.trim()) run(mode === "url" ? { url } : { text }); }}>
              {mode === "url"
                ? <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.amazon.com/dp/B0..." aria-label="Amazon product link" />
                : <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} placeholder={"Title: …\nBrand: …\n- bullet point\n- bullet point\nDescription: …"} aria-label="Listing text" />}
              <button className="primary" type="submit">Analyze</button>
            </form>
            {err && <div className="err" role="alert">{err}</div>}
            <p className="hint">
              {mode === "url" ? <>No link handy? <button className="link" onClick={() => setMode("text")}>Paste the listing text instead</button></> : <button className="link" onClick={() => setMode("url")}>Use an Amazon link instead</button>}
              {info && !info.liveAmazon && <> · Live Amazon pages need a product API key; the samples below work offline.</>}
            </p>
            {info && info.samples.length > 0 && <div className="samples">
              {info.samples.map((s) => <button key={s.asin} className="chip-btn" title={s.title} onClick={() => { setMode("url"); setUrl(s.url); run({ url: s.url }); }}>Try: {s.title}</button>)}
            </div>}
            {info && <p className="hint">{info.claude ? `Analysis by ${info.claude}` : "Claude not configured: keyword rules are used"} · {info.esciQueries.toLocaleString()} real shopper queries from Amazon ESCI</p>}
          </section>
        )}

        {stage === "loading" && (
          <ul className="loading" aria-live="polite">
            {["Reading the product page", "Finding real shopper queries (Amazon ESCI)", "Reading it like an AI shopping agent", "Scoring visibility and SEO"].map((s, i) => (
              <li key={s} className={load === i ? "on" : load > i ? "done" : ""}>{load === i ? <span className="spin" /> : <span className="dotx">{load > i ? "✓" : "·"}</span>}{s}</li>
            ))}
          </ul>
        )}

        {stage === "results" && a && <Results a={a} prop={prop} optBusy={optBusy} optErr={optErr} onImprove={improve} />}

        {stage === "results" && a && prop && (
          <div ref={improveRef}>
            <Improve a={a} prop={prop} />
            <div className="decide" style={{ marginTop: 16 }}>
              <p>Use this improved version?</p>
              <button className="primary" onClick={() => { setChoice("improved"); setTimeout(() => exportRef.current?.scrollIntoView({ behavior: "smooth" }), 50); }}>Yes, use it</button>
              <button className="ghost" onClick={() => { setChoice("original"); setTimeout(() => exportRef.current?.scrollIntoView({ behavior: "smooth" }), 50); }}>Keep my original</button>
              <button className="ghost" onClick={improve} disabled={optBusy}>{optBusy ? "Regenerating…" : "Regenerate"}</button>
            </div>
          </div>
        )}

        {stage === "results" && a && prop && choice && (
          <div ref={exportRef} className="card" style={{ marginTop: 16 }}>
            <h2>Export {choice === "improved" ? "the improved listing" : "your original listing"} and report</h2>
            <p className="sub">Includes the listing, both score sets, every shopper prompt with its before/after score, new prompts, and facts to confirm. Nothing is published to Amazon.</p>
            <div className="tags">
              <button className="primary" onClick={() => download(`agentready-${a.product.asin ?? "listing"}.csv`, buildCsv(a, prop, choice === "improved"), "text/csv")}>Download CSV</button>
              <button className="ghost" onClick={() => download(`agentready-${a.product.asin ?? "listing"}.json`, JSON.stringify(buildJson(a, prop, choice === "improved"), null, 2), "application/json")}>Download JSON</button>
              <CopyButton listing={choice === "improved" ? prop.listing : a.product} />
            </div>
            {prop.needsConfirmation.length > 0 && <p className="note">Before publishing, confirm the {prop.needsConfirmation.length} open question(s) above. They are not in the exported listing.</p>}
          </div>
        )}
      </main>
    </>
  );
}

function CopyButton({ listing }: { listing: Product }) {
  const [done, setDone] = useState(false);
  return <button className="ghost" onClick={() => navigator.clipboard.writeText(`${listing.title}\n\n${listing.bullets.map((b) => `• ${b}`).join("\n")}\n\n${listing.description}`).then(() => setDone(true))}>{done ? "Copied" : "Copy listing text"}</button>;
}

// ---------------------------------------------------------------------------------------------------- results
function Results({ a, prop, optBusy, optErr, onImprove }: { a: Res; prop: Prop | null; optBusy: boolean; optErr: string; onImprove: () => void }) {
  const p = a.product, s = a.scorecard;
  const exact = s.prompts.filter((x) => x.judgement.label === "E").length;
  return (
    <>
      {a.warning && <div className="warnbox">{a.warning}</div>}
      <div className="grid">
        <div className="card span-12 prod">
          {p.image && <img src={p.image} alt="" />}
          <div>
            <h1>{p.title}</h1>
            <div className="meta">
              {p.brand && <span>Brand: <b>{p.brand}</b></span>}
              {p.asin && <span>ASIN {p.asin}</span>}
              {p.price && <span>{p.price}</span>}
              {p.rating != null && <span>★ {p.rating} ({p.ratingsTotal?.toLocaleString() ?? "?"} ratings)</span>}
              {p.url && <a href={p.url} target="_blank" rel="noreferrer">View on Amazon ↗</a>}
            </div>
          </div>
        </div>

        <Kpi className="span-4" value={s.visibility} label="Visibility readiness" cap={`How well AI shopping agents can match this listing to ${s.prompts.length} shopper prompts`} />
        <Kpi className="span-4" value={s.seo.score} label="Amazon SEO" cap="Keyword placement and listing structure for Amazon search" />
        <div className="card span-4 kpi">
          <div className="big">{exact}<small>/{s.prompts.length}</small></div>
          <div className="lbl">Exact matches</div>
          <div className="cap">Prompts where the listing fully satisfies what the shopper asked for</div>
        </div>

        <div className="card span-7"><h2>Visibility score breakdown</h2><p className="sub">Click a bar to see how it&apos;s scored.</p><Breakdown s={s} /></div>
        <div className="card span-5"><h2>SEO checklist</h2><p className="sub">Top shopper keywords: {s.seo.keywords.map((k) => k.term).join(", ") || "—"}</p>
          <div className="checks">{s.seo.checks.map((c) => (
            <div className="ck" key={c.name}><span className={c.pass ? "ok" : "no"}>{c.pass ? "✓" : "✗"}</span><span>{c.name}</span><span className="pts">{c.points}/{c.max}</span><span className="d">{c.detail}</span></div>
          ))}</div>
        </div>

        <AgentCard a={a} />

        <div className="card span-12">
          <h2>How shoppers might ask for this product</h2>
          <p className="sub">Requests to an AI assistant, and Amazon searches (real ones are from the ESCI dataset). Each is scored with the formula above, worst first. Click one for details.</p>
          {s.prompts.map((x) => <PromptRow key={x.prompt.id} x={x} />)}
        </div>

        {a.esciMatches.length > 0 && <div className="card span-12">
          <h2>Related real Amazon searches</h2>
          <p className="sub">The most similar of {""}97k real shopper queries in the Amazon ESCI dataset. Useful as keyword ideas.</p>
          <div className="tags">{a.esciMatches.map((q) => <span key={q} className="pill neutral">{q}</span>)}</div>
        </div>}
      </div>

      {!prop && <div className="decide" style={{ marginTop: 16 }}>
        <p>Get suggested improvements that use only facts already on your page.</p>
        <button className="primary" onClick={onImprove} disabled={optBusy}>{optBusy ? "Writing improvements…" : "Improve my listing"}</button>
      </div>}
      {optErr && <div className="err" role="alert">{optErr}</div>}
    </>
  );
}

function Kpi({ value, label, cap, className }: { value: number; label: string; cap: string; className: string }) {
  return (
    <div className={`card kpi ${className}`}>
      <div className="kpi-row"><div className="ring" style={{ ["--v" as string]: value }} /><div className="big">{f1(value)}<small>/100</small></div></div>
      <div className="lbl">{label}</div><div className="cap">{cap}</div>
    </div>
  );
}

function Breakdown({ s }: { s: Scorecard }) {
  const [open, setOpen] = useState<keyof typeof NAMES | null>(null);
  return (
    <>
      <div className="bars">
        {(["R", "A", "C", "M"] as const).map((k) => (
          <div key={k}>
            <button className="barrow" onClick={() => setOpen(open === k ? null : k)} aria-expanded={open === k}>
              <span>{NAMES[k]}</span><div className="trk"><div className="fil" style={{ width: `${s.max[k] ? Math.min(100, (100 * s.contrib[k]) / s.max[k]) : 0}%` }} /></div><b>{f1(s.contrib[k])}/{Math.round(s.max[k])}</b>
            </button>
            {open === k && <div className="explain">{EXPLAIN[k]}
              {k === "C" && <ul className="plain">{s.clarity.map((c) => <li key={c.name}>{c.pass ? "✓" : "✗"} {c.name} <span className="pts">({c.detail})</span></li>)}</ul>}
              {k === "M" && <div>{s.metadata.map((m) => `${m.present ? "✓" : "✗"} ${m.field}`).join(" · ")}</div>}
            </div>}
          </div>
        ))}
      </div>
      <div className="formula">{(["R", "A", "C", "M"] as const).map((k) => f1(s.contrib[k])).join(" + ")} = {f1(s.visibility)}. Weights 40/30/20/10 are set by us, not learned.{s.renormalized ? ` ${s.renormalized} prompt(s) ask for no specific attribute, so coverage's weight is shared out there.` : ""}</div>
    </>
  );
}

function AgentCard({ a }: { a: Res }) {
  const v = a.agentView;
  return (
    <>
      <div className="card span-7">
        <h2>What an AI shopping agent takes from this page</h2>
        <p className="sub">Product type: <b>{v.productType}</b>{v.audience.length ? <> · For: {v.audience.join(", ")}</> : null}</p>
        <blockquote className="quote">{v.summary}</blockquote>
        <div className="tw"><table><thead><tr><th>Fact</th><th>Value</th><th>From</th></tr></thead><tbody>
          {v.facts.map((f, i) => <tr key={i}><td>{f.name}</td><td>{f.value} {!f.verified && <span className="pill warn" title="Could not find this wording on the page">check</span>}</td><td className="pts">{f.source}</td></tr>)}
        </tbody></table></div>
        {v.useCases.length > 0 && <p className="note">Use cases: {v.useCases.join(" · ")}</p>}
      </div>
      <div className="card span-5">
        <h2>What the agent can&apos;t find</h2>
        <p className="sub">Questions shoppers ask that this page doesn&apos;t answer.</p>
        {v.missing.length ? <ul className="plain miss">{v.missing.map((m, i) => <li key={i}><b>{m.info}</b><span>{m.why}</span></li>)}</ul> : <p>Nothing important missing.</p>}
      </div>
    </>
  );
}

function PromptRow({ x }: { x: PromptScore }) {
  const [open, setOpen] = useState(false);
  const [lbl, t] = LABEL[x.judgement.label];
  return (
    <div className="prow">
      <button onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="q">{x.prompt.prompt}<small>{x.prompt.style === "conversational" ? "AI assistant request" : "Amazon search"} · {x.prompt.origin === "esci" ? "real ESCI query" : "generated"}</small></span>
        <span className="hide-s"><span className={`pill ${t}`}>{lbl}</span></span>
        <span className="hide-s pts">R {f1(x.R)}</span>
        <span className={`sc ${tone(x.V) === "bad" ? "down" : ""}`}>{f1(x.V)}</span>
        <span aria-hidden>{open ? "▾" : "▸"}</span>
      </button>
      {open && <div className="pdetail">
        <div><h4>Why</h4>{x.judgement.reason}</div>
        <div><h4>Score</h4>{(["R", "A", "C", "M"] as const).map((k) => `${NAMES[k]} ${f1(x[k])} × ${(x.weights[k] * 100).toFixed(0)}% = ${f1(x.contrib[k])}`).join(" · ")} → <b>{f1(x.V)}</b></div>
        <div><h4>Words from the prompt on the page</h4><div className="terms">{x.matchedTerms.map((m) => <span key={m.term} className={m.where.length ? "hit" : "miss"}>{m.term}{m.where.length ? ` · ${m.where[0]}` : ""}</span>)}</div></div>
        <div><h4>What the shopper asked for</h4>{x.attributes.length ? <table><tbody>{x.attributes.map((t2, i) => (
          <tr key={i}><td>{t2.key}: {t2.value}</td><td><span className={`pill ${t2.status === "Known" ? "good" : t2.status === "Not exposed" ? "warn" : "bad"}`}>{t2.status === "Not exposed" ? "Buried in text" : t2.status === "Unknown" ? "Not stated" : "Clearly stated"}</span></td><td className="pts">{t2.evidence}</td></tr>
        ))}</tbody></table> : "No specific attribute: coverage is not scored for this prompt."}</div>
      </div>}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------- improve
function Diff({ a, b }: { a: string; b: string }) {
  return <>{wordDiff(a, b).map((d, i) => d.k === "same" ? <span key={i}>{d.t}</span> : d.k === "ins" ? <ins key={i}>{d.t}</ins> : <del key={i}>{d.t}</del>)}</>;
}

function Improve({ a, prop }: { a: Res; prop: Prop }) {
  const b = a.scorecard, n = prop.scorecard, o = a.product, l = prop.listing;
  const d = (x: number, y: number) => { const v = Math.round((y - x) * 10) / 10; return <span className={`delta ${v > 0 ? "up" : v < 0 ? "down" : ""}`}>{v > 0 ? "+" : ""}{v.toFixed(1)}</span>; };
  const added = l.specifications.filter((s) => !o.specifications.some((x) => x.name === s.name && x.value === s.value));
  return (
    <>
      <div className="section-title"><h2>Suggested improvements</h2><span>{prop.mode.rewrite === "claude" ? `Written by ${prop.mode.model}, checked against your page` : "Rule-based: moves facts already on your page into more visible places"}</span></div>
      {prop.warning && <div className="warnbox">{prop.warning}</div>}
      <div className="grid">
        <div className="card span-4 kpi"><div className="big">{f1(b.visibility)} → {f1(n.visibility)}</div><div className="lbl">Visibility readiness {d(b.visibility, n.visibility)}</div><div className="cap">Same prompts, same judge; only the listing changed</div></div>
        <div className="card span-4 kpi"><div className="big">{b.seo.score} → {n.seo.score}</div><div className="lbl">Amazon SEO {d(b.seo.score, n.seo.score)}</div><div className="cap">Same keyword checklist</div></div>
        <div className="card span-4 kpi"><div className="big">{b.prompts.filter((x) => x.judgement.label === "E").length} → {n.prompts.filter((x) => x.judgement.label === "E").length}</div><div className="lbl">Exact matches</div><div className="cap">out of {n.prompts.length} prompts</div></div>

        <div className="card span-12">
          <h2>Before and after</h2><p className="sub"><ins>Added</ins> and <del>removed</del> words are highlighted.</p>
          <div className="cmp">
            <div className="box"><h3>Original</h3>
              <div className="f"><span>Title</span>{o.title}</div>
              <div className="f"><span>Bullets</span><ul className="plain">{o.bullets.map((x, i) => <li key={i}>{x}</li>)}</ul></div>
              <div className="f"><span>Description</span>{o.description || "—"}</div>
            </div>
            <div className="box"><h3>Improved</h3>
              <div className="f"><span>Title</span><Diff a={o.title} b={l.title} /></div>
              <div className="f"><span>Bullets</span><ul className="plain">{l.bullets.map((x, i) => <li key={i}>{o.bullets.includes(x) ? x : <ins>{x}</ins>}</li>)}</ul></div>
              <div className="f"><span>Description</span><Diff a={o.description} b={l.description} /></div>
              {added.length > 0 && <div className="f"><span>Details added</span>{added.map((s, i) => <div key={i}><ins>{s.name}: {s.value}</ins></div>)}</div>}
            </div>
          </div>
        </div>

        <div className="card span-6">
          <h2>Why each change is supported</h2>
          <p className="sub">Every change cites text that is already on your page.</p>
          {prop.changes.length ? <ul className="plain miss">{prop.changes.map((c, i) => <li key={i}><b>{c.field}: {c.why}</b>{c.source && <span>From your page: “{c.source.slice(0, 200)}”</span>}</li>)}</ul> : <p>No supported change to make.</p>}
          {prop.blocked.length > 0 && <div className="warnbox" style={{ marginTop: 12 }}>Blocked because your page doesn&apos;t support it: {prop.blocked.join("; ")}</div>}
        </div>
        <div className="card span-6">
          <h2>Confirm before adding</h2>
          <p className="sub">Shoppers ask for these, but only you can confirm them. They are not in the improved listing.</p>
          {prop.needsConfirmation.length ? <ul className="plain miss">{prop.needsConfirmation.map((c, i) => <li key={i}><b>{c.question}</b><span>Would add: {c.wouldAdd}</span></li>)}</ul> : <p>Nothing to confirm.</p>}
        </div>

        {prop.newPrompts.length > 0 && <div className="card span-12">
          <h2>New shopper prompts this version can win</h2>
          <p className="sub">Requests the improved listing now answers clearly. Use them to check AI assistants after you publish.</p>
          <ul className="plain miss">{prop.newPrompts.map((x, i) => <li key={i}><b>“{x.prompt}”</b><span>{x.why}</span></li>)}</ul>
        </div>}

        <div className="card span-12">
          <h2>Prompt by prompt</h2>
          <div className="tw"><table><thead><tr><th>Prompt</th><th>Before</th><th>After</th><th>Change</th><th>Match</th></tr></thead><tbody>
            {b.prompts.map((x) => { const y = n.prompts.find((z) => z.prompt.id === x.prompt.id); return (
              <tr key={x.prompt.id}><td>{x.prompt.prompt}</td><td>{f1(x.V)}</td><td>{f1(y?.V)}</td><td>{y ? d(x.V, y.V) : "—"}</td><td>{LABEL[x.judgement.label][0]}{y && y.judgement.label !== x.judgement.label ? ` → ${LABEL[y.judgement.label][0]}` : ""}</td></tr>
            ); })}
          </tbody></table></div>
          <p className="note">A controlled comparison: the same prompts and the same judge, only the listing text changed. It is not a guarantee of Amazon or AI-assistant ranking.</p>
        </div>
      </div>
    </>
  );
}
