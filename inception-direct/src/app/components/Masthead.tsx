import { currentModel, store } from '../controller';
import { useStore } from '../store';
import { MercuryGlyph } from './Glyph';

/** Empty-state title page. Deliberately no canned prompts — only what you ask gets answered. */
export function Masthead() {
  const connection = useStore(store, (s) => s.connection);
  const modelId = useStore(store, (s) => s.settings.model);
  useStore(store, (s) => s.models); // re-render when the live model list arrives
  const model = currentModel();

  return (
    <header className="masthead">
      <div className="masthead-glyph" aria-hidden="true">
        <MercuryGlyph size={34} accent="var(--accent)" stroke={1.4} />
      </div>
      <h1 className="masthead-title">Mercury</h1>
      <div className="masthead-rule" aria-hidden="true">
        <span />
        <i>◆</i>
        <span />
      </div>
      <p className="masthead-kicker">A diffusion language model by Inception</p>
      <p className="masthead-lede">
        Every word streams from Inception’s API straight to this page — no servers in between — and is typeset as it arrives.
      </p>
      <p className="masthead-colophon" data-model={modelId}>
        {connection.status === 'live' ? (
          <>
            <span className="dot dot--ok" aria-hidden="true" /> Live · {model.name}
            {connection.latencyMs ? ` · handshake ${connection.latencyMs} ms` : ''}
          </>
        ) : connection.status === 'connecting' ? (
          <>
            <span className="dot dot--wait" aria-hidden="true" /> Starting your session…
          </>
        ) : null}
      </p>
    </header>
  );
}
