// Progressive enhancement for the synthetic walkthrough. Plain JS, no frameworks, no network.
// The no-JS page already lists every step; this script adds a stepper over that same markup.
(() => {
  'use strict';

  const root = document.querySelector('[data-stepper]');
  const list = document.getElementById('step-list');
  if (!root || !list) return;

  const items = Array.from(list.querySelectorAll(':scope > li[data-step]'));
  if (items.length === 0) return;
  const last = items.length - 1;

  const $ = (sel) => root.querySelector(sel);
  const detail = $('#step-detail');
  const count = $('#step-count');
  const live = $('#live');
  const stage = $('.diagram'); // carries data-kind, which colours the stage and the outside box
  const token = $('[data-token]');
  const outside = $('[data-outside]');
  const ticketState = $('[data-ticket-state]');
  const ticketDecision = $('[data-ticket-decision]');
  const prevBtn = $('[data-action="prev"]');
  const nextBtn = $('[data-action="next"]');
  const playBtn = $('[data-action="play"]');
  const restartBtn = $('[data-action="restart"]');
  const playLabel = $('[data-play-label]');
  const playIcon = $('[data-play-icon]');
  const motionNote = $('#motion-note');
  const nodes = Array.from(root.querySelectorAll('.node'));
  const gotoButtons = Array.from(document.querySelectorAll('[data-goto]'));
  const allSteps = document.getElementById('all-steps');

  const INTERVAL_MS = 3500;
  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  let reduced = motionQuery.matches;
  let index = 0;
  let timer = null;

  const playing = () => timer !== null;

  function setDisabled(btn, off) {
    // aria-disabled keeps keyboard focus on the button when the end of the list is reached.
    btn.setAttribute('aria-disabled', off ? 'true' : 'false');
  }

  function renderPlay() {
    playLabel.textContent = playing() ? 'Pause' : 'Play';
    playIcon.textContent = playing() ? '❚❚' : '▶';
    playBtn.disabled = reduced;
    motionNote.hidden = !reduced;
    root.dataset.motion = reduced ? 'reduced' : 'full';
  }

  function stopPlayback() {
    if (timer !== null) { window.clearInterval(timer); timer = null; }
    renderPlay();
  }

  function announce(item, extra) {
    const parts = [`Step ${index + 1} of ${items.length}: ${item.dataset.title}.`, `Actor: ${item.dataset.actorName}.`, `Ticket state: ${item.dataset.state}.`];
    if (item.dataset.decision) parts.push(`Decision: ${item.dataset.decision}.`);
    if (item.dataset.gate) parts.push(`Gate: ${item.dataset.gate}.`);
    if (extra) parts.push(extra);
    live.textContent = parts.join(' ');
  }

  function show(i, options = {}) {
    index = Math.max(0, Math.min(last, i));
    const item = items[index];
    const kind = item.dataset.kind || 'flow';
    const atMerge = item.dataset.phase === 'human-merge';

    detail.replaceChildren(...Array.from(item.children, (child) => child.cloneNode(true)));
    count.textContent = `Step ${index + 1} of ${items.length}`;
    stage.dataset.kind = kind;
    ticketState.textContent = item.dataset.state;
    ticketDecision.textContent = item.dataset.decision || '';

    let slot = 0;
    for (const node of nodes) {
      const active = node.dataset.actor === item.dataset.actor;
      node.classList.toggle('is-active', active && !atMerge);
      if (active) slot = node.dataset.slot;
    }
    outside.classList.toggle('is-active', atMerge);
    token.className = `token ${atMerge ? 'slot-out' : `slot-${slot}`}`;

    for (const btn of gotoButtons) {
      if (btn.closest('.dots')) {
        if (btn.dataset.goto === item.dataset.step) btn.setAttribute('aria-current', 'step');
        else btn.removeAttribute('aria-current');
      }
    }
    setDisabled(prevBtn, index === 0);
    setDisabled(nextBtn, index === last);
    if (options.announce !== false) announce(item, options.extra);
  }

  function indexOfStep(id) {
    return items.findIndex((el) => el.dataset.step === id);
  }

  function play() {
    if (reduced || playing()) return;
    if (index >= last) show(0, { announce: false });
    timer = window.setInterval(() => {
      if (index >= last) { stopPlayback(); return; }
      show(index + 1);
      if (index >= last) { stopPlayback(); live.textContent += ' Playback finished.'; }
    }, INTERVAL_MS);
    renderPlay();
  }

  function applyMotionPreference() {
    reduced = motionQuery.matches;
    if (reduced) stopPlayback();
    renderPlay();
  }

  // Controls: real buttons, so Enter and Space work natively.
  prevBtn.addEventListener('click', () => { stopPlayback(); if (index > 0) show(index - 1); });
  nextBtn.addEventListener('click', () => { stopPlayback(); if (index < last) show(index + 1); });
  playBtn.addEventListener('click', () => { if (playing()) stopPlayback(); else play(); });
  restartBtn.addEventListener('click', () => { stopPlayback(); show(0); });
  for (const btn of gotoButtons) {
    btn.addEventListener('click', () => {
      const target = indexOfStep(btn.dataset.goto);
      if (target >= 0) { stopPlayback(); show(target); }
    });
  }

  // Links from the key moments open the step in the stepper and move focus to its details.
  for (const link of document.querySelectorAll('a[data-step]')) {
    link.addEventListener('click', (event) => {
      const target = indexOfStep(link.dataset.step);
      if (target < 0) return;
      event.preventDefault();
      stopPlayback();
      show(target);
      root.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
      detail.focus({ preventScroll: true });
    });
  }

  // Optional convenience: arrow keys inside the stepper. Never required.
  root.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === 'ArrowRight' && index < last) { event.preventDefault(); stopPlayback(); show(index + 1); }
    else if (event.key === 'ArrowLeft' && index > 0) { event.preventDefault(); stopPlayback(); show(index - 1); }
  });

  document.addEventListener('visibilitychange', () => { if (document.hidden) stopPlayback(); });
  if (typeof motionQuery.addEventListener === 'function') motionQuery.addEventListener('change', applyMotionPreference);
  else if (typeof motionQuery.addListener === 'function') motionQuery.addListener(applyMotionPreference);

  // Enhance: show the stepper and fold the full list (it stays in the page and is still readable).
  root.hidden = false;
  document.documentElement.classList.add('js');
  if (allSteps) allSteps.open = false;
  applyMotionPreference();
  show(0, { announce: false });
})();
