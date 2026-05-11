// Agent management dashboard — Warp-style 3-pane shell.
// Layout: [Agent list] | [Active workflow (top) + Running terminal (bottom)] | [Diff + file explorer]
// Active workflow is READ-ONLY. "Edit flow" button opens the Direction A blueprint editor in a modal.

const { useState, useEffect, useRef } = React;

const DASH_CSS = `
.D-root{font-family:'JetBrains Mono','SF Mono',ui-monospace,Menlo,monospace;color:#1a1815;height:100%;display:flex;flex-direction:column;background:#f5f1e8;}
.D-titlebar{height:38px;flex-shrink:0;display:flex;align-items:center;gap:14px;padding:0 14px;background:linear-gradient(#ebe4d2,#e1d8c0);border-bottom:1px solid #d8cfb8;}
.D-titlebar .D-traffic{display:flex;gap:7px;}
.D-titlebar .D-traffic span{width:11px;height:11px;border-radius:50%;display:block;}
.D-titlebar .D-search{flex:1;max-width:520px;margin:0 auto;background:#f5f1e8;border:1px solid #d8cfb8;height:22px;border-radius:4px;display:flex;align-items:center;padding:0 10px;font-size:11px;color:#9c8e6c;letter-spacing:.02em;}
.D-titlebar .D-iconbtn{width:24px;height:22px;display:flex;align-items:center;justify-content:center;color:#6a5e44;font-size:13px;cursor:pointer;border-radius:3px;}
.D-titlebar .D-iconbtn:hover{background:#f5f1e8;}
.D-body{flex:1;display:flex;min-height:0;}

/* Left rail — agent list */
.D-rail{width:208px;flex-shrink:0;border-right:1px solid #d8cfb8;background:#ebe4d2;display:flex;flex-direction:column;}
.D-rail-search{padding:10px 12px 8px;border-bottom:1px solid #d8cfb8;display:flex;gap:6px;align-items:center;}
.D-rail-search input{flex:1;font-family:inherit;font-size:11px;border:1px solid #d8cfb8;background:#f5f1e8;padding:5px 8px;color:#1a1815;border-radius:3px;}
.D-rail-search .D-newbtn{width:22px;height:22px;border:1px solid #d8cfb8;background:#f5f1e8;color:#1a1815;border-radius:3px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:14px;line-height:1;}
.D-rail-list{flex:1;overflow:auto;padding:6px 6px 12px;}
.D-rail-section{font-size:9px;letter-spacing:.18em;text-transform:uppercase;color:#9c8e6c;padding:10px 8px 6px;}
.D-tab{padding:8px 10px;border-radius:5px;cursor:pointer;display:flex;flex-direction:column;gap:3px;border-left:2px solid transparent;}
.D-tab:hover{background:#f5f1e8;}
.D-tab.on{background:#f5f1e8;border-left-color:#c96442;}
.D-tab .D-tab-head{display:flex;align-items:center;gap:6px;}
.D-tab .D-tab-head .D-status{width:7px;height:7px;border-radius:50%;flex-shrink:0;}
.D-status.running{background:#c96442;box-shadow:0 0 0 2px rgba(201,100,66,.18);}
.D-status.waiting{background:#d4a72c;}
.D-status.idle{background:#9c8e6c;}
.D-status.done{background:#2d8a5b;}
.D-tab .D-tab-title{flex:1;font-size:11.5px;font-weight:600;color:#1a1815;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;letter-spacing:-.005em;}
.D-tab .D-tab-sub{font-size:10px;color:#6a5e44;display:flex;align-items:center;gap:8px;padding-left:13px;}
.D-tab .D-tab-sub .D-branch{display:inline-flex;align-items:center;gap:3px;}
.D-tab.on .D-tab-title{color:#1a1815;}
.D-rail-foot{padding:8px 12px;border-top:1px solid #d8cfb8;display:flex;align-items:center;gap:8px;font-size:10.5px;color:#6a5e44;}
.D-rail-foot .D-avatar{width:22px;height:22px;border-radius:50%;background:#c96442;color:#fff;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;}

/* Center column */
.D-center{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0;}
.D-pane-head{height:34px;flex-shrink:0;display:flex;align-items:center;gap:10px;padding:0 14px;border-bottom:1px solid #d8cfb8;background:#ebe4d2;font-size:10.5px;letter-spacing:.06em;color:#6a5e44;}
.D-pane-head b{color:#1a1815;font-weight:700;letter-spacing:.18em;text-transform:uppercase;font-size:10px;}
.D-pane-head .D-spacer{flex:1;}
.D-pane-btn{font-family:inherit;font-size:10px;letter-spacing:.12em;text-transform:uppercase;border:1px solid #1a1815;background:#fff;color:#1a1815;padding:4px 9px;cursor:pointer;border-radius:0;}
.D-pane-btn:hover{background:#1a1815;color:#f5f1e8;}
.D-pane-btn.ghost{border-color:#d8cfb8;color:#6a5e44;background:transparent;}
.D-pane-btn.ghost:hover{background:#f5f1e8;color:#1a1815;border-color:#1a1815;}
.D-pane-btn .D-kbd{display:inline-block;margin-left:6px;font-size:9px;opacity:.55;letter-spacing:.04em;}

/* Active workflow pane (read-only) */
.D-flow{height:46%;flex-shrink:0;display:flex;flex-direction:column;border-bottom:1px solid #d8cfb8;background:#f5f1e8;position:relative;min-width:0;}
.D-flow-canvas{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0;background:
  linear-gradient(rgba(106,94,68,.06) 1px,transparent 1px) 0 0/24px 24px,
  linear-gradient(90deg,rgba(106,94,68,.06) 1px,transparent 1px) 0 0/24px 24px,
  #f5f1e8;}
.D-flow-meta{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:10px;letter-spacing:.02em;color:#6a5e44;padding:7px 12px 6px;background:#f5f1e8;border-bottom:1px dashed #d8cfb8;flex-shrink:0;}
.D-flow-meta>span{white-space:nowrap;}
.D-flow-meta b{color:#1a1815;font-weight:700;}
.D-flow-meta .D-runpill{padding:2px 8px;border:1px solid #c96442;color:#c96442;text-transform:uppercase;letter-spacing:.18em;font-size:9px;display:inline-flex;align-items:center;gap:5px;}
.D-flow-meta .D-runpill::before{content:'';width:6px;height:6px;border-radius:50%;background:#c96442;animation:D-pulse 1.4s infinite;}
@keyframes D-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.8)}}
.D-band-label{position:absolute;font-size:9px;letter-spacing:.18em;text-transform:uppercase;color:#6a5e44;top:38px;}
.D-svg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;}
.D-step{position:absolute;width:138px;border:1.4px solid #1a1815;background:#fff;}
.D-step-head{display:flex;justify-content:space-between;align-items:center;padding:4px 7px;color:#fff;font-size:9px;letter-spacing:.14em;text-transform:uppercase;}
.D-step-body{padding:6px 8px 7px;min-width:0;}
.D-step-name{font-size:10.5px;font-weight:600;color:#1a1815;line-height:1.25;letter-spacing:-.005em;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word;}
.D-step-meta{margin-top:5px;font-size:9.5px;color:#6a5e44;display:flex;justify-content:space-between;}
.D-step-foot{display:flex;align-items:center;gap:5px;padding:4px 8px;border-top:1px dashed #d8cfb8;font-size:8.5px;letter-spacing:.08em;color:#6a5e44;}
.D-step-foot .D-dot{width:5px;height:5px;border-radius:50%;background:#9c8e6c;}
.D-step.running{outline:2px solid #c96442;outline-offset:2px;}
.D-step.done .D-dot{background:#2d8a5b;}
.D-step.running .D-dot{background:#c96442;}
.D-step-head .D-opt{font-size:8.5px;letter-spacing:.14em;font-weight:700;background:rgba(255,255,255,.22);padding:1px 5px;border-radius:2px;}
.D-step.human{border-color:#a86b1d;box-shadow:0 0 0 1px #a86b1d;}
.D-step.human .D-step-head{background:repeating-linear-gradient(135deg,#d99a3d 0 6px,#c98a2d 6px 12px) !important;color:#fff;}
.D-step .D-human{position:absolute;top:-9px;right:-9px;width:22px;height:22px;border-radius:50%;background:#d99a3d;border:1.5px solid #1a1815;color:#1a1815;display:flex;align-items:center;justify-content:center;z-index:3;}
/* Pending: light grey, muted */
.D-step.pending{border-color:#d8cfb8;background:#efeadc;}
.D-step.pending .D-step-name{color:#9c8e6c;}
.D-step.pending .D-step-meta{color:#b3a685;}
.D-step.pending .D-step-foot{color:#b3a685;border-top-color:#e6dec7;}
.D-step.pending .D-step-head{filter:grayscale(.7);opacity:.55;}
.D-step.pending .D-dot{background:#c8bea3;}
/* Completed: frosted glass overlay + green check */
.D-step.done{position:absolute;}
.D-step.done::after{content:'';position:absolute;inset:0;background:rgba(245,241,232,.62);backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px);pointer-events:none;}
.D-step .D-check{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:30px;height:30px;border-radius:50%;background:#2d8a5b;color:#fff;display:none;align-items:center;justify-content:center;font-size:16px;font-weight:700;z-index:2;box-shadow:0 2px 6px rgba(45,138,91,.35);}
.D-step.done .D-check{display:flex;}

/* Workflow picker (idle state) */
.D-picker{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:36px;}
.D-picker-inner{width:100%;max-width:680px;}
.D-picker-h{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#9c8e6c;margin-bottom:6px;}
.D-picker-title{font-size:20px;font-weight:700;color:#1a1815;letter-spacing:-.01em;margin-bottom:18px;}
.D-picker-list{display:flex;flex-direction:column;gap:8px;}
.D-picker-item{display:flex;align-items:center;gap:14px;padding:14px 16px;background:#fff;border:1px solid #d8cfb8;cursor:pointer;transition:border-color .12s,box-shadow .12s;min-width:0;}
.D-picker-item>div:first-child{flex:1 1 0;min-width:200px;}
.D-picker-item:hover{border-color:#1a1815;box-shadow:0 2px 0 #1a1815;}
.D-picker-item.on{border-color:#c96442;box-shadow:inset 3px 0 0 #c96442;}
.D-picker-item .D-pi-name{font-size:13px;font-weight:700;color:#1a1815;letter-spacing:-.005em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.D-picker-item .D-pi-sub{font-size:11px;color:#6a5e44;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.D-picker-item .D-pi-meta{margin-left:auto;display:flex;align-items:center;gap:14px;font-size:10px;color:#9c8e6c;letter-spacing:.06em;flex-shrink:0;white-space:nowrap;}
.D-picker-item .D-pi-actions{display:flex;gap:6px;margin-left:14px;}
.D-picker-item .D-pi-tag{font-size:9px;letter-spacing:.18em;text-transform:uppercase;color:#c96442;border:1px solid #c96442;padding:1px 6px;}
.D-picker-cta{margin-top:14px;display:flex;gap:8px;align-items:center;}
.D-picker .D-pane-btn{padding:8px 14px;font-size:11px;}
.D-add{padding:13px 16px;border:1px dashed #9c8e6c;background:transparent;color:#6a5e44;cursor:pointer;font-family:inherit;font-size:12px;letter-spacing:.06em;text-align:left;display:flex;align-items:center;gap:10px;}
.D-add:hover{border-color:#1a1815;color:#1a1815;background:#fff;}
.D-add .plus{font-size:18px;line-height:1;}

/* Primary rail item (Human review) */
.D-primary{margin:6px 6px 0;padding:10px 12px;border:1px solid #d8cfb8;background:#f5f1e8;cursor:pointer;display:flex;align-items:center;gap:10px;border-radius:5px;}
.D-primary:hover{border-color:#1a1815;}
.D-primary.on{background:#fff;border-color:#1a1815;box-shadow:inset 3px 0 0 #c96442;}
.D-primary .D-pri-icon{width:22px;height:22px;flex-shrink:0;border-radius:50%;background:repeating-linear-gradient(135deg,#d99a3d 0 4px,#c98a2d 4px 8px);display:flex;align-items:center;justify-content:center;color:#fff;}
.D-primary .D-pri-label{flex:1;font-size:11.5px;font-weight:700;color:#1a1815;letter-spacing:-.005em;}
.D-primary .D-pri-sub{font-size:10px;color:#6a5e44;margin-top:1px;}
.D-primary .D-pri-badge{flex-shrink:0;font-size:10px;font-weight:700;color:#fff;background:#c96442;padding:1px 7px;border-radius:9px;letter-spacing:.02em;min-width:20px;text-align:center;}
.D-primary .D-pri-badge.zero{background:#9c8e6c;}

/* Human review pane */
.D-hr-wrap{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0;background:#f5f1e8;}
.D-hr-head{padding:18px 28px 10px;border-bottom:1px solid #d8cfb8;background:#ebe4d2;flex-shrink:0;}
.D-hr-eyebrow{font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:#9c8e6c;}
.D-hr-title{font-size:22px;font-weight:700;color:#1a1815;letter-spacing:-.01em;margin-top:4px;}
.D-hr-sub{font-size:12px;color:#6a5e44;margin-top:4px;display:flex;gap:14px;align-items:center;}
.D-hr-sub b{color:#1a1815;font-weight:700;}
.D-hr-body{flex:1;overflow:auto;padding:14px 28px 32px;}
.D-hr-group{margin-bottom:22px;}
.D-hr-ghead{display:flex;align-items:center;gap:10px;padding:10px 0 10px;border-bottom:1px dashed #d8cfb8;margin-bottom:10px;position:sticky;top:0;background:#f5f1e8;z-index:1;}
.D-hr-ghead .D-hr-gswatch{width:8px;height:14px;border-radius:1px;}
.D-hr-ghead .D-hr-gname{font-size:12px;font-weight:700;color:#1a1815;letter-spacing:.04em;}
.D-hr-ghead .D-hr-gcount{font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:#9c8e6c;}
.D-hr-ghead .D-hr-gcmd{font-family:'JetBrains Mono','SF Mono',ui-monospace,monospace;font-size:10.5px;color:#9c8e6c;letter-spacing:.02em;}
.D-hr-card{display:grid;grid-template-columns:auto 1fr auto;gap:14px;align-items:flex-start;background:#fff;border:1px solid #d8cfb8;padding:14px 16px;margin-bottom:8px;}
.D-hr-card:hover{border-color:#1a1815;}
.D-hr-card .D-hr-pill{font-size:9px;letter-spacing:.16em;text-transform:uppercase;color:#a86b1d;border:1px solid #a86b1d;padding:2px 7px;align-self:flex-start;font-weight:700;}
.D-hr-card .D-hr-pill.soft{color:#9c8e6c;border-color:#9c8e6c;}
.D-hr-card .D-hr-titlerow{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;}
.D-hr-card .D-hr-cardtitle{font-size:14px;font-weight:700;color:#1a1815;letter-spacing:-.005em;}
.D-hr-card .D-hr-cardstep{font-size:11px;color:#6a5e44;}
.D-hr-card .D-hr-cardstep b{color:#1a1815;font-weight:700;}
.D-hr-card .D-hr-meta{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:10.5px;color:#6a5e44;margin-top:6px;}
.D-hr-card .D-hr-meta b{color:#1a1815;font-weight:700;}
.D-hr-card .D-hr-meta .D-hr-pp{color:#2d8a5b;font-weight:700;}
.D-hr-card .D-hr-meta .D-hr-mm{color:#c96442;font-weight:700;}
.D-hr-card .D-hr-summary{font-size:12px;color:#1a1815;line-height:1.5;margin-top:8px;}
.D-hr-card .D-hr-actions{display:flex;flex-direction:column;gap:6px;align-items:flex-end;min-width:124px;}
.D-hr-card .D-hr-age{font-size:10px;letter-spacing:.06em;color:#9c8e6c;}
.D-hr-card .D-hr-actions button{font-family:inherit;font-size:10px;letter-spacing:.12em;text-transform:uppercase;border:1px solid #1a1815;background:#fff;color:#1a1815;padding:6px 12px;cursor:pointer;font-weight:700;width:100%;}
.D-hr-card .D-hr-actions button.primary{background:#1a1815;color:#f5f1e8;}
.D-hr-card .D-hr-actions button.primary:hover{background:#c96442;border-color:#c96442;}
.D-hr-card .D-hr-actions button.ghost{border-color:#d8cfb8;color:#6a5e44;}
.D-hr-card .D-hr-actions button.ghost:hover{border-color:#1a1815;color:#1a1815;}
.D-hr-empty{padding:60px 0;text-align:center;color:#9c8e6c;font-size:12px;}
.D-hr-empty b{color:#1a1815;display:block;font-size:14px;margin-bottom:6px;}

/* Right rail tabs */
.D-tabs button{flex:1;font-family:inherit;background:transparent;border:0;border-right:1px solid #d8cfb8;padding:9px 8px;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#9c8e6c;cursor:pointer;font-weight:700;}
.D-tabs button:last-child{border-right:0;}
.D-tabs button.on{background:#f5f1e8;color:#1a1815;box-shadow:inset 0 -2px 0 #c96442;}
.D-tabs button:hover:not(.on){color:#1a1815;}

/* Workflow progress feed */
.D-feed{flex:1;overflow:auto;padding:10px 14px 18px;}
.D-feed-phase{margin-bottom:14px;}
.D-feed-phead{display:flex;align-items:center;gap:8px;font-size:9px;letter-spacing:.18em;text-transform:uppercase;color:#9c8e6c;padding:6px 0;border-bottom:1px dashed #d8cfb8;margin-bottom:8px;}
.D-feed-pname{font-weight:700;color:#1a1815;}
.D-feed-step{padding:6px 0 6px 14px;border-left:2px solid #d8cfb8;margin-left:4px;position:relative;margin-bottom:8px;}
.D-feed-step.done{border-left-color:#2d8a5b;}
.D-feed-step.running{border-left-color:#c96442;}
.D-feed-step::before{content:'';position:absolute;left:-5px;top:10px;width:8px;height:8px;border-radius:50%;background:#d8cfb8;border:2px solid #f5f1e8;}
.D-feed-step.done::before{background:#2d8a5b;}
.D-feed-step.running::before{background:#c96442;animation:D-pulse 1.4s infinite;}
.D-feed-stepname{font-size:11.5px;font-weight:700;color:#1a1815;margin-bottom:4px;display:flex;align-items:center;gap:8px;}
.D-feed-stepname .D-feed-status{font-size:9px;letter-spacing:.16em;text-transform:uppercase;color:#9c8e6c;font-weight:600;}
.D-feed-step.done .D-feed-status{color:#2d8a5b;}
.D-feed-step.running .D-feed-status{color:#c96442;}
.D-feed-step.pending .D-feed-stepname{color:#9c8e6c;}
.D-feed-line{display:flex;gap:8px;font-size:11px;line-height:1.45;color:#6a5e44;padding:1px 0;}
.D-feed-line .D-feed-t{flex:0 0 42px;color:#9c8e6c;font-variant-numeric:tabular-nums;}
.D-feed-line.tool::before{content:'▸';color:#2d8a5b;flex-shrink:0;width:10px;}
.D-feed-line.edit::before{content:'✎';color:#d4a72c;flex-shrink:0;width:10px;}
.D-feed-line.note::before{content:'·';color:#9c8e6c;flex-shrink:0;width:10px;font-weight:700;}
.D-feed-line.done::before{content:'✓';color:#2d8a5b;flex-shrink:0;width:10px;}
.D-feed-line.running::before{content:'●';color:#c96442;flex-shrink:0;width:10px;animation:D-pulse 1.4s infinite;}


/* Terminal */
.D-term{flex:1;display:flex;flex-direction:column;background:#f5f1e8;min-height:0;}
.D-term-body{flex:1;overflow:auto;font-family:'JetBrains Mono','SF Mono',ui-monospace,monospace;font-size:11.5px;line-height:1.6;padding:10px 14px 18px;color:#1a1815;}
.D-term-line{display:flex;gap:8px;}
.D-term-line.tool::before{content:'●';color:#2d8a5b;flex-shrink:0;}
.D-term-line.msg::before{content:'●';color:#1a1815;flex-shrink:0;}
.D-term-line.cmd{color:#1a1815;font-weight:700;}
.D-term-line.out{color:#6a5e44;padding-left:14px;}
.D-term-line.sys{color:#9c8e6c;font-size:11px;}
.D-term-line .D-tooltag{font-weight:700;color:#1a1815;}
.D-term-line .D-toolarg{color:#6a5e44;}
.D-term-prompt{flex-shrink:0;display:flex;align-items:center;gap:10px;padding:8px 14px;border-top:1px solid #d8cfb8;background:#ebe4d2;font-size:11.5px;}
.D-term-prompt .D-arrow{color:#c96442;font-weight:700;}
.D-term-prompt .D-input{flex:1;color:#9c8e6c;font-style:italic;}
.D-term-prompt .D-model{padding:2px 7px;border:1px solid #d8cfb8;background:#f5f1e8;font-size:10px;color:#6a5e44;}
.D-term-prompt .D-progress{flex:0 0 80px;height:8px;background:#d8cfb8;position:relative;}
.D-term-prompt .D-progress::after{content:'';position:absolute;left:0;top:0;bottom:0;width:42%;background:#c96442;}
.D-term-prompt .D-pct{font-size:10px;color:#1a1815;font-weight:700;min-width:28px;text-align:right;}

/* Right rail — diff + file explorer */
.D-right{width:296px;flex-shrink:0;border-left:1px solid #d8cfb8;background:#ebe4d2;display:flex;flex-direction:column;}
.D-files{flex:0 0 auto;border-bottom:1px solid #d8cfb8;}
.D-file{display:flex;align-items:center;gap:8px;padding:6px 12px;font-size:10.5px;cursor:pointer;}
.D-file:hover{background:#f5f1e8;}
.D-file.on{background:#f5f1e8;}
.D-file .D-fst{width:14px;font-weight:700;text-align:center;font-size:10px;}
.D-file .D-fst.M{color:#d4a72c;}
.D-file .D-fst.A{color:#2d8a5b;}
.D-file .D-fst.D{color:#c96442;}
.D-file .D-fst.dot{color:#9c8e6c;}
.D-file .D-fpath{flex:1;color:#1a1815;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.D-file .D-fnums{display:inline-flex;gap:6px;font-size:10px;}
.D-file .D-fnums .p{color:#2d8a5b;}
.D-file .D-fnums .m{color:#c96442;}
.D-diff{flex:1;overflow:auto;background:#f5f1e8;}
.D-diff-head{padding:8px 12px;font-size:10.5px;color:#1a1815;font-weight:700;border-bottom:1px solid #d8cfb8;background:#ebe4d2;display:flex;align-items:center;gap:8px;}
.D-diff-head .D-pp{color:#2d8a5b;}
.D-diff-head .D-mm{color:#c96442;}
.D-diff-hunk{padding:4px 0;border-bottom:1px solid #e6dec7;}
.D-diff-hunkhead{font-size:10px;padding:3px 12px;color:#9c8e6c;background:#ebe4d2;border-bottom:1px dashed #d8cfb8;}
.D-diff-line{display:grid;grid-template-columns:28px 28px 1fr;font-size:11px;line-height:1.55;font-family:'JetBrains Mono','SF Mono',ui-monospace,monospace;}
.D-diff-line .gn{padding:0 6px;text-align:right;color:#9c8e6c;font-size:9.5px;line-height:inherit;}
.D-diff-line .D-text{padding:0 8px;white-space:pre;overflow:hidden;text-overflow:ellipsis;}
.D-diff-line.add{background:rgba(45,138,91,.12);}
.D-diff-line.add .D-text{color:#1a1815;}
.D-diff-line.add .D-text::before{content:'+ ';color:#2d8a5b;font-weight:700;}
.D-diff-line.del{background:rgba(201,100,66,.12);}
.D-diff-line.del .D-text::before{content:'− ';color:#c96442;font-weight:700;}
.D-diff-line.ctx .D-text::before{content:'  ';}

/* Modal — flow editor */
.D-modal-back{position:absolute;inset:0;background:rgba(26,24,21,.55);display:flex;align-items:stretch;justify-content:stretch;z-index:50;}
.D-modal{flex:1;margin:30px;background:#f5f1e8;border:1px solid #1a1815;box-shadow:0 30px 80px rgba(0,0,0,.45);display:flex;flex-direction:column;overflow:hidden;}
.D-modal-head{height:38px;flex-shrink:0;display:flex;align-items:center;gap:10px;padding:0 14px;background:#1a1815;color:#f5f1e8;font-size:10px;letter-spacing:.18em;text-transform:uppercase;}
.D-modal-head .D-mt{font-weight:700;}
.D-modal-head .D-spacer{flex:1;}
.D-modal-head button{font-family:inherit;font-size:10px;letter-spacing:.12em;text-transform:uppercase;background:transparent;border:1px solid #f5f1e8;color:#f5f1e8;padding:4px 10px;cursor:pointer;}
.D-modal-head button.primary{background:#c96442;border-color:#c96442;}
.D-modal-body{flex:1;min-height:0;display:flex;flex-direction:column;}
`;

