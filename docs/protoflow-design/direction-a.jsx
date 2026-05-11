// Direction A — "Blueprint"
// Clean technical whiteboard. Mono labels, thin orthogonal connectors,
// dense pro-tool inspector on the right. Light paper background, 1px lines.

const A_CSS = `
.A-root{font-family:'JetBrains Mono','SF Mono',ui-monospace,Menlo,monospace;color:#1a1815;height:100%;display:flex;flex-direction:column;background:#f5f1e8;}
.A-toolbar{display:flex;align-items:center;gap:14px;padding:10px 16px;border-bottom:1px solid #d8cfb8;background:#ebe4d2;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#6a5e44;flex-shrink:0;}
.A-toolbar .A-pill{padding:3px 9px;border:1px solid #6a5e44;border-radius:2px;color:#1a1815;background:#fff;cursor:pointer;}
.A-toolbar .A-pill.on{background:#1a1815;color:#f5f1e8;}
.A-toolbar .A-spacer{flex:1;}
.A-toolbar .A-stat{display:flex;align-items:center;gap:6px;font-size:11px;}
.A-toolbar .A-stat b{color:#1a1815;font-weight:600;}
.A-stage{flex:1;display:flex;min-height:0;}
.A-canvas{flex:1;position:relative;background:
  linear-gradient(rgba(106,94,68,.07) 1px,transparent 1px) 0 0/24px 24px,
  linear-gradient(90deg,rgba(106,94,68,.07) 1px,transparent 1px) 0 0/24px 24px,
  #f5f1e8;
  overflow:hidden;}
.A-canvas .A-corner{position:absolute;font-size:9px;letter-spacing:.12em;color:#9c8e6c;text-transform:uppercase;}
.A-node{position:absolute;border:1.4px solid #1a1815;background:#fff;width:178px;}
.A-node.selected{outline:3px solid #c96442;outline-offset:3px;}
.A-node-head .A-opt{font-size:9px;letter-spacing:.14em;font-weight:700;background:rgba(255,255,255,.22);padding:1px 5px;margin-left:6px;}
.A-node.human{border-color:#a86b1d;outline:1px solid #d99a3d;outline-offset:0;}
.A-node.human .A-node-head{background:repeating-linear-gradient(135deg,#d99a3d 0 6px,#c98a2d 6px 12px) !important;}
.A-node .A-human{position:absolute;top:-16px;left:50%;transform:translateX(-50%);width:32px;height:32px;border-radius:50%;background:#d99a3d;border:1.6px solid #1a1815;color:#1a1815;display:flex;align-items:center;justify-content:center;z-index:3;box-shadow:0 2px 6px rgba(0,0,0,.2);}
.A-phase-band{position:absolute;border:1px dashed #9c8e6c;border-radius:0;}
.A-phase-band .A-phase-label{position:absolute;top:-9px;left:8px;background:#f5f1e8;padding:0 6px;font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:#6a5e44;}
.A-node-head{display:flex;justify-content:space-between;align-items:center;padding:5px 8px;background:#1a1815;color:#f5f1e8;font-size:9px;letter-spacing:.16em;text-transform:uppercase;}
.A-node-head .A-num{opacity:.55;}
.A-node-body{padding:9px 10px 11px;}
.A-node-name{font-size:12px;font-weight:600;line-height:1.25;color:#1a1815;letter-spacing:-.01em;}
.A-node-meta{margin-top:8px;display:flex;flex-direction:column;gap:3px;font-size:10px;color:#6a5e44;}
.A-node-meta .k{display:inline-block;width:38px;color:#9c8e6c;}
.A-node-meta b{color:#1a1815;font-weight:600;}
.A-node-foot{display:flex;align-items:center;gap:6px;padding:5px 10px;border-top:1px dashed #d8cfb8;font-size:9px;color:#6a5e44;letter-spacing:.06em;}
.A-node-foot .A-dot{width:5px;height:5px;border-radius:50%;background:#9c8e6c;}
.A-node-foot .A-dot.run{background:#2d8a5b;}
.A-node-foot .A-dot.warn{background:#c96442;}
.A-svg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;}
.A-token{r:3.5;fill:#c96442;}
.A-inspector{width:300px;border-left:1px solid #d8cfb8;background:#ebe4d2;display:flex;flex-direction:column;flex-shrink:0;}
.A-insp-tabs{display:flex;border-bottom:1px solid #d8cfb8;}
.A-insp-tabs button{flex:1;padding:8px 0;font-family:inherit;font-size:10px;letter-spacing:.16em;text-transform:uppercase;background:transparent;border:0;border-bottom:2px solid transparent;color:#6a5e44;cursor:pointer;}
.A-insp-tabs button.on{color:#1a1815;border-bottom-color:#1a1815;background:#f5f1e8;}
.A-insp-body{flex:1;overflow:auto;padding:14px 16px;font-size:11px;line-height:1.45;color:#1a1815;}
.A-insp-body h3{font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:#6a5e44;margin:0 0 6px;font-weight:600;}
.A-insp-body section{margin-bottom:18px;}
.A-insp-body .A-row{display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px dotted #d8cfb8;}
.A-insp-body .A-row span:first-child{color:#6a5e44;}
.A-insp-body .A-row b{font-weight:600;}
.A-insp-body .A-prompt{background:#fff;border:1px solid #d8cfb8;padding:9px 10px;font-size:10.5px;line-height:1.5;color:#1a1815;white-space:pre-wrap;height:108px;overflow:auto;}
.A-insp-body .A-mcp{display:flex;justify-content:space-between;align-items:center;padding:5px 0;font-size:10.5px;}
.A-insp-body .A-mcp .A-toggle{width:22px;height:12px;border:1px solid #1a1815;background:#fff;position:relative;cursor:pointer;}
.A-insp-body .A-mcp .A-toggle.on{background:#1a1815;}
.A-insp-body .A-mcp .A-toggle::after{content:'';position:absolute;top:1px;left:1px;width:8px;height:8px;background:#c96442;}
.A-insp-body .A-mcp .A-toggle.on::after{left:11px;background:#f5f1e8;}
.A-insp-body select,.A-insp-body input[type=number]{font-family:inherit;font-size:11px;border:1px solid #1a1815;background:#fff;padding:4px 6px;width:100%;color:#1a1815;}
.A-insp-body .A-models{display:grid;grid-template-columns:1fr 1fr;gap:4px;}
.A-insp-body .A-models button{font-family:inherit;font-size:10px;padding:7px 6px;border:1px solid #1a1815;background:#fff;color:#1a1815;cursor:pointer;text-align:left;text-transform:uppercase;letter-spacing:.06em;}
.A-insp-body .A-models button.on{background:#1a1815;color:#f5f1e8;}
.A-insp-body .A-models button .sub{display:block;font-size:8.5px;letter-spacing:.04em;text-transform:none;opacity:.6;margin-top:2px;}
`;

