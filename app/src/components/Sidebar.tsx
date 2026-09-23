// ══════════════════════════════════════════════════════════════
//  Sidebar — the model catalogue, grouped BY PROVIDER
//
//  "as in model showing do handle it on the basis of providers — this provider
//  have these models use them, another and another"
//
//  A model can appear under several providers (23 of the 50 do). Capability and
//  context window are read from the SELECTED provider's slice of the record,
//  because capabilities are per-provider, not per-model.
// ══════════════════════════════════════════════════════════════
import { useMemo, useState } from 'react';
import type { ModelRecord, ProviderId } from '../types';
import { PROVIDERS, MOCK_MODELS } from '../data/providers';
import { MODELS } from '../data/models';

export interface Selection {
  provider: ProviderId;
  model: string;
  modelId: string;
}

interface Props {
  selection: Selection;
  onSelect: (sel: Selection) => void;
  bridgeUp: boolean | null;
  open: boolean;
  onClose: () => void;
}

function CapabilityDots({ m, provider }: { m: ModelRecord; provider: string }) {
  const caps = m.capabilities[provider] ?? {};
  const on = (k: keyof typeof caps, cls: string, title: string) =>
    caps[k] ? <span className={`cap-dot ${cls}`} title={title} /> : null;
  return (
    <span className="cap-dots">
      {on('reasoning', 'on-think', 'reasoning / thinking')}
      {on('search', 'on-search', 'web search')}
      {on('attachment', 'on-attach', 'attachments')}
    </span>
  );
}

export default function Sidebar({ selection, onSelect, bridgeUp, open, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const q = query.trim().toLowerCase();

  const groups = useMemo(() => {
    // The offline simulator is not in the registry; synthesise its entries so
    // every wire format stays reachable from the UI without network or creds.
    const mockGroup = {
      provider: PROVIDERS.find((p) => p.id === 'mock')!,
      models: MOCK_MODELS.filter(
        (mm) => !q || mm.display.toLowerCase().includes(q) || mm.wire.includes(q),
      ).map(
        (mm): ModelRecord => ({
            name: mm.name,
            display: mm.display,
            family: 'simulator',
            providers: ['mock'],
            connection: { mock: mm.wire },
            capabilities: { mock: { reasoning: true, search: true, attachment: false, vision: false } },
            working: { mock: true },
            maxTokens: { mock: null },
            description: mm.blurb,
        }),
      ),
    };

    return [...PROVIDERS.filter((p) => p.id !== 'mock').map((p) => {
      const models = MODELS.filter((m) => m.providers.includes(p.id)).filter((m) => {
        if (!q) return true;
        const id = m.connection[p.id] ?? '';
        return (
          m.name.toLowerCase().includes(q) ||
          m.display.toLowerCase().includes(q) ||
          m.family.toLowerCase().includes(q) ||
          id.toLowerCase().includes(q) ||
          (m.aliases ?? []).some((a) => a.toLowerCase().includes(q))
        );
      });
      return { provider: p, models };
    }), mockGroup].filter((g) => g.models.length > 0);
  }, [q]);

  const totals = useMemo(() => {
    const providers = new Set<string>();
    MODELS.forEach((m) => m.providers.forEach((p) => providers.add(p)));
    return { models: MODELS.length, providers: providers.size };
  }, []);

  const pick = (provider: ProviderId, m: ModelRecord) => {
    onSelect({ provider, model: m.name, modelId: m.connection[provider] ?? m.name });
    onClose();
  };

  return (
    <aside className={`sidebar${open ? ' open' : ''}`}>
      <div className="brand">
        <h1><span className="dot" />Aduskills Chat</h1>
        <p>
          {totals.models} models · {totals.providers} providers · local egress bridge
        </p>
      </div>

      <div className="search-wrap">
        <input
          className="search"
          placeholder="Search models, families, ids…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
        />
      </div>

      <div className="model-list">
        {groups.map(({ provider, models }) => {
          const isCollapsed = q ? false : Boolean(collapsed[provider.id]);
          return (
            <div className="prov-group" key={provider.id}>
              <button
                className="prov-head"
                onClick={() => setCollapsed((c) => ({ ...c, [provider.id]: !c[provider.id] }))}
                title={provider.blurb}
              >
                <span className={`prov-chev${isCollapsed ? '' : ' open'}`}>▶</span>
                <span className="prov-swatch" style={{ background: provider.accent }} />
                {provider.label}
                <span className="prov-count">{models.length}</span>
              </button>

              {!isCollapsed &&
                models.map((m) => {
                  const active = selection.provider === provider.id && selection.model === m.name;
                  const working = m.working[provider.id] !== false;
                  return (
                    <button
                      key={`${provider.id}:${m.name}`}
                      className={`model-item${active ? ' active' : ''}${working ? '' : ' off'}`}
                      onClick={() => pick(provider.id, m)}
                      title={
                        [
                          m.display,
                          `id: ${m.connection[provider.id] ?? '?'}`,
                          m.description ?? '',
                          (() => {
                            const ctx = m.maxTokens[provider.id];
                            return ctx ? `context: ${ctx.toLocaleString()}` : 'context: unknown';
                          })(),
                          m.tag ? `route: ${m.tag}` : '',
                          m.provenance ?? '',
                        ]
                          .filter(Boolean)
                          .join('\n')
                      }
                    >
                      <span className="name">{m.display}</span>
                      <CapabilityDots m={m} provider={provider.id} />
                    </button>
                  );
                })}
            </div>
          );
        })}

        {!groups.length && (
          <div style={{ padding: '20px 12px', color: 'var(--text-faint)', fontSize: 12.5 }}>
            No model matches “{query}”.
          </div>
        )}
      </div>

      <div className="side-foot">
        <span className={`bridge-pill${bridgeUp === null ? '' : bridgeUp ? ' up' : ' down'}`}>
          <span className="led" />
          {bridgeUp === null ? 'checking bridge…' : bridgeUp ? 'bridge online' : 'bridge offline'}
        </span>
        <span>
          DevsDo removed · Upstage v3 · {totals.models - 32} registry + 18 DeepInfra
        </span>
      </div>
    </aside>
  );
}