if (!document.getElementById('D-css')) {
  const s = document.createElement('style');s.id = 'D-css';s.textContent = DASH_CSS;
  document.head.appendChild(s);
}

// Read-only flow visual derived from PHASES, drawn horizontally to fit a wide pane.
function FlowReadOnly({ session, t, running }) {
  // Lay out horizontally: phases are columns, steps stack vertically inside each phase.
  const phases = window.WORKFLOW_DEFS[session.workflow] || window.WORKFLOW_DEFS.soloflow;
  const allSteps = [];
  const layout = [];
  const COL_W = 138,COL_GAP = 14,ROW_H = 86,TOP = 28,LEFT = 14;
  let x = LEFT;
  phases.forEach((ph, pi) => {
    const col = { x, w: COL_W, label: ph.label.toUpperCase(), color: ph.color, steps: [] };
    ph.steps.forEach((s, si) => {
      const n = { ...s, phase: ph, x, y: TOP + si * ROW_H, w: COL_W };
      col.steps.push(n);
      allSteps.push(n);
    });
    layout.push(col);
    x += COL_W + COL_GAP;
  });

  // Token animation along linear sequence, biased to highlight current step from session.
  const currentIdx = running ? Math.max(0, allSteps.findIndex((s) => s.id === session.currentStepId)) : -1;
  const center = (s) => ({ cx: s.x + s.w / 2, cy: s.y + 30 });
  const edges = [];
  layout.forEach((col, ci) => {
    col.steps.forEach((s, si) => {
      if (si < col.steps.length - 1) edges.push({ from: s, to: col.steps[si + 1], kind: 'down' });
      if (s.loopback) {
        const tg = col.steps.find((x) => x.id === s.loopback);
        if (tg) edges.push({ from: s, to: tg, kind: 'loop' });
      }
    });
    if (ci < layout.length - 1) {
      const last = col.steps[col.steps.length - 1];
      const next = layout[ci + 1].steps[0];
      edges.push({ from: last, to: next, kind: 'across' });
    }
  });
  const path = (e) => {
    const a = center(e.from),b = center(e.to);
    if (e.kind === 'down') return `M ${a.cx} ${a.cy + 30} L ${a.cx} ${b.cy - 30}`;
    if (e.kind === 'across') {
      const ax = a.cx + e.from.w / 2,bx = b.cx - e.to.w / 2;
      return `M ${ax} ${a.cy} L ${bx} ${b.cy}`;
    }
    if (e.kind === 'loop') {
      const midX = a.cx + e.from.w / 2 + 12;
      return `M ${a.cx + e.from.w / 2} ${a.cy} L ${midX} ${a.cy} L ${midX} ${b.cy} L ${b.cx + e.to.w / 2} ${b.cy}`;
    }
  };
  // Animated token cycles in/around the running step
  const tt = t * 4 % 1;

  return (
    <div className="D-flow-canvas">
      <div className="D-flow-meta">
        <span><b>SPRINT-014</b> · {session.title}</span>
        <span>rev <b>0014</b></span>
        <span>elapsed <b>{session.elapsed}</b></span>
        <span>tokens <b>184k</b></span>
        <span>est <b>$0.42</b></span>
        {running && <span className="D-runpill">running</span>}
      </div>
      <div className="D-flow-inner" style={{ position: 'relative', flex: 1, overflow: 'auto', minHeight: 0 }}>
      {layout.map((col, i) =>
        <span key={i} className="D-band-label" style={{ left: col.x + 4, color: col.color }}>{col.label} / {String(i + 1).padStart(2, '0')}</span>
        )}
      <svg className="D-svg">
        <defs>
          <marker id="D-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0,0 L8,4 L0,8 z" fill="#1a1815" />
          </marker>
          <marker id="D-arrow-loop" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0,0 L8,4 L0,8 z" fill="#c96442" />
          </marker>
        </defs>
        {edges.map((e, i) =>
          <path key={i} d={path(e)} stroke={e.kind === 'loop' ? '#c96442' : '#1a1815'} strokeWidth={e.kind === 'loop' ? 1.2 : 1.4}
          strokeDasharray={e.kind === 'loop' ? '4 3' : '0'} fill="none"
          markerEnd={`url(#${e.kind === 'loop' ? 'D-arrow-loop' : 'D-arrow'})`} />
          )}
        {running && (() => {
            const cur = allSteps[currentIdx];
            const next = allSteps[Math.min(currentIdx + 1, allSteps.length - 1)];
            const a = center(cur),b = center(next);
            const tx = a.cx + (b.cx - a.cx) * tt;
            const ty = a.cy + (b.cy - a.cy) * tt;
            return <circle cx={tx} cy={ty} r="4" fill="#c96442" />;
          })()}
      </svg>
      {allSteps.map((s, i) => {
          const ag = window.AGENTS.find((a) => a.id === s.agent);
          const isRun = running && i === currentIdx;
          const isDone = running && i < currentIdx;
          const isPending = !running || i > currentIdx;
          const cls = ['D-step'];
          if (isRun) cls.push('running');
          if (isDone) cls.push('done');
          if (isPending) cls.push('pending');
          if (s.optional) cls.push('optional');
          if (s.human) cls.push('human');
          return (
            <div key={s.id} className={cls.join(' ')}
            style={{ left: s.x, top: s.y }}>
            <div className="D-step-head" style={{ background: s.phase.color }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span>{s.phase.label.slice(0, 3).toUpperCase()}</span>
                {s.optional && <span className="D-opt">OPTIONAL</span>}
              </span>
              <span style={{ opacity: .6 }}>{String(i + 1).padStart(2, '0')}</span>
            </div>
            <div className="D-step-body">
              <div className="D-step-name">{s.name}</div>
              <div className="D-step-meta"><span>{ag.name.split('-')[0]}</span><span>×{s.retries}</span></div>
            </div>
            <div className="D-step-foot">
              <span className="D-dot"></span>
              <span>{isRun ? 'RUNNING' : isDone ? 'DONE' : 'PENDING'}</span>
            </div>
            {s.human &&
              <span className="D-human" aria-label="human step">
                <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="6" cy="4" r="2"/><path d="M2 11c.4-2.3 2-3.5 4-3.5s3.6 1.2 4 3.5"/></svg>
              </span>
              }
            {isDone &&
              <span className="D-check" aria-label="completed">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 7.5l3 3 6-6" /></svg>
              </span>
              }
          </div>);

        })}
      </div>
    </div>);

}

function AgentRail({ activeId, setActive, sessions, hrCount }) {
  const groups = [
  { label: 'Active agents', items: sessions.filter((s) => s.status === 'running' || s.status === 'waiting') },
  { label: 'Idle', items: sessions.filter((s) => s.status === 'idle' || s.status === 'done') }];

  return (
    <div className="D-rail">
      <div className="D-rail-search">
        <input placeholder="Search agents…" />
        <button className="D-newbtn" title="New agent">+</button>
      </div>
      <div
        className={'D-primary' + (activeId === '__human_review' ? ' on' : '')}
        onClick={() => setActive('__human_review')}>
        <span className="D-pri-icon">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="6" cy="4" r="2"/><path d="M2 11c.4-2.3 2-3.5 4-3.5s3.6 1.2 4 3.5"/></svg>
        </span>
        <span style={{ flex: 1 }}>
          <div className="D-pri-label">Human review</div>
          <div className="D-pri-sub">Pending approvals</div>
        </span>
        <span className={'D-pri-badge' + (hrCount === 0 ? ' zero' : '')}>{hrCount}</span>
      </div>
      <div className="D-rail-list">
        {groups.map((g) =>
        <div key={g.label}>
            <div className="D-rail-section">{g.label} · {g.items.length}</div>
            {g.items.map((s) =>
          <div key={s.id} className={'D-tab' + (s.id === activeId ? ' on' : '')} onClick={() => setActive(s.id)}>
                <div className="D-tab-head">
                  <span className={'D-status ' + s.status}></span>
                  <span className="D-tab-title">{s.statusText}</span>
                </div>
                <div className="D-tab-sub">
                  <span className="D-branch">⌥ {s.branch}</span>
                  <span style={{ flex: 1 }}>{s.title}</span>
                </div>
              </div>
          )}
          </div>
        )}
      </div>
      <div className="D-rail-foot">
        <span className="D-avatar">JK</span>
        <span style={{ flex: 1 }}>kesteva</span>
        <span style={{ color: '#9c8e6c' }}>⚙</span>
      </div>
    </div>);

}

function Terminal({ session }) {
  return (
    <div className="D-term">
      <div className="D-pane-head">
        <b>Terminal</b>
        <span style={{ color: '#9c8e6c' }}>· {session.repo} · {session.branch}</span>
        <span className="D-spacer"></span>
        <button className="D-pane-btn ghost">Pause</button>
        <button className="D-pane-btn ghost">Interrupt</button>
        <button className="D-pane-btn ghost">⤢</button>
      </div>
      <div className="D-term-body">
        {window.TERMINAL.map((l, i) => {
          if (l.kind === 'spc') return <div key={i} style={{ height: 4 }}></div>;
          if (l.kind === 'tool') return (
            <div key={i} className="D-term-line tool">
              <span><span className="D-tooltag">{l.tool}</span><span className="D-toolarg">({l.text})</span></span>
            </div>);

          return <div key={i} className={'D-term-line ' + l.kind}><span>{l.text}</span></div>;
        })}
      </div>
      <div className="D-term-prompt">
        <span className="D-arrow">▸</span>
        <span className="D-input">deploy the edge function</span>
        <span className="D-progress"></span>
        <span className="D-pct">42%</span>
        <span className="D-model">{session.model}</span>
      </div>
    </div>);

}

function WorkflowProgressFeed({ session, allSteps, currentIdx }) {
  // Group steps by phase for the feed.
  const phases = window.WORKFLOW_DEFS[session.workflow] || window.WORKFLOW_DEFS.soloflow;
  const byPhase = phases.map((ph) => ({
    ph,
    steps: allSteps.filter((s) => s.phase.id === ph.id)
  }));
  return (
    <div className="D-feed">
      {byPhase.map(({ ph, steps }) =>
      <div key={ph.id} className="D-feed-phase">
          <div className="D-feed-phead">
            <span style={{ width: 8, height: 8, background: ph.color, borderRadius: 1 }}></span>
            <span className="D-feed-pname">{ph.label}</span>
            <span style={{ flex: 1 }}></span>
            <span>{steps.length} steps</span>
          </div>
          {steps.map((s) => {
          const idx = allSteps.indexOf(s);
          const status = idx < currentIdx ? 'done' : idx === currentIdx ? 'running' : 'pending';
          const log = window.STEP_LOG && window.STEP_LOG[s.id] || [];
          const ag = window.AGENTS.find((a) => a.id === s.agent);
          return (
            <div key={s.id} className={'D-feed-step ' + status}>
                <div className="D-feed-stepname">
                  <span>{s.name}</span>
                  <span className="D-feed-status">{status === 'done' ? '✓ done' : status === 'running' ? '● running' : 'pending'}</span>
                  <span style={{ flex: 1 }}></span>
                  <span style={{ fontSize: 10, color: '#9c8e6c', fontWeight: 500 }}>{ag.name}</span>
                </div>
                {status !== 'pending' && log.map((ln, i) =>
              <div key={i} className={'D-feed-line ' + ln.kind}>
                    <span className="D-feed-t">{ln.t}</span>
                    <span>{ln.text}</span>
                  </div>
              )}
                {status === 'pending' &&
              <div className="D-feed-line" style={{ color: '#b3a685', fontStyle: 'italic' }}>
                    <span className="D-feed-t"></span>
                    <span>Waiting · {ag.model}</span>
                  </div>
              }
              </div>);

        })}
        </div>
      )}
    </div>);

}

function FilesAndDiff({ session, allSteps, currentIdx, progressOnly = false }) {
  const [tab, setTab] = useState('progress');
  const [active, setActive] = useState(window.DIFF_PREVIEW.file);
  if (progressOnly) {
    return (
      <div className="D-right">
        <div className="D-tabs">
          <button className="on">Workflow steps</button>
        </div>
        <WorkflowProgressFeed session={session} allSteps={allSteps} currentIdx={currentIdx} />
      </div>
    );
  }
  return (
    <div className="D-right">
      <div className="D-tabs">
        <button className={tab === 'progress' ? 'on' : ''} onClick={() => setTab('progress')}>Workflow progress</button>
        <button className={tab === 'files' ? 'on' : ''} onClick={() => setTab('files')}>File explorer</button>
        <button className={tab === 'diff' ? 'on' : ''} onClick={() => setTab('diff')}>Diff</button>
      </div>
      {tab === 'progress' &&
      <WorkflowProgressFeed session={session} allSteps={allSteps} currentIdx={currentIdx} />
      }
      {tab === 'files' &&
      <div className="D-files" style={{ flex: 1, overflow: 'auto', borderBottom: 0, paddingTop: 6 }}>
          {window.FILES.map((f) =>
        <div key={f.path} className={'D-file' + (f.path === active ? ' on' : '')} onClick={() => {setActive(f.path);setTab('diff');}}>
              <span className={'D-fst ' + (f.status === '·' ? 'dot' : f.status)}>{f.status}</span>
              <span className="D-fpath">{f.path}</span>
              {f.plus + f.minus > 0 &&
          <span className="D-fnums"><span className="p">+{f.plus}</span><span className="m">−{f.minus}</span></span>
          }
            </div>
        )}
        </div>
      }
      {tab === 'diff' &&
      <div className="D-diff">
          <div className="D-diff-head">
            <span>{window.DIFF_PREVIEW.file.split('/').pop()}</span>
            <span className="D-pp">+{window.FILES.find((f) => f.path === window.DIFF_PREVIEW.file).plus}</span>
            <span className="D-mm">−{window.FILES.find((f) => f.path === window.DIFF_PREVIEW.file).minus}</span>
            <span style={{ flex: 1 }}></span>
            <span style={{ color: '#9c8e6c', fontWeight: 400, fontSize: 10 }}>{window.DIFF_PREVIEW.file.split('/').slice(0, -1).join('/')}</span>
          </div>
          {window.DIFF_PREVIEW.hunks.map((h, i) =>
        <div key={i} className="D-diff-hunk">
              <div className="D-diff-hunkhead">{h.header}</div>
              {h.lines.map((ln, j) =>
          <div key={j} className={'D-diff-line ' + ln.kind}>
                  <span className="gn">{ln.n1}</span>
                  <span className="gn">{ln.n2}</span>
                  <span className="D-text">{ln.text}</span>
                </div>
          )}
            </div>
        )}
        </div>
      }
    </div>);

}

function FlowEditorModal({ onClose, startConfirming = false, workflowId = 'soloflow' }) {
  const wf = window.WORKFLOWS.find((w) => w.id === workflowId) || window.WORKFLOWS[0];
  const phases = window.WORKFLOW_DEFS[wf.id];
  const firstStepId = phases[0] && phases[0].steps[0] && phases[0].steps[0].id;
  const [selected, setSelected] = useState(firstStepId);
  const [saveMenuOpen, setSaveMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState(startConfirming);
  const stepCount = phases.reduce((n, p) => n + p.steps.length, 0);
  const humanCount = phases.reduce((n, p) => n + p.steps.filter((s) => s.human).length, 0);
  useEffect(() => {
    if (!saveMenuOpen) return;
    const close = () => setSaveMenuOpen(false);
    document.addEventListener('pointerdown', close, true);
    return () => document.removeEventListener('pointerdown', close, true);
  }, [saveMenuOpen]);
  return (
    <div className="D-modal-back" onClick={onClose}>
      <div className="D-modal" onClick={(e) => e.stopPropagation()}>
        <div className="D-modal-head">
          <span className="D-mt">Edit workflow · {wf.command} · {wf.id}.yaml</span>
          <span style={{ color: 'rgba(245,241,232,.55)' }}>rev 0014 → draft</span>
          <span className="D-spacer"></span>
          {!confirming && <button onClick={onClose}>Cancel</button>}
          {!confirming && <div style={{ position: 'relative' }} onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setSaveMenuOpen((o) => !o)}>Save ▾</button>
            {saveMenuOpen &&
            <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, background: '#1a1815', border: '1px solid rgba(245,241,232,.18)', boxShadow: '0 12px 32px rgba(0,0,0,.45)', minWidth: 200, zIndex: 5 }}>
                <button style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 14px', background: 'transparent', border: 'none', color: '#f5f1e8', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11, letterSpacing: '.04em' }}>Save as new flow</button>
                <button style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 14px', background: 'transparent', border: 'none', color: '#f5f1e8', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11, letterSpacing: '.04em', borderTop: '1px solid rgba(245,241,232,.1)' }}>Update existing flow</button>
              </div>
            }
          </div>}
          {!confirming && <button className="primary" onClick={() => setConfirming(true)}>Run with modifications</button>}
          {confirming && <button onClick={onClose}>Cancel</button>}
          {confirming && <button onClick={onClose}>Save</button>}
        </div>
        <div className="D-modal-body" style={{ position: 'relative' }}>
          <ABlueprint selected={selected} setSelected={setSelected} running={false} t={0} inspectorClosed={confirming} hideToolbarPills={confirming} workflowId={wf.id} />
          {confirming &&
          <div style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 96, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10, pointerEvents: 'none' }}>
              <div style={{ width: 520, background: '#f5f1e8', border: '1px solid #1a1815', boxShadow: '0 30px 80px rgba(0,0,0,.35)', padding: '24px 28px', pointerEvents: 'auto' }}>
                <div style={{ fontSize: 10, letterSpacing: '.18em', color: '#9c8e6c', textTransform: 'uppercase', marginBottom: 6 }}>Ready to run</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: '#1a1815', letterSpacing: '-.01em', marginBottom: 4 }}>{wf.id} · draft</div>
                <div style={{ fontSize: 12, color: '#6a5e44', marginBottom: 16 }}>{stepCount} steps · {phases.length} phases · {humanCount} human checkpoint{humanCount === 1 ? '' : 's'}</div>
                <div style={{ background: '#fff', border: '1px solid #d8cfb8', padding: '12px 14px', marginBottom: 16, fontSize: 11, color: '#1a1815', lineHeight: 1.7, fontVariantNumeric: 'tabular-nums' }}>
                  {phases.map((p) => {
                    const hasLoop = p.steps.some((s) => s.loopback);
                    return (
                      <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: p.color, letterSpacing: '.14em' }}>{p.label.toUpperCase()}</span>
                        <span style={{ color: '#9c8e6c' }}>{p.steps.length} step{p.steps.length === 1 ? '' : 's'}{hasLoop ? ' · loops up to 3×' : ''}</span>
                      </div>
                    );
                  })}
                </div>
                <div style={{ fontSize: 11, color: '#6a5e44' }}>Estimated cost <b style={{ color: '#1a1815' }}>~$2.40</b> · ~12 min · ~190k tokens</div>
              </div>
            </div>
          }
          {confirming &&
          <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 96, background: '#1a1815', borderTop: '1px solid #1a1815', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12, padding: '0 28px', zIndex: 11 }}>
              <button onClick={() => setConfirming(false)}
                style={{ fontFamily: 'inherit', fontSize: 13, letterSpacing: '.12em', textTransform: 'uppercase', fontWeight: 600, padding: '14px 28px', background: 'transparent', border: '1px solid rgba(245,241,232,.4)', color: '#f5f1e8', cursor: 'pointer' }}>
                Modify
              </button>
              <button onClick={onClose}
                style={{ fontFamily: 'inherit', fontSize: 13, letterSpacing: '.12em', textTransform: 'uppercase', fontWeight: 700, padding: '14px 36px', background: '#c96442', border: '1px solid #c96442', color: '#f5f1e8', cursor: 'pointer' }}>
                Run
              </button>
            </div>
          }
        </div>
      </div>
    </div>);

}

