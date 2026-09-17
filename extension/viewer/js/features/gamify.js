/**
 * Gamified learning & collaboration: XP, levels, badges, progress tracking and
 * group challenges. Solo progress is stored locally; inside a shared room the
 * server keeps the authoritative team leaderboard (backend/app/collab/rooms.py).
 */
import { getProgress, saveProgress } from '../lib/storage.js';
import { el, modal } from './shared.js';

const POINTS = { node_added: 5, node_edited: 2, note_added: 3, link_added: 3, node_explored: 1, flashcard_correct: 2, quiz_correct: 4, ai_refine: 2, map_merged: 5 };

export const BADGES = [
  { id: 'first-steps', title: 'First Steps', emoji: '🌱', desc: 'Earn your first point', test: (s) => s.points >= 1 },
  { id: 'explorer', title: 'Explorer', emoji: '🧭', desc: 'Explore 25 nodes', test: (s) => s.node_explored >= 25 },
  { id: 'scribe', title: 'Scribe', emoji: '✍️', desc: 'Write 10 notes', test: (s) => s.note_added >= 10 },
  { id: 'architect', title: 'Architect', emoji: '🏗️', desc: 'Add or edit 20 nodes', test: (s) => s.node_added + s.node_edited >= 20 },
  { id: 'curator', title: 'Curator', emoji: '🔗', desc: 'Attach 5 links', test: (s) => s.link_added >= 5 },
  { id: 'quiz-whiz', title: 'Quiz Whiz', emoji: '🏆', desc: '10 correct quiz answers', test: (s) => s.quiz_correct >= 10 },
  { id: 'memory-master', title: 'Memory Master', emoji: '🧠', desc: '25 flashcards remembered', test: (s) => s.flashcard_correct >= 25 },
  { id: 'team-player', title: 'Team Player', emoji: '🤝', desc: 'Study in a shared room', test: (s) => s.team >= 1 },
];

const EMPTY = { points: 0, badges: [], node_added: 0, node_edited: 0, note_added: 0, link_added: 0, node_explored: 0, flashcard_correct: 0, quiz_correct: 0, ai_refine: 0, map_merged: 0, team: 0 };

export class Gamify extends EventTarget {
  constructor({ model, renderer, hud }) {
    super();
    Object.assign(this, { model, renderer, hud });
    this.collab = null;
    this.stats = { ...EMPTY };
    this.ready = chrome.storage.local.get('tm-gamify').then((r) => {
      this.stats = { ...EMPTY, ...(r['tm-gamify'] || {}) };
      this.renderHud();
    });
    renderer.addEventListener('select', (e) => e.detail.ids.forEach((id) => this.explore(id)));
    renderer.addEventListener('toggle', (e) => this.explore(e.detail.node.id));
    model.addEventListener('load', () => this.#loadMapProgress());
  }

  attachCollab(collab) {
    this.collab = collab;
    collab.addEventListener('leaderboard', () => this.renderHud());
    collab.addEventListener('status', (e) => e.detail.status === 'online' && this.track('team'));
  }

  async #loadMapProgress() {
    this.progress = await getProgress(this.model.map.id);
    this.renderHud();
  }

  async explore(id) {
    if (!this.progress || this.progress.explored.includes(id)) return;
    this.progress.explored.push(id);
    await saveProgress(this.progress);
    this.track('node_explored', id);
  }

  async track(event, detail) {
    await this.ready;
    if (event === 'team') this.stats.team = 1;
    else if (POINTS[event]) {
      this.stats[event] = (this.stats[event] || 0) + 1;
      this.stats.points += POINTS[event];
    }
    const fresh = BADGES.filter((b) => !this.stats.badges.includes(b.id) && b.test(this.stats));
    for (const badge of fresh) {
      this.stats.badges.push(badge.id);
      this.dispatchEvent(new CustomEvent('badge', { detail: badge }));
    }
    chrome.storage.local.set({ 'tm-gamify': this.stats });
    // Team scoring: the server counts edit ops itself; forward learning events only.
    if (this.collab?.status === 'online' && ['node_explored', 'flashcard_correct', 'quiz_correct', 'ai_refine'].includes(event)) {
      this.collab.sendEvent(event, detail);
    }
    this.renderHud();
  }

