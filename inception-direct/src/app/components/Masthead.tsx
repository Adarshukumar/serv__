import { store } from '../controller';
import { formatAgo } from '../format';
import { useStore } from '../store';
import { MercuryGlyph } from './Glyph';

/** Empty-state title page. Deliberately no canned prompts — only your questions. */
export function Masthead() {
  const connection = useStore(store, (s) => s.connection);

  return (
    <header className="masthead">
      <div className="masthead-glyph" aria-hidden="true">
        <MercuryGlyph size={34} accent="var(--accent)" stroke={1.4} />
      </div>
      <h1 className="masthead-title">Mercury</h1>
      <div className="masthead-rule" aria-hidden="true">
        <span /><i>◆</i><span />
      </div>
      <p className="masthead-kicker">A diffusion language model by Inception</p>
      <p className="masthead-lede">
        Real words from <span className="nowrap">chat.inceptionlabs.ai</span>, streamed through a dedicated browser on your own computer and typeset as they arrive.
      </p>
      <p className="masthead-colophon">
        {connection.status === 'live' ? (
          <><span className="dot dot--ok" aria-hidden="true" /> Session live · this computer · created {formatAgo(connection.fetchedAt)}</>
        ) : connection.status === 'connecting' ? (
          <><span className="dot dot--wait" aria-hidden="true" /> {connection.message ?? 'Opening the site browser…'}</>
        ) : null}
      </p>
    </header>
  );
}