function WorkflowPicker({ onEdit, onChoose, picked, setPicked }) {
  return (
    <div className="D-picker">
      <div className="D-picker-inner">
        <div className="D-picker-h">No active sprint</div>
        <div className="D-picker-title">Choose a workflow to start</div>
        <div className="D-picker-list">
          {window.WORKFLOWS.map((w) =>
          <div key={w.id} className={'D-picker-item' + (picked === w.id ? ' on' : '')} onClick={() => setPicked(w.id)}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="D-pi-name">{w.name}</span>
                  {w.isDefault && <span className="D-pi-tag">default</span>}
                </div>
                <div className="D-pi-sub">{w.subtitle}</div>
                {w.command && <div style={{ fontSize: 10, color: '#9c8e6c', fontFamily: 'ui-monospace, Menlo, monospace', marginTop: 4, letterSpacing: '.02em' }}>{w.command}</div>}
              </div>
              <div className="D-pi-meta">
                <span>{w.steps} STEPS · {w.phases} {w.phases === 1 ? 'PHASE' : 'PHASES'}</span>
                <span>USED {w.lastUsed.toUpperCase()}</span>
              </div>
              <div className="D-pi-actions" onClick={(e) => e.stopPropagation()}>
                <button className="D-pane-btn ghost" onClick={() => onEdit(w.id)}>Edit</button>
              </div>
            </div>
          )}
        </div>
        <div className="D-picker-cta">
          <button className="D-pane-btn" onClick={() => onChoose(picked)}>Run {window.WORKFLOWS.find((w) => w.id === picked).command}</button>
          <span style={{ flex: 1 }}></span>
          <span style={{ fontSize: 10, color: '#9c8e6c', letterSpacing: '.06em' }}>or paste a prompt to begin</span>
        </div>
      </div>
    </div>);

}

