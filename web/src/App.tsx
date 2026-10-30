import { useCallback, useEffect, useState } from 'react';
import GraphCanvas from './GraphCanvas.js';
import type { StateResponse, Metrics, AIInfo, TimelineEvent, RecoverySummary } from './types.js';

const API = {
  async state(): Promise<StateResponse> { return fetch('/api/state').then((r) => r.json()); },
  async post(path: string, body?: unknown): Promise<Response> {
    return fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  },
};

type Selection = { kind: 'node' | 'edge'; id: string } | null;

export default function App() {
  const [state, setState] = useState<StateResponse | null>(null);
  const [selected, setSelected] = useState<Selection>(null);
  const [lastRec, setLastRec] = useState<RecoverySummary | null>(null);
  const [flashIds, setFlashIds] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await API.state();
      setState(s);
    } catch { setErr('API unreachable — is the backend running?'); }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2500);
    return () => clearInterval(t);
  }, [refresh]);

  const act = async (key: string, path: string, body?: unknown): Promise<void> => {
    setBusy(key); setErr(null);
    try {
      const res = await API.post(path, body);
      if (!res.ok) {
        const j = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        setErr(`action ${key}: ${j.error ?? res.status}`);
      } else if (path === '/api/recover') {
        const j = await res.json() as RecoverySummary;
        setLastRec(j);
        setFlashIds(j.ok && j.plan.actions.length
          ? j.plan.actions.map((a) => a.edgeId ?? '').filter(Boolean)
          : []);
      }
    } catch (e) {
      setErr(`action ${key}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
      refresh();
    }
  };

  if (!state) return <div className="app"><div className="loading">Connecting to the digital twin…</div></div>;

  const m = state.metrics;
  const h = state.healthyBaseline;
  const damagedNow = state.incident !== null;
  const ai = state.lastAI;

  return (
    <div className="app">
      <Header state={state} />
      {err && <div className="error-banner">{err}</div>}
      <Toolbar
        state={state} selected={selected} busy={busy}
        onSelect={setSelected}
        act={act}
      />
      <div className="main">
        <div className="col graph-col">
          <GraphCanvas
            nodes={state.topology.nodes}
            edges={state.topology.edges}
            bridgeIds={m.bridgeEdgeIds}
            selected={selected}
            onSelect={setSelected}
            flashEdgeIds={flashIds}
          />
          <div className="hint" style={{ padding: '6px 14px' }}>
            click a node/link to select · cyan = selected · amber = bridge/candidate · red-dashed = failed · flash = applied repair
          </div>
        </div>
        <div className="col">
          <div className="panel">
            <h3>Live resilience metrics {damagedNow && <span className="chip bad">incident</span>}</h3>
            <MetricsGrid m={m} h={h} />
          </div>
          <ComparisonPanel rec={state.lastRecovery} />
          <RecoveryPanel rec={lastRec} />
          <AIPanel ai={ai} enabled={state.ai.enabled} />
          <TimelinePanel events={state.timeline} />
        </div>
      </div>
    </div>
  );
}

/* ---------------- header ---------------- */

function Header({ state }: { state: StateResponse }) {
  const ai = state.ai;
  const lastMode = state.lastAI?.mode;
  return (
    <>
      <div className="header">
        <div className="brand">AETHER-NIM <span className="dim">/ autonomous spectral network resilience twin</span></div>
        <div className="spacer" />
        <span className={`chip ${lastMode === 'real' ? 'real' : lastMode === 'fallback' ? 'fallback' : ''}`}>
          inference: {ai.enabled ? `${ai.model}` : 'disabled'}
        </span>
        <span className={`chip ${lastMode === 'real' ? 'real' : lastMode === 'fallback' ? 'fallback' : ''}`}>
          last AI stage: {lastMode === 'real' ? 'REAL token-factory call' : lastMode === 'fallback' ? 'deterministic fallback' : '—'}
        </span>
        <span className="chip">scenario: {state.scenario.name}</span>
      </div>
    </>
  );
}

/* ---------------- toolbar ---------------- */

interface ToolbarProps {
  state: StateResponse;
  selected: Selection;
  busy: string | null;
  onSelect: (s: Selection) => void;
  act: (key: string, path: string, body?: unknown) => Promise<void>;
}

function Toolbar({ state, selected, busy, act }: ToolbarProps) {
  const disableAll = !!busy;
  return (
    <div className="toolbar">
      <select
        value={state.scenario.id}
        onChange={(e) => act('scenario', '/api/scenario', { id: e.target.value })}
        disabled={disableAll}
      >
        {state.scenario.scenarios.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>

      <select
        value=""
        onChange={(e) => { if (e.target.value) act('preset:' + e.target.value, '/api/damage-preset', { id: e.target.value }); e.target.value = ''; }}
        disabled={disableAll}
      >
        <option value="">— inject damage preset —</option>
        {state.scenario.damagePresets.map((p) => <option key={p} value={p}>{p}</option>)}
      </select>

      <button
        disabled={disableAll || !selected}
        onClick={() => {
          if (!selected) return;
          if (selected.kind === 'node') act('failNode', '/api/inject', { kind: 'failNode', id: selected.id });
          else act('failEdge', '/api/inject', { kind: 'failEdge', id: selected.id });
        }}
      >✕ Fail selected ({selected ? selected.id : 'none'})</button>

      <button
        disabled={disableAll || !selected || selected.kind !== 'edge'}
        onClick={() => selected && act('degrade', '/api/inject', { kind: 'degradeEdge', id: selected.id, latencyFactor: 4 })}
      >⚡ Degrade latency ×4</button>

      <button
        disabled={disableAll || !selected}
        onClick={() => {
          if (!selected) return;
          act('restore', '/api/restore', { kind: selected.kind, id: selected.id });
        }}
      >✔ Restore selected</button>

      <span className="spacer" />

      <button
        className="primary"
        disabled={disableAll}
        onClick={() => act('diagnose', '/api/diagnose')}
      >{busy === 'diagnose' ? '…diagnosing' : '1 · Diagnose (measure + Nemotron)'}</button>

      <button
        className="primary"
        disabled={disableAll}
        onClick={() => act('recover', '/api/recover')}
      >{busy === 'recover' ? '…executing closed loop' : '2 · Run recovery cycle'}</button>

      <button className="danger" disabled={disableAll} onClick={() => act('reset', '/api/reset')}>Reset scenario</button>
      <span className="hint">{selected ? `${selected.kind} ${selected.id}` : 'no selection'}</span>
    </div>
  );
}

/* ---------------- metrics ---------------- */

function fmt(v: number | null | undefined, digits = 2, unit = ''): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const s = v.toFixed(digits);
  return unit ? `${s} ${unit}` : s;
}

function MetricsGrid({ m, h }: { m: Metrics; h: Metrics }) {
  const lamDelta = (m.algebraicConnectivity ?? 0) - (h.algebraicConnectivity ?? 0);
  return (
    <div className="metrics">
      <Metric k="λ₂ algebraic connectivity" v={fmt(m.algebraicConnectivity, 3)} cls={m.algebraicConnectivity && m.algebraicConnectivity > (h.algebraicConnectivity ?? 0) * 0.9 ? 'good' : m.algebraicConnectivity && m.algebraicConnectivity > 0.05 ? 'warn' : 'bad'}
        sub={`healthy ${fmt(h.algebraicConnectivity, 3)} · Δ ${fmt(lamDelta, 3)}`} />
      <Metric k="components" v={String(m.components)} cls={m.components === h.components ? 'good' : 'bad'} sub={`isolated ${m.isolatedNodes} · LCC ${m.largestComponentSize}`} />
      <Metric k="active topology" v={`${m.activeNodes}n ${m.activeEdges}e`} sub={`of ${m.nodeCount} nodes`} />
      <Metric k="avg shortest path" v={fmt(m.avgShortestPathLatencyMs, 2, 'ms')} sub={`diameter ${fmt(m.diameterMs, 0, 'ms')} · healthy ${fmt(h.avgShortestPathLatencyMs, 1, 'ms')}`} />
      <Metric k="demand pairs served" v={`${m.servedDemandPairs}/${m.totalDemandPairs}`} cls={m.servedDemandPairs === m.totalDemandPairs ? 'good' : 'warn'} />
      <Metric k="routed throughput" v={fmt(m.routedMbps, 0, 'Mbps')} sub={`healthy ${fmt(h.routedMbps, 0, 'Mbps')}`} cls={m.routedMbps >= h.routedMbps * 0.9 ? 'good' : 'bad'} />
    </div>
  );
}

function Metric({ k, v, sub, cls }: { k: string; v: string; sub?: string; cls?: string }) {
  return (
    <div className="metric">
      <div className="k">{k}</div>
      <div className={`v ${cls ?? ''}`}>{v}</div>
      {sub && <div className="k" style={{ marginTop: 3, textTransform: 'none' }}>{sub}</div>}
    </div>
  );
}

/* ---------------- before/after comparison ---------------- */

function ComparisonPanel({ rec }: { rec: StateResponse['lastRecovery'] }) {
  const v = rec?.verification ?? null;
  const rows: { k: string; before?: number | null; after?: number | null; good?: boolean }[] = [];
  if (v) {
    rows.push(
      { k: 'components', before: v.before.components, after: v.after.components, good: v.after.components <= v.before.components },
      { k: 'λ₂', before: v.before.algebraicConnectivity, after: v.after.algebraicConnectivity, good: (v.after.algebraicConnectivity ?? 0) >= (v.before.algebraicConnectivity ?? 0) },
      { k: 'avg latency (ms)', before: v.before.avgShortestPathLatencyMs, after: v.after.avgShortestPathLatencyMs, good: (v.after.avgShortestPathLatencyMs ?? 0) <= (v.before.avgShortestPathLatencyMs ?? 0) },
      { k: 'routed (Mbps)', before: v.before.routedMbps, after: v.after.routedMbps, good: v.after.routedMbps >= v.before.routedMbps },
      { k: 'served pairs', before: v.before.servedDemandPairs, after: v.after.servedDemandPairs, good: v.after.servedDemandPairs >= v.before.servedDemandPairs },
    );
  }
  return (
    <div className="panel">
      <h3>Damaged → recovered (independently verified)</h3>
      {v ? (
        <table className="compare">
          <thead><tr><th>metric</th><th>damaged</th><th>recovered</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.k}>
                <td>{r.k}</td>
                <td className="same">{fmt(r.before, 3)}</td>
                <td className={r.good ? 'better' : 'worse'}>{fmt(r.after, 3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="hint">run the recovery cycle to populate verified before/after measurements</div>
      )}
      {v && (
        <div className={`verdict ${v.success ? 'ok' : 'fail'}`}>
          verifier: {v.success ? 'SUCCESS' : 'FAILED'} · cost {v.planCost} · {v.wallMs}ms · Δλ₂={fmt(v.deltaLambda2, 3)}
          {!v.success && <div>{v.reasons.join(' · ')}</div>}
        </div>
      )}
    </div>
  );
}

/* ---------------- recovery trace (explainability) ---------------- */

function RecoveryPanel({ rec }: { rec: RecoverySummary | null }) {
  if (!rec) return <div className="panel"><h3>Recovery trace</h3><div className="hint">no recovery executed yet</div></div>;
  const p = rec.plan;
  return (
    <div className="panel">
      <h3>Recovery trace · planner {p.source} · {p.iterations} greedy iteration(s)</h3>
      <div className="trace">
        {rec.ok && (
          <div className="step ok">
            OUTCOME: recovery verified — every applied action was re-validated against live graph state,
            and the verifier recomputed λ₂, components, routing and capacity from the engine.
          </div>
        )}
        {p.actions.map((a, i) => (
          <div className="step" key={i}>
            {i + 1}. {a.type}{a.edgeId ? `:${a.edgeId}` : ''}{a.nodeId ? `:${a.nodeId}` : ''}{a.toLatencyMs ? `→${a.toLatencyMs}ms` : ''}
            <div className="whisper">{actionGloss(a)}</div>
          </div>
        ))}
        {rec.ai?.parsed && (
          <div className="ai-quote">
            <div className="src">Nemotron-3 (real Token Factory call · confidence {rec.ai.parsed.confidence})</div>
            {rec.ai.parsed.root_cause_hypotheses.map((r, i) => <div key={i}>− {r}</div>)}
          </div>
        )}
      </div>
    </div>
  );
}

function actionGloss(a: { type: string; edgeId?: string; nodeId?: string; toLatencyMs?: number }): string {
  switch (a.type) {
    case 'RestoreEdge': return `re-activate failed link ${a.edgeId}`;
    case 'RestoreNode': return `bring node ${a.nodeId} back online (revives attached links)`;
    case 'OpenCandidate': return `activate approved spare corridor ${a.edgeId}`;
    case 'Retune': return `retune ${a.edgeId} latency to engineered floor ${a.toLatencyMs}ms`;
    default: return a.type;
  }
}

/* ---------------- AI panel ---------------- */

function AIPanel({ ai, enabled }: { ai: AIInfo | null; enabled: boolean }) {
  return (
    <div className="panel">
      <h3>Nemotron stage</h3>
      {!enabled && <div className="hint">API key absent — deterministic fallback in use; the AI failure is reported honestly.</div>}
      {enabled && ai && (
        <div>
          <div className="hint">
            mode <b style={{ color: ai.mode === 'real' ? 'var(--good)' : 'var(--warn)' }}>{ai.mode}</b>
            {' · '}{ai.latencyMs ?? '?'}ms · tokens {ai.promptTokens ?? '-'}/{ai.completionTokens ?? '-'}{ai.attempts ? ` · attempts ${ai.attempts}` : ''}
          </div>
          {ai.parsed && (
            <div className="ai-quote">
              <div className="src">incident_summary</div>
              <div style={{ fontSize: 12 }}>{ai.parsed.incident_summary}</div>
              <div className="src" style={{ marginTop: 6 }}>expected outcome</div>
              <div style={{ fontSize: 12 }}>{ai.parsed.expected_outcome}</div>
            </div>
          )}
          {ai.error && <div className="hint" style={{ color: 'var(--warn)' }}>last attempt: {ai.error}</div>}
        </div>
      )}
    </div>
  );
}

/* ---------------- timeline ---------------- */

function TimelinePanel({ events }: { events: TimelineEvent[] }) {
  return (
    <div className="panel" style={{ display: 'flex', flexDirection: 'column', minHeight: 180, flex: 1 }}>
      <h3>Incident timeline ({events.length})</h3>
      <div className="timeline">
        {events.length === 0 && <div className="hint">no events</div>}
        {events.map((e, i) => (
          <div className="tl-event" key={i}>
            <span className="tl-time">{new Date(e.at).toLocaleTimeString()}</span>
            <span className={`tl-stage ${e.stage.startsWith('ai') ? 'ai' : ''}`}>{e.stage}</span>
            <span className="tl-badge">{e.aiMode === 'real' && <em className="tl-badge real">[real]</em>}{e.aiMode === 'fallback' && <em className="tl-badge fallback">[fallback]</em>}</span>
            <span className="tl-msg">{e.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
