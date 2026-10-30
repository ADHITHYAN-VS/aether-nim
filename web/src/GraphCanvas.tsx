import { useEffect, useRef } from 'react';
import cytoscape from 'cytoscape';
import type { ApiEdge, ApiNode } from './types.js';

interface Props {
  nodes: ApiNode[];
  edges: ApiEdge[];
  bridgeIds: string[];
  selected: { kind: 'node' | 'edge'; id: string } | null;
  onSelect: (sel: { kind: 'node' | 'edge'; id: string } | null) => void;
  flashEdgeIds?: string[];
}

export default function GraphCanvas({ nodes, edges, bridgeIds, selected, onSelect, flashEdgeIds }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);
  const onSelectLatest = useRef(onSelect);
  const flashRef = useRef<string[]>(flashEdgeIds ?? []);
  onSelectLatest.current = onSelect;
  flashRef.current = flashEdgeIds ?? [];

  useEffect(() => {
    const cy = cytoscape({
      container: ref.current,
      elements: [],
      // library typings are overly narrow for style values; cast once here
      style: [...cytoscapeStyles()] as unknown as cytoscape.CytoscapeOptions['style'],
      layout: { name: 'preset' },
      wheelSensitivity: 0.25,
    });
    cy.on('tap', 'node', (evt) => { const id = evt.target.id(); if (id != null) cySel({ kind: 'node', id: String(id) }); });
    cy.on('tap', 'edge', (evt) => { const id = evt.target.id(); if (id != null) cySel({ kind: 'edge', id: String(id) }); });
    cy.on('tap', (evt) => { if (evt.target === cy) cySel(null); });
    const cySel = (sel: { kind: 'node' | 'edge'; id: string } | null) => onSelectLatest.current(sel);
    cyRef.current = cy;
    return () => { cy.destroy(); cyRef.current = null; };
  }, []);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.batch(() => {
      cy.elements().remove();
      cy.add(nodes.map((n) => ({
        group: 'nodes',
        data: { id: n.id, label: n.label, role: n.role, state: n.state, score: n.tier ?? 2 },
        position: { x: n.x * 1000, y: n.y * 620 },
        locked: false,
      })));
      cy.add(edges.map((e) => ({
        group: 'edges',
        data: {
          id: e.id, source: e.a, target: e.b,
          label: `${e.id} · ${e.latencyMs}ms · ${e.capacityMbps}Mb`,
          state: e.state, kind: e.kind, openable: e.openable,
          bridge: bridgeIds.includes(e.id),
          selectedHit: false,
          flash: flashRef.current.includes(e.id),
        },
      })));
    });
  }, [nodes, edges, bridgeIds, flashEdgeIds]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.batch(() => {
      cy.nodes().forEach((n) => { n.data('selectedHit', selected?.kind === 'node' && selected.id === n.id()); });
      cy.edges().forEach((e) => { e.data('selectedHit', selected?.kind === 'edge' && selected.id === e.id()); });
    });
  }, [selected]);

  return <div ref={ref} className="graph-canvas" data-testid="graph-canvas" />;
}

interface StyleEntry {
  selector: string;
  style: Record<string, string | number>;
}

function cytoscapeStyles(): StyleEntry[] {
  return [
    {
      selector: 'node',
      style: {
        label: 'data(label)',
        'background-color': '#3b82f6',
        'border-width': 1, 'border-color': '#1d2836',
        color: '#d7e1ee',
        'font-size': 9, 'font-family': 'Menlo, monospace',
        'text-valign': 'bottom', 'text-halign': 'center',
        width: 'mapData(score, 0, 3, 14, 30)',
        height: 'mapData(score, 0, 3, 14, 30)',
        'text-margin-y': -4,
      },
    },
    { selector: 'node[state = "down"]', style: { 'background-color': '#ef4444', color: '#ef4444', 'border-color': '#ef4444', 'border-width': 2 } },
    { selector: 'node[selectedHit]', style: { 'border-color': '#22d3ee', 'border-width': 3 } },
    {
      selector: 'edge',
      style: {
        width: 2, 'line-color': '#2b3b50',
        label: 'data(label)',
        'font-size': 8, 'font-family': 'Menlo, monospace',
        color: '#5f7189',
        'text-background-color': '#0a0f16', 'text-background-opacity': 0.85, 'text-background-padding': 2,
        'curve-style': 'straight',
      },
    },
    { selector: 'edge[state = "down"]', style: { 'line-color': '#ef4444', 'line-style': 'dashed', color: '#ef4444' } },
    { selector: 'edge[kind = "candidate"]', style: { 'line-style': 'dotted', 'line-color': '#f59e0b', color: '#a06a0a' } },
    { selector: 'edge[kind = "candidate"][state = "up"]', style: { 'line-color': '#10b981', color: '#10b981', 'line-style': 'solid', width: 3 } },
    { selector: 'edge[bridge]', style: { 'line-color': '#f59e0b', width: 3, color: '#f59e0b' } },
    { selector: 'edge[selectedHit]', style: { 'line-color': '#22d3ee', width: 4, color: '#22d3ee' } },
    { selector: 'edge[flash]', style: { 'line-color': '#22d3ee', width: 5, color: '#22d3ee' } },
  ];
}