function HumanReviewPane({ queue, onJump }) {
  // Group by workflow id; preserve workflow order from window.WORKFLOWS so the
  // grouping always reads in the same canonical order regardless of queue order.
  const order = window.WORKFLOWS.map((w) => w.id);
  const grouped = order.map((wfId) => {
    const wf = window.WORKFLOWS.find((w) => w.id === wfId);
    const items = queue.filter((q) => q.workflow === wfId);
    if (!items.length) return null;
    // Look up phase color from WORKFLOW_DEFS by phase label match.
    const phases = window.WORKFLOW_DEFS[wfId] || [];
    const colorFor = (phaseLabel) => {
      const ph = phases.find((p) => p.label === phaseLabel);
      return ph ? ph.color : '#9c8e6c';
    };
    return { wf, items, colorFor };
  }).filter(Boolean);

  const blocking = queue.filter((q) => q.blocking).length;

  return (
    <div className="D-hr-wrap">
      <div className="D-hr-head">
        <div className="D-hr-eyebrow">Pending checkpoints</div>
        <div className="D-hr-title">Human review</div>
        <div className="D-hr-sub">
          <span><b>{queue.length}</b> total</span>
          <span><b style={{ color: '#c96442' }}>{blocking}</b> blocking a sprint</span>
          <span style={{ flex: 1 }}></span>
          <span style={{ fontSize: 10, letterSpacing: '.12em', textTransform: 'uppercase', color: '#9c8e6c' }}>Sorted by age</span>
        </div>
      </div>
      <div className="D-hr-body">
        {grouped.length === 0 &&
          <div className="D-hr-empty">
            <b>No pending reviews</b>
            All workflows are unblocked. New checkpoints land here as agents pause.
          </div>
        }
        {grouped.map(({ wf, items, colorFor }) =>
          <div key={wf.id} className="D-hr-group">
            <div className="D-hr-ghead">
              <span className="D-hr-gswatch" style={{ background: '#c96442' }}></span>
              <span className="D-hr-gname">{wf.name}</span>
              <span className="D-hr-gcount">{items.length} pending</span>
              <span style={{ flex: 1 }}></span>
              <span className="D-hr-gcmd">{wf.command}</span>
            </div>
            {items.map((it) =>
              <div key={it.id} className="D-hr-card">
                <span className={'D-hr-pill' + (it.blocking ? '' : ' soft')} style={it.blocking ? {} : {}}>
                  {it.blocking ? 'Blocking' : 'Optional'}
                </span>
                <div style={{ minWidth: 0 }}>
                  <div className="D-hr-titlerow">
                    <span className="D-hr-cardtitle">{it.title}</span>
                    <span className="D-hr-cardstep">
                      <span style={{ color: colorFor(it.phase), letterSpacing: '.14em', textTransform: 'uppercase', fontSize: 10, fontWeight: 700, marginRight: 6 }}>{it.phase}</span>
                      · <b>{it.stepName}</b>
                    </span>
                  </div>
                  <div className="D-hr-meta">
                    <span><b>{it.repo}</b> · {it.branch}</span>
                    {it.files > 0 && <span>{it.files} file{it.files === 1 ? '' : 's'}</span>}
                    {(it.diffPlus + it.diffMinus) > 0 &&
                      <span><span className="D-hr-pp">+{it.diffPlus}</span> <span className="D-hr-mm">−{it.diffMinus}</span></span>
                    }
                    <span>since {it.waitingSince}</span>
                    <span style={{ fontFamily: "'JetBrains Mono', 'SF Mono', ui-monospace, monospace", color: '#9c8e6c' }}>session {it.sessionId}</span>
                  </div>
                  <div className="D-hr-summary">{it.summary}</div>
                </div>
                <div className="D-hr-actions">
                  <span className="D-hr-age">{it.age} ago</span>
                  {it.decisions.map((d, i) =>
                    <button key={d} className={i === 0 ? 'primary' : (d === 'Reject' ? 'ghost' : '')}>
                      {d}
                    </button>
                  )}
                  <button className="ghost" onClick={() => onJump(it.sessionId)} style={{ marginTop: 2 }}>Open session →</button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Dashboard() {
  const [activeId, setActiveId] = useState('s1');
  const [editing, setEditing] = useState(false);
  const [confirmingRun, setConfirmingRun] = useState(false);
  const [editWorkflowId, setEditWorkflowId] = useState(window.SELECTED_WORKFLOW || 'soloflow');
  const [, forceTick] = useState(0);
  const pickWorkflow = (id) => {
    window.selectWorkflow(id);
    setEditWorkflowId(id);
    forceTick((v) => v + 1);
  };
  const [pickerSel, setPickerSel] = useState(window.SELECTED_WORKFLOW || 'soloflow');
  const session = window.SESSIONS.find((s) => s.id === activeId) || window.SESSIONS[0];
  const isHumanReview = activeId === '__human_review';
  const isIdle = !isHumanReview && session.status === 'idle';
  const isRunning = !isHumanReview && (session.status === 'running' || session.status === 'waiting');

  // Time ticker for token animation
  const [t, setT] = useState(0);
  useEffect(() => {
    let raf;
    let last = performance.now();
    const tick = (now) => {
      const dt = (now - last) / 1000;last = now;
      setT((v) => (v + dt * 0.18) % 1);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Keyboard: ⌘E opens editor
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'e') {e.preventDefault();setEditing(true);}
      if (e.key === 'Escape') setEditing(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="D-root">
      <div className="D-titlebar">
        <div className="D-traffic">
          <span style={{ background: '#ff5f57' }}></span>
          <span style={{ background: '#febc2e' }}></span>
          <span style={{ background: '#28c840' }}></span>
        </div>
        <span className="D-iconbtn">▤</span>
        <span className="D-iconbtn">⌥</span>
        <span className="D-iconbtn">▦</span>
        <span className="D-search">⌕  Search sessions, agents, files…</span>
        <span className="D-iconbtn">⤢</span>
        <span className="D-iconbtn">◷</span>
      </div>
      <div className="D-body">
        <AgentRail activeId={activeId} setActive={setActiveId} sessions={window.SESSIONS} hrCount={(window.HUMAN_REVIEW_QUEUE || []).length} />
        {isHumanReview ? (
          <div className="D-center" style={{ borderRight: 'none' }}>
            <HumanReviewPane queue={window.HUMAN_REVIEW_QUEUE || []} onJump={(sid) => setActiveId(sid)} />
          </div>
        ) : (
          <>
            <div className="D-center">
              <div className="D-flow" style={isIdle ? { height: '100%', borderBottom: 0 } : {}}>
            <div className="D-pane-head">
              <b>{isIdle ? 'Workflows' : 'Active workflow'}</b>
              <span style={{ color: '#9c8e6c' }}>{isIdle ? '· choose to begin' : '· ' + ((window.WORKFLOWS.find((w) => w.id === session.workflow) || {}).command || '/soloflow') + ' · ' + (session.workflow || 'soloflow') + '.yaml'}</span>
              <span className="D-spacer"></span>
              {!isIdle && <button className="D-pane-btn ghost">History</button>}
              {isRunning && <button className="D-pane-btn ghost">Pause</button>}
              {!isRunning && !isIdle &&
              <button className="D-pane-btn" onClick={() => setEditing(true)}>
                  Edit flow<span className="D-kbd">⌘E</span>
                </button>
              }
            </div>
            {isIdle ?
            <WorkflowPicker
              picked={pickerSel} setPicked={setPickerSel}
              onEdit={(id) => { pickWorkflow(id); setEditing(true); }}
              onChoose={(id) => { pickWorkflow(id); setConfirmingRun(true); setEditing(true); }}
            /> :
            <FlowReadOnly session={session} t={t} running={isRunning} />}
          </div>
          {!isIdle && <Terminal session={session} />}
        </div>
        <FilesAndDiff session={isIdle ? { ...session, workflow: pickerSel } : session} allSteps={(window.WORKFLOW_DEFS[isIdle ? pickerSel : session.workflow] || window.WORKFLOW_DEFS.soloflow).flatMap((ph) => ph.steps.map((s) => ({ ...s, phase: ph })))}
        currentIdx={isRunning ? Math.max(0, (window.WORKFLOW_DEFS[session.workflow] || window.WORKFLOW_DEFS.soloflow).flatMap((ph) => ph.steps).findIndex((s) => s.id === session.currentStepId)) : -1} progressOnly={isIdle} />
          </>
        )}
      </div>
      {editing && <FlowEditorModal onClose={() => { setEditing(false); setConfirmingRun(false); }} startConfirming={confirmingRun} workflowId={editWorkflowId} />}
    </div>);

}

window.Dashboard = Dashboard;