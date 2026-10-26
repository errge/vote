import { useEffect, useState } from 'preact/hooks';
import { Home } from './Home';
import { How } from './How';
import { PollPage } from './PollPage';

function currentRoute(): { name: 'home' } | { name: 'how' } | { name: 'poll'; fragment: string } {
  const h = location.hash;
  if (h.startsWith('#p=')) return { name: 'poll', fragment: h };
  if (h === '#/how') return { name: 'how' };
  return { name: 'home' };
}

export function App() {
  const [route, setRoute] = useState(currentRoute);
  useEffect(() => {
    const on = () => {
      setRoute(currentRoute());
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  return (
    <div class="shell">
      <header class="topbar">
        <a class="brand" href="#/">
          <span class="logo" aria-hidden="true">✓</span> Unanimous
        </a>
        <a class="toplink" href="#/how">How it works</a>
      </header>
      <main>
        {route.name === 'home' && <Home />}
        {route.name === 'how' && <How />}
        {route.name === 'poll' && <PollPage key={route.fragment} fragment={route.fragment} />}
      </main>
    </div>
  );
}
