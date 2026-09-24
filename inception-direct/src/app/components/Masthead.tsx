import { store } from '../controller';
import { formatAgo } from '../format';
import { useStore } from '../store';
import { MercuryGlyph } from './Glyph';
import { BASE_HOST } from '../../platform/env';

const MODE = { direct: 'direct from this browser', bridge: 'through a site tab in this browser', web: 'from a web page' } as const;

/** Empty-state title page. Deliberately no canned prompts — only what you ask gets answered. */
export function Masthead() {
  const connection = useStore(store, (s) => s.connection);

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
        Every word is streamed live from <span className="nowrap">{BASE_HOST}</span> over your own connection, and typeset as it arrives.
      </p>
      <p className="masthead-colophon">
        {connection.status === 'live' ? (
          <>
            <span className="dot dot--ok" aria-hidden="true" /> Session live · {MODE[connection.mode]} · created {formatAgo(connection.fetchedAt)}
          </>
        ) : connection.status === 'connecting' ? (
          <>
            <span className="dot dot--wait" aria-hidden="true" /> {connection.message ?? 'Creating your session…'}
          </>
        ) : null}
      </p>
    </header>
  );
}