if (!document.getElementById('A-css')) {
  const s = document.createElement('style'); s.id = 'A-css'; s.textContent = A_CSS;
  document.head.appendChild(s);
}

// Layout: phase bands across; a single column of steps inside each band.
// Computed per render so the modal can pass any workflow id.
function computeLayout(phases) {
  const out = []; let x = 36;
  const BAND_W = 220, ROW_H = 156, TOP = 64;
  phases.forEach((ph, pi) => {
    const band = { x, y: 36, w: BAND_W, h: TOP + ph.steps.length * ROW_H, label: ph.label.toUpperCase() + ' / phase ' + String(pi + 1).padStart(2, '0'), color: ph.color };
    const steps = ph.steps.map((s, si) => ({
      ...s, phaseId: ph.id, phase: ph,
      x: x + (BAND_W - 178) / 2, y: 36 + TOP + si * ROW_H, idx: si + 1,
    }));
    out.push({ band, steps });
    x += BAND_W + 46;
  });
  return out;
}

function ABlueprint({ selected, setSelected, running, t, inspectorClosed, hideToolbarPills, workflowId = 'soloflow' }) {
  const phases = window.WORKFLOW_DEFS[workflowId] || window.WORKFLOW_DEFS.soloflow;
  const layout = computeLayout(phases);
  const allSteps = layout.flatMap((b) => b.steps);
  const selStep = allSteps.find((s) => s.id === selected) || allSteps[0];
  const agent = window.AGENTS.find((a) => a.id === selStep.agent);

  // Build edges: linear within band, last->first across bands, plus loopback edges
  const edges = [];
  layout.forEach((band, bi) => {
    band.steps.forEach((s, si) => {
      if (si < band.steps.length - 1) edges.push({ from: s, to: band.steps[si + 1], kind: 'down' });
      if (s.loopback) {
        const target = band.steps.find((x) => x.id === s.loopback);
        if (target) edges.push({ from: s, to: target, kind: 'loop' });
      }
    });
    if (bi < layout.length - 1) {
      const last = band.steps[band.steps.length - 1];
      const next = layout[bi + 1].steps[0];
      edges.push({ from: last, to: next, kind: 'across' });
    }
  });

  const center = (s) => ({ cx: s.x + 89, cy: s.y + 60 });
  const path = (e) => {
    const a = center(e.from), b = center(e.to);
    if (e.kind === 'down') return `M ${a.cx} ${a.cy + 50} L ${a.cx} ${b.cy - 50}`;
    if (e.kind === 'across') return `M ${a.cx + 89} ${a.cy} L ${b.cx - 89} ${b.cy}`;
    if (e.kind === 'loop') {
      const midX = a.cx + 130;
      return `M ${a.cx + 89} ${a.cy} L ${midX} ${a.cy} L ${midX} ${b.cy} L ${b.cx + 89} ${b.cy}`;
    }
  };

  // animated token positions along the linear sequence
  const flat = []; layout.forEach((b) => b.steps.forEach((s) => flat.push(s)));
  const tokenIdx = (t * flat.length) % flat.length;
  const i0 = Math.floor(tokenIdx); const f = tokenIdx - i0;
  const i1 = (i0 + 1) % flat.length;
  const p0 = center(flat[i0]); const p1 = center(flat[i1]);
  const tx = p0.cx + (p1.cx - p0.cx) * f, ty = p0.cy + (p1.cy - p0.cy) * f;

  return (
    <div className="A-root">
      <div className="A-toolbar">
        <span style={{ fontWeight: 700, color: '#1a1815', letterSpacing: '.18em' }}>PROTOFLOW · soloflow.yaml</span>
        <span className="A-spacer"></span>
      </div>
      <div className="A-stage">
        <div className="A-canvas">
          <span className="A-corner" style={{ top: 8, left: 12 }}>00 · soloflow / pipeline</span>
          <span className="A-corner" style={{ top: 8, right: 12 }}>rev 0014 · 2026-05-06</span>
          <span className="A-corner" style={{ bottom: 8, left: 12 }}>scale 1:1 · grid 24</span>

          {layout.map(({ band }, i) => (
            <div key={i} className="A-phase-band" style={{ left: band.x, top: band.y, width: band.w, height: band.h }}>
              <span className="A-phase-label" style={{ color: band.color }}>{band.label}</span>
            </div>
          ))}

          <svg className="A-svg">
            <defs>
              <marker id="A-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
                <path d="M0,0 L8,4 L0,8 z" fill="#1a1815" />
              </marker>
              <marker id="A-arrow-loop" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
                <path d="M0,0 L8,4 L0,8 z" fill="#c96442" />
              </marker>
            </defs>
            {edges.map((e, i) => (
              <path key={i} d={path(e)} stroke={e.kind === 'loop' ? '#c96442' : '#1a1815'} strokeWidth={e.kind === 'loop' ? 1.2 : 1.4}
                strokeDasharray={e.kind === 'loop' ? '4 3' : '0'}
                fill="none" markerEnd={`url(#${e.kind === 'loop' ? 'A-arrow-loop' : 'A-arrow'})`} />
            ))}
            {running && <circle cx={tx} cy={ty} r="4" fill="#c96442" />}
          </svg>

          {allSteps.map((s, i) => {
            const ag = window.AGENTS.find((a) => a.id === s.agent);
            const isRunning = running && Math.floor(tokenIdx) === i;
            const isDone = running && Math.floor(tokenIdx) > i;
            return (
              <div key={s.id} className={'A-node' + (s.id === selected ? ' selected' : '') + (s.human ? ' human' : '')}
                style={{ left: s.x, top: s.y }} onClick={() => setSelected(s.id)}>
                {s.human && <span className="A-human" aria-label="human"><svg width="15" height="15" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="6" cy="4" r="2"/><path d="M2 11c.4-2.3 2-3.5 4-3.5s3.6 1.2 4 3.5"/></svg></span>}
                <div className="A-node-head" style={{ background: s.phase.color }}>
                  <span style={{ display: 'flex', alignItems: 'center' }}>
                    <span>{s.phase.label.toUpperCase()}</span>
                    {s.optional && <span className="A-opt">OPTIONAL</span>}
                  </span>
                  <span className="A-num">{String(s.idx).padStart(2, '0')}</span>
                </div>
                <div className="A-node-body">
                  <div className="A-node-name">{s.name}</div>
                  <div className="A-node-meta">
                    <span><span className="k">agent</span><b>{ag.name}</b></span>
                    <span><span className="k">model</span><b>{ag.model}</b></span>
                    <span><span className="k">retry</span><b>×{s.retries}</b></span>
                  </div>
                </div>
                <div className="A-node-foot">
                  <span className={'A-dot' + (isRunning ? ' warn' : isDone ? ' run' : '')}></span>
                  <span>{isRunning ? 'RUNNING' : isDone ? 'DONE' : 'IDLE'}</span>
                  <span style={{ flex: 1 }}></span>
                  <span>{ag.tokens}</span>
                </div>
              </div>
            );
          })}
        </div>

        {!inspectorClosed && <div className="A-inspector">
          <div className="A-insp-tabs">
            <button className="on">Step</button>
            <button>Agent</button>
            <button>Run</button>
          </div>
          <div className="A-insp-body">
            <section>
              <h3>{selStep.phase.label} · step {String(selStep.idx).padStart(2, '0')}</h3>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>{selStep.name}</div>
              <div style={{ fontSize: 11, color: '#6a5e44', marginBottom: 10 }}>{selStep.id}</div>
              <div className="A-row"><span>agent</span><b>{agent.name}</b></div>
              <div className="A-row"><span>est tokens</span><b>{agent.tokens}</b></div>
              <div className="A-row"><span>retries</span><b>×{selStep.retries}</b></div>
              <div className="A-row"><span>optional</span><b>{selStep.optional ? 'yes' : 'no'}</b></div>
            </section>

            <section>
              <h3>Sub-agent / model</h3>
              <div className="A-models">
                {window.MODELS.map((m) => (
                  <button key={m.id} className={m.id === agent.model ? 'on' : ''}>
                    {m.label}<span className="sub">{m.subtitle}</span>
                  </button>
                ))}
              </div>
            </section>

            <section>
              <h3>System prompt</h3>
              <div className="A-prompt">You are the {agent.name} agent. {agent.desc}{'\n\n'}Read CLAUDE.md and ARCHITECTURE.md before acting. Output a structured spec; do not implement.</div>
            </section>

            <section>
              <h3>Tools / MCP whitelist</h3>
              {window.MCPS.map((m) => (
                <div key={m.id} className="A-mcp">
                  <span><b>{m.label}</b> <span style={{ color: '#9c8e6c', fontSize: 9.5 }}>· {m.desc}</span></span>
                  <span className={'A-toggle' + (selStep.mcps.includes(m.id) ? ' on' : '')}></span>
                </div>
              ))}
            </section>

            <section>
              <h3>Conditions</h3>
              <div style={{ fontSize: 10.5, color: '#6a5e44' }}>
                if <b style={{ color: '#1a1815' }}>verifier.passed === false</b><br/>
                  → loop to <b style={{ color: '#c96442' }}>implement</b> (max 3×)<br/>
                else → <b style={{ color: '#2d8a5b' }}>continue</b>
              </div>
            </section>
          </div>
        </div>}
      </div>
    </div>
  );
}

window.ABlueprint = ABlueprint;