  get level() {
    return Math.floor(Math.sqrt(this.stats.points / 10)) + 1;
  }

  renderHud() {
    if (!this.hud || !this.model.map) return;
    const total = this.model.nodes().length;
    const explored = this.progress?.explored.filter((id) => this.model.get(id)).length || 0;
    const pct = Math.round((explored / Math.max(total, 1)) * 100);
    const nextLevelPts = 10 * this.level ** 2;
    const prevLevelPts = 10 * (this.level - 1) ** 2;
    const lvlPct = Math.round(((this.stats.points - prevLevelPts) / Math.max(nextLevelPts - prevLevelPts, 1)) * 100);
    this.hud.replaceChildren(
      el('button', { class: 'hud-card', title: 'Progress, badges & challenges', onclick: () => this.openBoard() }, [
        el('div', { class: 'hud-line' }, [el('strong', {}, `Lv ${this.level}`), el('span', {}, `${this.stats.points} XP`), el('span', { class: 'hud-badges' }, this.stats.badges.slice(-4).map((id) => BADGES.find((b) => b.id === id)?.emoji).join(''))]),
        el('div', { class: 'sketch-bar thin', title: 'Level progress' }, el('span', { style: `width:${lvlPct}%` })),
        el('div', { class: 'hud-line small' }, [el('span', {}, `Explored ${pct}%`)]),
        el('div', { class: 'sketch-bar thin accent', title: 'Map explored' }, el('span', { style: `width:${pct}%` })),
      ]),
    );
  }

  openBoard() {
    const { body } = modal('🏅 Progress & challenges', { wide: true });
    const board = this.collab?.leaderboard;
    body.append(
      el('div', { class: 'progress-grid' }, [
        el('div', { class: 'stat' }, [el('div', { class: 'stat-value' }, `Level ${this.level}`), el('div', { class: 'stat-label' }, `${this.stats.points} XP total`)]),
        el('div', { class: 'stat' }, [el('div', { class: 'stat-value' }, String(this.stats.badges.length)), el('div', { class: 'stat-label' }, `of ${BADGES.length} badges`)]),
        el('div', { class: 'stat' }, [el('div', { class: 'stat-value' }, String(this.progress?.explored.length || 0)), el('div', { class: 'stat-label' }, 'nodes explored in this map')]),
      ]),
      el('h4', {}, 'Badges'),
      el(
        'div',
        { class: 'badge-grid' },
        BADGES.map((b) => el('div', { class: `badge ${this.stats.badges.includes(b.id) ? 'earned' : ''}`, title: b.desc }, [el('span', { class: 'badge-emoji' }, b.emoji), el('strong', {}, b.title), el('small', {}, b.desc)])),
      ),
    );
    if (board) {
      body.append(
        el('h4', {}, `Room ${this.collab.roomId} — team challenges`),
        ...board.challenges.map((c) =>
          el('div', { class: 'challenge' }, [el('span', {}, c.title), el('div', { class: 'sketch-bar' }, el('span', { style: `width:${Math.round((c.progress / Math.max(c.goal, 1)) * 100)}%` })), el('small', {}, `${c.progress}/${c.goal}`)]),
        ),
        el('h4', {}, 'Leaderboard'),
        el(
          'ol',
          { class: 'leaderboard' },
          board.entries.map((e) => el('li', { class: e.userId === this.collab.settings.userId ? 'me' : '' }, [el('span', {}, e.name), el('span', {}, `${e.points} XP`), el('span', {}, e.badges.map((id) => BADGES.find((b) => b.id === id)?.emoji || '').join(''))])),
        ),
      );
    } else {
      body.append(el('p', { class: 'hint' }, '👥 Share this map to unlock team challenges and a live leaderboard.'));
    }
  }
}
