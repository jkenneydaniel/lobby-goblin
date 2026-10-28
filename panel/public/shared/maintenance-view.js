// Shared by the held web service and the already-open Updates screen. All copy
// and artwork are local, so maintenance needs no CDN, font or image request.
export function maintenanceView({updating = false, standalone = false} = {}) {
  const heading = standalone ? 'h1' : 'h3';
  return `<section class="goblin-maintenance${standalone ? '' : ' goblin-maintenance-inline'}" aria-labelledby="maintenance-title">
  <svg class="maintenance-goblin" viewBox="0 0 360 260" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg">
    <ellipse cx="180" cy="237" rx="118" ry="12" fill="#0a1e1a"/>
    <g class="maintenance-spark" fill="#eec67a"><path d="m66 63 4 10 10 4-10 4-4 10-4-10-10-4 10-4z"/><path d="m296 105 3 7 7 3-7 3-3 7-3-7-7-3 7-3z"/></g>
    <path d="M130 171q-22 21-24 59h135q-2-45-28-61" fill="#335a52" stroke="#142e28" stroke-width="5"/>
    <path d="M143 172v50m60-50v50" stroke="#e4b86e" stroke-width="13"/>
    <path d="m121 95-52-20q-5 44 53 58m112-38 50-20q5 44-53 58" fill="#8fba76" stroke="#243f30" stroke-width="5" stroke-linejoin="round"/>
    <path d="m89 92 29 17m145-17-29 17" stroke="#c7d49b" stroke-width="7" stroke-linecap="round"/>
    <path d="M115 97q0-51 63-51t62 51v26q0 56-63 57-62 0-62-57z" fill="#9fc580" stroke="#243f30" stroke-width="5"/>
    <path d="M113 92q0-55 65-55 42 0 60 43l-32-12-5 17-29-16-21 18-5-15z" fill="#355649" stroke="#243f30" stroke-width="5" stroke-linejoin="round"/>
    <path d="M148 119q7-9 14 0m39 0q7-9 14 0" fill="none" stroke="#243f30" stroke-width="5" stroke-linecap="round"/>
    <ellipse cx="138" cy="132" rx="11" ry="6" fill="#d7a384"/><ellipse cx="222" cy="132" rx="11" ry="6" fill="#d7a384"/>
    <path d="M162 141q17 18 35 0" fill="#314c36" stroke="#243f30" stroke-width="3" stroke-linecap="round"/><path d="m163 141 6 10 4-9m18 0 3 8 4-10" fill="#fff2cf"/>
    <path d="M148 177q28 14 57-1l-7 17-23-5-17 10z" fill="#e4b86e" stroke="#84693d" stroke-width="3"/>
    <g class="maintenance-tool"><path d="m254 155 14-52" stroke="#b4c8c4" stroke-width="13" stroke-linecap="round"/><path d="m264 108-13-16 4-16 9 14 12 3 7-8-2 16-12 10" fill="#b4c8c4" stroke="#58766f" stroke-width="3" stroke-linejoin="round"/>
    <path d="M219 189q23 2 35-28" fill="none" stroke="#9fc580" stroke-width="19" stroke-linecap="round"/><path d="m247 163 10-10" stroke="#243f30" stroke-width="3"/></g>
    <path d="m86 190 147 1 14 43H100z" fill="#213e37" stroke="#66857a" stroke-width="4" stroke-linejoin="round"/>
    <path d="M91 235h163" stroke="#9ab2a4" stroke-width="7" stroke-linecap="round"/>
    <path d="m159 207-7 5 7 5m23-10 7 5-7 5" fill="none" stroke="#e4b86e" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="m173 203-5 18" stroke="#e4b86e" stroke-width="3" stroke-linecap="round"/>
  </svg>
  <p class="maintenance-eyebrow">LOBBY GOBLIN</p>
  <${heading} id="maintenance-title">${updating ? 'A little upgrade magic.' : 'A little goblin upkeep.'}</${heading}>
  <p class="maintenance-description">${updating ? 'We’re updating your panel. It will reconnect automatically when it’s ready.' : 'Your panel is getting ready. We’ll bring you back as soon as maintenance is finished.'}</p>
  <p class="maintenance-connection" role="status"><span class="maintenance-pulse" aria-hidden="true"></span><span data-maintenance-status>${updating ? 'Updating Lobby Goblin…' : 'Waiting for your panel…'}</span></p>
  <p class="maintenance-reassurance">Panel updates leave your game servers and worlds alone.</p>
  </section>`;
}
